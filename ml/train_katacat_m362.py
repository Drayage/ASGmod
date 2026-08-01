from __future__ import annotations

import argparse
import copy
import json
import math
import os
from pathlib import Path
from typing import Any

import torch
from torch import nn
from torch.utils.data import DataLoader, WeightedRandomSampler

from katacat_m36_adapter import KataCatM36Model, load_m36_checkpoint
from train_katacat_m1 import KataCatNet, choose_device, ownership_class_weights, seed_everything
from train_katacat_m33 import balance_real_seats, tagged_samples, unique_samples
from train_katacat_m341 import (
    M341Dataset,
    balance_hard_train,
    evaluate_general,
    evaluate_tactical,
    finite_general,
    pairwise_components,
    per_sample_policy_loss,
    sha256_file,
    tactical_regression_failures,
)
from train_katacat_m36 import (
    base_to_candidate_kl,
    clone_state,
    evaluate_general_adapter,
    negative_mass_loss,
    state_dict_sha256,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="M3.6.2 targeted repair of the promising M3.6 epoch-8 residual adapter."
    )
    parser.add_argument("--bootstrap-data", required=True)
    parser.add_argument("--selfplay-data", required=True)
    parser.add_argument("--mixed-data", required=True)
    parser.add_argument("--curriculum-data", required=True)
    parser.add_argument("--hard-negative-data", required=True)
    parser.add_argument("--base-checkpoint", required=True)
    parser.add_argument("--seed-adapter-checkpoint", required=True)
    parser.add_argument("--regression-diagnostic", required=True)
    parser.add_argument("--out", default="katacat-m362-model")
    parser.add_argument("--epochs", type=int, default=10)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--learning-rate", type=float, default=7.5e-5)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--pairwise-weight", type=float, default=1.5)
    parser.add_argument("--pairwise-margin", type=float, default=0.5)
    parser.add_argument("--negative-mass-weight", type=float, default=0.35)
    parser.add_argument("--general-kl-weight", type=float, default=6.0)
    parser.add_argument("--general-residual-weight", type=float, default=1.5)
    parser.add_argument("--replay-policy-weight", type=float, default=0.20)
    parser.add_argument("--hard-sampling-multiplier", type=float, default=5.0)
    parser.add_argument("--guard-pairwise-weight", type=float, default=6.0)
    parser.add_argument("--guard-negative-mass-weight", type=float, default=1.0)
    parser.add_argument("--guard-positive-floor-weight", type=float, default=8.0)
    parser.add_argument("--guard-negative-ceiling-weight", type=float, default=8.0)
    parser.add_argument("--guard-positive-floor-tolerance", type=float, default=0.05)
    parser.add_argument("--guard-negative-ceiling-tolerance", type=float, default=0.05)
    parser.add_argument("--guard-margin-tolerance", type=float, default=0.01)
    parser.add_argument("--general-policy-loss-tolerance", type=float, default=0.015)
    parser.add_argument("--policy-top1-tolerance", type=float, default=0.005)
    parser.add_argument("--general-kl-maximum", type=float, default=0.012)
    parser.add_argument("--general-mean-delta-maximum", type=float, default=0.15)
    parser.add_argument("--tactical-margin-min-delta", type=float, default=0.01)
    parser.add_argument("--tactical-pairwise-min-delta", type=float, default=0.01)
    parser.add_argument("--value-weight", type=float, default=1.0)
    parser.add_argument("--score-weight", type=float, default=0.25)
    parser.add_argument("--ownership-weight", type=float, default=1.0)
    parser.add_argument("--seed", type=int, default=20260801)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--augment", choices=("on", "off"), default="on")
    parser.add_argument(
        "--commit-sha",
        default=os.environ.get("KATACAT_M362_COMMIT_SHA", "unknown"),
    )
    return parser.parse_args()


def save_checkpoint(
    path: Path,
    base_checkpoint: dict[str, Any],
    adapter_state: dict[str, torch.Tensor],
    seed_checkpoint: dict[str, Any],
    args: argparse.Namespace,
    epoch: int,
    improved: bool,
) -> None:
    torch.save(
        {
            "schemaVersion": 1,
            "stage": "M3.6.2_TARGETED_RESIDUAL_POLICY_ADAPTER",
            "encodingVersion": "PLAYER_RELATIVE_V1",
            "channels": int(base_checkpoint["channels"]),
            "blocks": int(base_checkpoint["blocks"]),
            "baseModelState": base_checkpoint["modelState"],
            "adapterState": adapter_state,
            "adapterChannels": int(seed_checkpoint["adapterChannels"]),
            "maxAbsDelta": float(seed_checkpoint["maxAbsDelta"]),
            "selectedEpoch": int(epoch),
            "improvedOverParent": bool(improved),
            "seedStage": str(seed_checkpoint.get("stage")),
            "seedSelectedEpoch": int(seed_checkpoint.get("selectedEpoch", 8)),
            "baseCheckpointSha256": sha256_file(Path(args.base_checkpoint)),
            "seedAdapterCheckpointSha256": sha256_file(Path(args.seed_adapter_checkpoint)),
            "commitSha": args.commit_sha,
        },
        path,
    )


def resolve_guard_rows(
    hard_samples: list[dict[str, Any]], diagnostic_path: Path
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    diagnostic = json.loads(diagnostic_path.read_text(encoding="utf-8"))
    positions = diagnostic.get("repeatedRegressionPositions")
    if not isinstance(positions, list) or len(positions) < 3:
        raise ValueError("M3.6.2 requires at least three repeated regression positions")
    requested = positions[:3]
    by_id = {str(row["sampleId"]): row for row in hard_samples}
    rows: list[dict[str, Any]] = []
    for item in requested:
        sample_id = str(item["sampleId"])
        row = by_id.get(sample_id)
        if row is None:
            raise ValueError(f"Targeted regression sample not found: {sample_id}")
        if str(row.get("positionHash")) != str(item.get("positionHash")):
            raise ValueError(f"Position hash mismatch for targeted regression: {sample_id}")
        rows.append(row)
    return rows, diagnostic


def targeted_guard_losses(
    model: KataCatM36Model,
    batch: tuple[torch.Tensor, ...],
    device: torch.device,
    args: argparse.Namespace,
) -> dict[str, torch.Tensor]:
    features = batch[0].to(device)
    hard_flags = batch[5].to(device)
    positive_actions = batch[6].to(device)
    negative_masks = batch[7].to(device)
    corrected, base_logits, _delta = model.policy_outputs(features)
    pair_loss, _margins, _positive, _negative = pairwise_components(
        corrected,
        hard_flags,
        positive_actions,
        negative_masks,
        args.pairwise_margin,
    )
    mass_loss = negative_mass_loss(
        corrected,
        hard_flags,
        positive_actions,
        negative_masks,
        args.pairwise_margin,
    )
    positive_corrected = corrected.gather(1, positive_actions.unsqueeze(1)).squeeze(1)
    positive_base = base_logits.gather(1, positive_actions.unsqueeze(1)).squeeze(1)
    positive_floor_loss = nn.functional.relu(
        positive_base - args.guard_positive_floor_tolerance - positive_corrected
    ).pow(2).mean()
    negative_delta = (corrected - base_logits).masked_select(negative_masks)
    negative_ceiling_loss = (
        nn.functional.relu(
            negative_delta - args.guard_negative_ceiling_tolerance
        ).pow(2).mean()
        if negative_delta.numel() > 0
        else corrected.sum() * 0.0
    )
    return {
        "pairwise": pair_loss,
        "negativeMass": mass_loss,
        "positiveFloor": positive_floor_loss,
        "negativeCeiling": negative_ceiling_loss,
    }


@torch.no_grad()
def evaluate_guard(
    model: KataCatM36Model,
    dataset: M341Dataset,
    device: torch.device,
    parent_rows: list[dict[str, Any]] | None = None,
    args: argparse.Namespace | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    model.eval()
    loader = DataLoader(dataset, batch_size=len(dataset), shuffle=False, num_workers=0)
    batch = next(iter(loader))
    features = batch[0].to(device)
    positive_actions = batch[6].to(device)
    negative_masks = batch[7].to(device)
    corrected, base_logits, delta = model.policy_outputs(features)
    predictions = corrected.argmax(dim=1)
    rows: list[dict[str, Any]] = []
    for index, sample in enumerate(dataset.samples):
        positive = int(positive_actions[index].item())
        negative_mask = negative_masks[index]
        negative_indices = negative_mask.nonzero(as_tuple=False).flatten().to(device)
        negative_logits = corrected[index, negative_indices]
        best_offset = int(negative_logits.argmax().item())
        best_negative = int(negative_indices[best_offset].item())
        positive_logit = float(corrected[index, positive].item())
        best_negative_logit = float(corrected[index, best_negative].item())
        rows.append(
            {
                "sampleId": str(sample["sampleId"]),
                "gameId": str(sample["gameId"]),
                "positionHash": str(sample.get("positionHash", "")),
                "margin": positive_logit - best_negative_logit,
                "positiveTop1": int(predictions[index].item()) == positive,
                "negativeTop1": bool(negative_mask[int(predictions[index].item())].item()),
                "positiveAction": positive,
                "topAction": int(predictions[index].item()),
                "bestNegativeAction": best_negative,
                "positiveResidual": float(delta[index, positive].item()),
                "bestNegativeResidual": float(delta[index, best_negative].item()),
                "maximumNegativeResidual": float(delta[index].masked_select(negative_mask.to(device)).max().item()),
                "meanAbsLegalResidual": float(delta[index].abs().mean().item()),
            }
        )
    margins = [float(row["margin"]) for row in rows]
    metrics: dict[str, Any] = {
        "examples": len(rows),
        "negativeTop1Count": sum(bool(row["negativeTop1"]) for row in rows),
        "positiveTop1Count": sum(bool(row["positiveTop1"]) for row in rows),
        "meanMargin": sum(margins) / len(margins),
        "minimumMargin": min(margins),
        "minimumPositiveResidual": min(float(row["positiveResidual"]) for row in rows),
        "maximumNegativeResidual": max(float(row["maximumNegativeResidual"]) for row in rows),
    }
    if parent_rows is not None:
        parent = {str(row["sampleId"]): row for row in parent_rows}
        margin_deltas = [
            float(row["margin"]) - float(parent[str(row["sampleId"])]["margin"])
            for row in rows
        ]
        failures, failure_details = tactical_regression_failures(parent_rows, rows)
        metrics.update(
            {
                "regressionFailuresVsParent": failures,
                "regressionFailureDetails": failure_details,
                "minimumMarginDeltaVsParent": min(margin_deltas),
                "meanMarginDeltaVsParent": sum(margin_deltas) / len(margin_deltas),
            }
        )
        if args is not None:
            metrics["checks"] = {
                "noNegativeTop1": metrics["negativeTop1Count"] == 0,
                "noParentRegression": failures == 0,
                "positiveFloorHeld": metrics["minimumPositiveResidual"]
                >= -args.guard_positive_floor_tolerance - 1e-6,
                "negativeCeilingHeld": metrics["maximumNegativeResidual"]
                <= args.guard_negative_ceiling_tolerance + 1e-6,
                "marginNotWorseThanParent": metrics["minimumMarginDeltaVsParent"]
                >= -args.guard_margin_tolerance - 1e-6,
            }
            metrics["passed"] = all(metrics["checks"].values())
    return metrics, rows


def candidate_rank(
    guard: dict[str, Any],
    tactical: dict[str, float],
    general: dict[str, float],
) -> tuple[float, float, float, float, float, float]:
    return (
        -float(guard["minimumMarginDeltaVsParent"]),
        float(tactical["negativeTop1Rate"]),
        float(tactical["pairwiseLoss"]),
        -float(tactical["meanMargin"]),
        float(general["baseToCandidateKl"]),
        float(general["policyLoss"]),
    )


def main() -> None:
    args = parse_args()
    seed_everything(args.seed)

    replay_sources = {
        "bootstrap": tagged_samples("bootstrap", args.bootstrap_data),
        "selfplay": tagged_samples("selfplay", args.selfplay_data),
        "mixed": tagged_samples("mixed", args.mixed_data),
        "curriculum": tagged_samples("curriculum", args.curriculum_data),
    }
    hard_samples = tagged_samples("hardNegative", args.hard_negative_data)
    guard_rows, diagnostic = resolve_guard_rows(
        hard_samples, Path(args.regression_diagnostic)
    )
    guard_ids = {str(row["sampleId"]) for row in guard_rows}
    guard_game_ids = {str(row["gameId"]) for row in guard_rows}

    replay_originals = unique_samples([row for rows in replay_sources.values() for row in rows])
    replay_balanced, replay_balance = balance_real_seats(replay_originals, args.seed)
    hard_train, hard_validation, hard_balance = balance_hard_train(
        unique_samples(hard_samples), args.seed + 1
    )
    replay_train = [row for row in replay_balanced if row["split"] == "train"]
    general_validation = [row for row in replay_balanced if row["split"] == "validation"]
    untouched_tactical_validation = [
        row for row in hard_validation if str(row["gameId"]) not in guard_game_ids
    ]
    excluded_same_game_validation = [
        row for row in hard_validation if str(row["gameId"]) in guard_game_ids
    ]
    train_samples = unique_samples([*replay_train, *hard_train])
    if not train_samples or not general_validation or not untouched_tactical_validation:
        raise ValueError("M3.6.2 requires train, general, and untouched tactical validation")
    if len(guard_rows) != 3 or len(guard_ids) != 3:
        raise ValueError("M3.6.2 requires exactly three unique targeted regression fixtures")

    regular_train_games = {str(row["gameId"]) for row in train_samples}
    general_games = {str(row["gameId"]) for row in general_validation}
    untouched_games = {str(row["gameId"]) for row in untouched_tactical_validation}
    if regular_train_games.intersection(general_games):
        raise ValueError("M3.6.2 general validation game leakage")
    if regular_train_games.intersection(untouched_games):
        raise ValueError("M3.6.2 untouched tactical validation game leakage")
    if guard_game_ids.intersection(untouched_games):
        raise ValueError("M3.6.2 guard game leakage into untouched tactical validation")

    device = choose_device(args.device)
    base_path = Path(args.base_checkpoint)
    base_checkpoint = torch.load(base_path, map_location="cpu")
    if base_checkpoint.get("encodingVersion") != "PLAYER_RELATIVE_V1":
        raise ValueError("M3.6.2 requires PLAYER_RELATIVE_V1 base checkpoint")

    loaded_seed = load_m36_checkpoint(Path(args.seed_adapter_checkpoint), device=device)
    seed_checkpoint = loaded_seed.checkpoint
    if int(seed_checkpoint.get("selectedEpoch", -1)) != 8:
        raise ValueError("M3.6.2 must initialize from the M3.6 epoch-8 adapter")
    model = loaded_seed.model
    model.base.eval()

    parent_base = KataCatNet(int(base_checkpoint["channels"]), int(base_checkpoint["blocks"]))
    parent_base.load_state_dict(base_checkpoint["modelState"])
    parent_model = KataCatM36Model(
        parent_base,
        adapter_channels=int(seed_checkpoint["adapterChannels"]),
        max_abs_delta=float(seed_checkpoint["maxAbsDelta"]),
    ).to(device)
    parent_model.eval()
    for parameter in parent_model.parameters():
        parameter.requires_grad = False

    base_state_sha = state_dict_sha256(parent_model.base.state_dict())
    if state_dict_sha256(model.base.state_dict()) != base_state_sha:
        raise ValueError("M3.6.2 seed adapter does not contain the requested M3.4.1 base")
    seed_adapter_state = clone_state(model.adapter)

    train_dataset = M341Dataset(train_samples, augment=args.augment == "on")
    general_dataset = M341Dataset(general_validation, augment=False)
    untouched_dataset = M341Dataset(untouched_tactical_validation, augment=False)
    guard_dataset = M341Dataset(guard_rows, augment=False)
    general_loader = DataLoader(
        general_dataset, batch_size=args.batch_size, shuffle=False, num_workers=0
    )
    guard_batch = next(
        iter(DataLoader(guard_dataset, batch_size=len(guard_dataset), shuffle=False, num_workers=0))
    )
    ownership_loss = nn.CrossEntropyLoss(
        weight=ownership_class_weights(train_dataset, device)
    )

    sample_weights = torch.tensor(
        [
            args.hard_sampling_multiplier
            if row.get("trainingSource") == "hardNegative"
            else 1.0
            for row in train_samples
        ],
        dtype=torch.double,
    )
    generator = torch.Generator().manual_seed(args.seed)
    sampler = WeightedRandomSampler(
        sample_weights,
        num_samples=max(len(train_samples), 2 * len(replay_train)),
        replacement=True,
        generator=generator,
    )
    train_loader = DataLoader(
        train_dataset,
        batch_size=args.batch_size,
        sampler=sampler,
        num_workers=0,
        pin_memory=device.type == "cuda",
    )

    parent_general_full = evaluate_general(
        parent_model, general_loader, device, ownership_loss, args
    )
    parent_general_adapter = evaluate_general_adapter(parent_model, general_loader, device)
    parent_tactical, parent_tactical_rows = evaluate_tactical(
        parent_model, untouched_dataset, device, args
    )
    parent_guard, parent_guard_rows = evaluate_guard(parent_model, guard_dataset, device)

    seed_general_adapter = evaluate_general_adapter(model, general_loader, device)
    seed_tactical, seed_tactical_rows = evaluate_tactical(model, untouched_dataset, device, args)
    seed_failures, seed_failure_details = tactical_regression_failures(
        parent_tactical_rows, seed_tactical_rows
    )
    seed_guard, seed_guard_rows = evaluate_guard(
        model, guard_dataset, device, parent_guard_rows, args
    )

    optimizer = torch.optim.AdamW(
        model.adapter.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, T_max=max(1, args.epochs)
    )

    output_dir = Path(args.out)
    epoch_dir = output_dir / "epochs"
    epoch_dir.mkdir(parents=True, exist_ok=True)
    parent_adapter_state = clone_state(parent_model.adapter)
    save_checkpoint(
        epoch_dir / "epoch-000.pt",
        base_checkpoint,
        parent_adapter_state,
        seed_checkpoint,
        args,
        epoch=0,
        improved=False,
    )
    save_checkpoint(
        epoch_dir / "seed-epoch-008.pt",
        base_checkpoint,
        seed_adapter_state,
        seed_checkpoint,
        args,
        epoch=8,
        improved=False,
    )

    selected_epoch = 0
    selected_adapter_state = copy.deepcopy(parent_adapter_state)
    selected_general_full = copy.deepcopy(parent_general_full)
    selected_general_adapter = copy.deepcopy(parent_general_adapter)
    selected_tactical = copy.deepcopy(parent_tactical)
    selected_tactical_failures: list[dict[str, Any]] = []
    selected_guard = copy.deepcopy(parent_guard)
    selected_guard_rows = copy.deepcopy(parent_guard_rows)
    selected_rank: tuple[float, ...] | None = None
    history: list[dict[str, Any]] = [
        {
            "epoch": 0,
            "source": "zero_adapter_parent_behavior",
            "generalValidation": parent_general_full,
            "adapterValidation": parent_general_adapter,
            "untouchedTacticalValidation": {
                **parent_tactical,
                "regressionFailuresVsParent": 0,
            },
            "targetedRegressionFixtures": {**parent_guard, "rows": parent_guard_rows, "passed": True},
            "eligible": True,
            "selected": True,
        },
        {
            "epoch": 8,
            "source": "m36_promising_seed_not_selectable_due_known_regressions",
            "adapterValidation": seed_general_adapter,
            "untouchedTacticalValidation": {
                **seed_tactical,
                "regressionFailuresVsParent": seed_failures,
                "regressionFailureDetails": seed_failure_details,
            },
            "targetedRegressionFixtures": {**seed_guard, "rows": seed_guard_rows},
            "eligible": False,
            "selected": False,
        },
    ]

    for epoch in range(1, args.epochs + 1):
        model.base.eval()
        model.adapter.train()
        totals = {
            "loss": 0.0,
            "replayPolicy": 0.0,
            "pairwise": 0.0,
            "negativeMass": 0.0,
            "generalKl": 0.0,
            "generalResidual": 0.0,
            "guardPairwise": 0.0,
            "guardNegativeMass": 0.0,
            "guardPositiveFloor": 0.0,
            "guardNegativeCeiling": 0.0,
        }
        seen = 0
        for batch in train_loader:
            features = batch[0].to(device)
            policy = batch[1].to(device)
            hard_flags = batch[5].to(device)
            positive_actions = batch[6].to(device)
            negative_masks = batch[7].to(device)
            optimizer.zero_grad(set_to_none=True)
            corrected, base_logits, delta = model.policy_outputs(features)
            replay_mask = hard_flags <= 0.5
            per_row_policy = per_sample_policy_loss(corrected, policy)
            replay_policy = (
                per_row_policy[replay_mask].mean()
                if bool(replay_mask.any())
                else corrected.sum() * 0.0
            )
            pair_loss, _margins, _positive, _negative = pairwise_components(
                corrected, hard_flags, positive_actions, negative_masks, args.pairwise_margin
            )
            mass_loss = negative_mass_loss(
                corrected, hard_flags, positive_actions, negative_masks, args.pairwise_margin
            )
            kl_loss = base_to_candidate_kl(base_logits, corrected, replay_mask)
            residual_loss = (
                delta[replay_mask].pow(2).mean()
                if bool(replay_mask.any())
                else delta.sum() * 0.0
            )
            guard_losses = targeted_guard_losses(model, guard_batch, device, args)
            loss = (
                args.replay_policy_weight * replay_policy
                + args.pairwise_weight * pair_loss
                + args.negative_mass_weight * mass_loss
                + args.general_kl_weight * kl_loss
                + args.general_residual_weight * residual_loss
                + args.guard_pairwise_weight * guard_losses["pairwise"]
                + args.guard_negative_mass_weight * guard_losses["negativeMass"]
                + args.guard_positive_floor_weight * guard_losses["positiveFloor"]
                + args.guard_negative_ceiling_weight * guard_losses["negativeCeiling"]
            )
            loss.backward()
            nn.utils.clip_grad_norm_(model.adapter.parameters(), max_norm=1.5)
            optimizer.step()
            batch_size = features.shape[0]
            seen += batch_size
            values = {
                "loss": loss,
                "replayPolicy": replay_policy,
                "pairwise": pair_loss,
                "negativeMass": mass_loss,
                "generalKl": kl_loss,
                "generalResidual": residual_loss,
                "guardPairwise": guard_losses["pairwise"],
                "guardNegativeMass": guard_losses["negativeMass"],
                "guardPositiveFloor": guard_losses["positiveFloor"],
                "guardNegativeCeiling": guard_losses["negativeCeiling"],
            }
            for key, value in values.items():
                totals[key] += float(value.item()) * batch_size
        scheduler.step()

        model.eval()
        general_full = evaluate_general(model, general_loader, device, ownership_loss, args)
        general_adapter = evaluate_general_adapter(model, general_loader, device)
        tactical, tactical_rows = evaluate_tactical(model, untouched_dataset, device, args)
        failure_count, failure_details = tactical_regression_failures(
            parent_tactical_rows, tactical_rows
        )
        guard, guard_rows_output = evaluate_guard(
            model, guard_dataset, device, parent_guard_rows, args
        )
        base_unchanged = state_dict_sha256(model.base.state_dict()) == base_state_sha
        checks = {
            "baseUnchanged": base_unchanged,
            "generalFinite": finite_general(general_full),
            "policyLossSafe": general_adapter["policyLoss"]
            <= parent_general_adapter["policyLoss"] + args.general_policy_loss_tolerance,
            "policyTop1Safe": general_adapter["policyTop1"]
            >= parent_general_adapter["policyTop1"] - args.policy_top1_tolerance,
            "klSafe": general_adapter["baseToCandidateKl"] <= args.general_kl_maximum,
            "residualSafe": general_adapter["meanAbsResidualLogit"]
            <= args.general_mean_delta_maximum
            and general_adapter["maxAbsResidualLogit"]
            <= float(seed_checkpoint["maxAbsDelta"]) + 1e-6,
            "untouchedTacticalRegressionsZero": failure_count == 0,
            "targetedRegressionFixturesPassed": bool(guard.get("passed")),
            "tacticalImproved": tactical["negativeTop1Rate"]
            < parent_tactical["negativeTop1Rate"] - 1e-12
            or tactical["meanMargin"]
            > parent_tactical["meanMargin"] + args.tactical_margin_min_delta
            or tactical["pairwiseLoss"]
            < parent_tactical["pairwiseLoss"] - args.tactical_pairwise_min_delta,
        }
        eligible = all(checks.values())
        rank = candidate_rank(guard, tactical, general_adapter)
        selected_now = eligible and (selected_rank is None or rank < selected_rank)
        adapter_state = clone_state(model.adapter)
        save_checkpoint(
            epoch_dir / f"epoch-{epoch:03d}.pt",
            base_checkpoint,
            adapter_state,
            seed_checkpoint,
            args,
            epoch=epoch,
            improved=eligible,
        )
        if selected_now:
            selected_epoch = epoch
            selected_adapter_state = copy.deepcopy(adapter_state)
            selected_general_full = copy.deepcopy(general_full)
            selected_general_adapter = copy.deepcopy(general_adapter)
            selected_tactical = copy.deepcopy(tactical)
            selected_tactical_failures = copy.deepcopy(failure_details)
            selected_guard = copy.deepcopy(guard)
            selected_guard_rows = copy.deepcopy(guard_rows_output)
            selected_rank = rank
            for row in history:
                row["selected"] = False
        history.append(
            {
                "epoch": epoch,
                "train": {key: value / max(1, seen) for key, value in totals.items()},
                "generalValidation": general_full,
                "adapterValidation": general_adapter,
                "untouchedTacticalValidation": {
                    **tactical,
                    "regressionFailuresVsParent": failure_count,
                    "regressionFailureDetails": failure_details,
                },
                "targetedRegressionFixtures": {**guard, "rows": guard_rows_output},
                "checks": checks,
                "eligible": eligible,
                "selected": selected_now,
            }
        )
        print(
            f"epoch {epoch:03d} policy={general_adapter['policyLoss']:.6f} "
            f"top1={general_adapter['policyTop1']:.3f} kl={general_adapter['baseToCandidateKl']:.6f} "
            f"untouched_neg_top1={tactical['negativeTop1Rate']:.3f} regressions={failure_count} "
            f"guard_negative_top1={guard['negativeTop1Count']} "
            f"guard_min_margin_delta={guard['minimumMarginDeltaVsParent']:.4f} "
            f"eligible={eligible} selected={selected_now}"
        )

    checkpoint_out = output_dir / "katacat-m362.pt"
    save_checkpoint(
        checkpoint_out,
        base_checkpoint,
        selected_adapter_state,
        seed_checkpoint,
        args,
        epoch=selected_epoch,
        improved=selected_epoch > 0,
    )
    selected_sha = sha256_file(checkpoint_out)
    summary = {
        "schemaVersion": 1,
        "stage": "M3.6.2_TARGETED_RESIDUAL_POLICY_ADAPTER_TRAIN",
        "commit_sha": args.commit_sha,
        "device": str(device),
        "encodingVersion": "PLAYER_RELATIVE_V1",
        "baseCheckpoint": str(base_path),
        "base_checkpoint_sha256": sha256_file(base_path),
        "seedAdapterCheckpoint": args.seed_adapter_checkpoint,
        "seed_adapter_checkpoint_sha256": sha256_file(Path(args.seed_adapter_checkpoint)),
        "selected_checkpoint_sha256": selected_sha,
        "selected_epoch": selected_epoch,
        "improved_over_parent": selected_epoch > 0,
        "behaviorEquivalentToParent": selected_epoch == 0,
        "trainableScope": "RESIDUAL_POLICY_ADAPTER_ONLY_TARGETED_REPAIR",
        "targetedRegressionFixtures": {
            "sampleIds": sorted(guard_ids),
            "gameIds": sorted(guard_game_ids),
            "count": len(guard_rows),
            "sourceDiagnostic": args.regression_diagnostic,
            "usedAsTrainingConstraints": True,
            "notCountedAsUntouchedValidation": True,
            "sameGameValidationRowsExcluded": len(excluded_same_game_validation),
        },
        "sourceSamples": {
            **{name: len(rows) for name, rows in replay_sources.items()},
            "hardNegative": len(hard_samples),
        },
        "trainSamples": len(train_samples),
        "generalValidationSamples": len(general_validation),
        "untouchedTacticalValidationSamples": len(untouched_tactical_validation),
        "balance": {
            "replay": replay_balance,
            "hardNegative": hard_balance,
            "hardSamplingMultiplier": args.hard_sampling_multiplier,
        },
        "parent": {
            "generalValidation": parent_general_full,
            "adapterValidation": parent_general_adapter,
            "untouchedTacticalValidation": parent_tactical,
            "targetedRegressionFixtures": {**parent_guard, "rows": parent_guard_rows},
        },
        "seedEpoch8": {
            "adapterValidation": seed_general_adapter,
            "untouchedTacticalValidation": {
                **seed_tactical,
                "regressionFailuresVsParent": seed_failures,
                "regressionFailureDetails": seed_failure_details,
            },
            "targetedRegressionFixtures": {**seed_guard, "rows": seed_guard_rows},
        },
        "selected": {
            "generalValidation": selected_general_full,
            "adapterValidation": selected_general_adapter,
            "untouchedTacticalValidation": {
                **selected_tactical,
                "regressionFailuresVsParent": len(selected_tactical_failures),
                "regressionFailureDetails": selected_tactical_failures,
            },
            "targetedRegressionFixtures": {**selected_guard, "rows": selected_guard_rows},
        },
        "lossWeights": {
            "replayPolicy": args.replay_policy_weight,
            "hardNegativePairwise": args.pairwise_weight,
            "hardNegativeMass": args.negative_mass_weight,
            "generalKl": args.general_kl_weight,
            "generalResidual": args.general_residual_weight,
            "guardPairwise": args.guard_pairwise_weight,
            "guardNegativeMass": args.guard_negative_mass_weight,
            "guardPositiveFloor": args.guard_positive_floor_weight,
            "guardNegativeCeiling": args.guard_negative_ceiling_weight,
        },
        "guardLimits": {
            "positiveFloorTolerance": args.guard_positive_floor_tolerance,
            "negativeCeilingTolerance": args.guard_negative_ceiling_tolerance,
            "marginTolerance": args.guard_margin_tolerance,
        },
        "selectionPolicy": {
            "fallbackIsZeroAdapterParent": True,
            "seedEpoch8IsNeverAutoSelected": True,
            "requiresTargetedFixturesPassed": True,
            "requiresUntouchedTacticalRegressionFailuresZero": True,
            "requiresUntouchedTacticalImprovement": True,
            "requiresGeneralPolicySafety": True,
            "requiresBaseByteStability": True,
        },
        "epochHistory": history,
        "acceptance": {
            "initializedFromPromisingM36Epoch8": int(seed_checkpoint.get("selectedEpoch", -1)) == 8,
            "baseModelFrozen": state_dict_sha256(model.base.state_dict()) == base_state_sha,
            "threeTargetedRegressionFixturesResolved": len(guard_rows) == 3,
            "guardGamesExcludedFromUntouchedValidation": not bool(guard_game_ids.intersection(untouched_games)),
            "allEpochCheckpointsSaved": len(list(epoch_dir.glob("epoch-*.pt"))) == args.epochs + 1,
            "candidateCheckpointSaved": checkpoint_out.is_file(),
            "checkpointSha256Recorded": len(selected_sha) == 64,
            "selectedUntouchedTacticalRegressionsZero": len(selected_tactical_failures) == 0,
            "selectedTargetedFixturesPassed": bool(selected_guard.get("passed", True)),
            "trainValidationGamesDisjoint": not bool(regular_train_games.intersection(general_games | untouched_games)),
            "largerHardNegativeSource": len(hard_samples) >= 300,
            "noRandomRollouts": True,
            "passed": False,
        },
        "note": (
            "The three repeated regression positions are targeted training fixtures and are not evidence of generalization. "
            "All other tactical validation rows from the same games are removed from the untouched validation set."
        ),
    }
    summary["acceptance"]["passed"] = all(
        value is True
        for key, value in summary["acceptance"].items()
        if key != "passed"
    )
    if selected_rank is not None and not all(math.isfinite(float(value)) for value in selected_rank):
        raise ValueError("M3.6.2 selected rank contains a non-finite metric")
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "selectedEpoch": selected_epoch,
                "improvedOverParent": selected_epoch > 0,
                "checkpointSha256": selected_sha,
                "acceptance": summary["acceptance"],
            }
        )
    )


if __name__ == "__main__":
    main()
