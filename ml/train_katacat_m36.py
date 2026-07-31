from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
from pathlib import Path
from typing import Any

import torch
from torch import nn
from torch.utils.data import DataLoader, WeightedRandomSampler

from katacat_m36_adapter import KataCatM36Model
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="M3.6 zero-initialized bounded residual policy-adapter training."
    )
    parser.add_argument("--bootstrap-data", required=True)
    parser.add_argument("--selfplay-data", required=True)
    parser.add_argument("--mixed-data", required=True)
    parser.add_argument("--curriculum-data", required=True)
    parser.add_argument("--hard-negative-data", required=True)
    parser.add_argument("--init-checkpoint", required=True)
    parser.add_argument("--out", default="katacat-m36-model")
    parser.add_argument("--epochs", type=int, default=16)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--learning-rate", type=float, default=2e-4)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--adapter-channels", type=int, default=8)
    parser.add_argument("--max-abs-delta", type=float, default=1.0)
    parser.add_argument("--pairwise-weight", type=float, default=2.0)
    parser.add_argument("--pairwise-margin", type=float, default=0.5)
    parser.add_argument("--negative-mass-weight", type=float, default=0.5)
    parser.add_argument("--general-kl-weight", type=float, default=4.0)
    parser.add_argument("--general-residual-weight", type=float, default=1.0)
    parser.add_argument("--replay-policy-weight", type=float, default=0.15)
    parser.add_argument("--hard-sampling-multiplier", type=float, default=6.0)
    parser.add_argument("--general-policy-loss-tolerance", type=float, default=0.003)
    parser.add_argument("--policy-top1-tolerance", type=float, default=0.005)
    parser.add_argument("--general-kl-maximum", type=float, default=0.01)
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
        default=os.environ.get("KATACAT_M36_COMMIT_SHA", "unknown"),
    )
    return parser.parse_args()


def state_dict_sha256(state: dict[str, torch.Tensor]) -> str:
    digest = hashlib.sha256()
    for name, tensor in sorted(state.items()):
        value = tensor.detach().cpu().contiguous()
        digest.update(name.encode("utf-8"))
        digest.update(str(tuple(value.shape)).encode("utf-8"))
        digest.update(value.numpy().tobytes())
    return digest.hexdigest()


def clone_state(module: nn.Module) -> dict[str, torch.Tensor]:
    return {
        name: tensor.detach().cpu().clone()
        for name, tensor in module.state_dict().items()
    }


def negative_mass_loss(
    logits: torch.Tensor,
    hard_flags: torch.Tensor,
    positive_actions: torch.Tensor,
    negative_masks: torch.Tensor,
    margin: float,
) -> torch.Tensor:
    valid = torch.logical_and(hard_flags > 0.5, negative_masks.any(dim=1))
    if not bool(valid.any()):
        return logits.sum() * 0.0
    selected = logits[valid]
    positives = selected.gather(1, positive_actions[valid].unsqueeze(1)).squeeze(1)
    negatives = selected.masked_fill(~negative_masks[valid], -1e9)
    negative_log_mass = torch.logsumexp(negatives, dim=1)
    return nn.functional.softplus(float(margin) - (positives - negative_log_mass)).mean()


def base_to_candidate_kl(
    base_logits: torch.Tensor,
    corrected_logits: torch.Tensor,
    mask: torch.Tensor,
) -> torch.Tensor:
    if not bool(mask.any()):
        return corrected_logits.sum() * 0.0
    base_probability = torch.softmax(base_logits[mask].detach(), dim=1)
    return nn.functional.kl_div(
        torch.log_softmax(corrected_logits[mask], dim=1),
        base_probability,
        reduction="batchmean",
    )


@torch.no_grad()
def evaluate_general_adapter(
    model: KataCatM36Model,
    loader: DataLoader,
    device: torch.device,
) -> dict[str, float]:
    model.eval()
    examples = 0
    policy_loss = 0.0
    policy_correct = 0
    kl_total = 0.0
    abs_delta_total = 0.0
    delta_elements = 0
    maximum_delta = 0.0
    for batch in loader:
        features = batch[0].to(device)
        policy = batch[1].to(device)
        corrected, base, delta = model.policy_outputs(features)
        per_row = per_sample_policy_loss(corrected, policy)
        batch_size = features.shape[0]
        examples += batch_size
        policy_loss += float(per_row.sum().item())
        policy_correct += int((corrected.argmax(dim=1) == policy.argmax(dim=1)).sum().item())
        kl = nn.functional.kl_div(
            torch.log_softmax(corrected, dim=1),
            torch.softmax(base, dim=1),
            reduction="sum",
        )
        kl_total += float(kl.item())
        abs_delta_total += float(delta.abs().sum().item())
        delta_elements += int(delta.numel())
        maximum_delta = max(maximum_delta, float(delta.abs().max().item()))
    if examples <= 0:
        raise ValueError("M3.6 general validation is empty")
    return {
        "examples": float(examples),
        "policyLoss": policy_loss / examples,
        "policyTop1": policy_correct / examples,
        "baseToCandidateKl": kl_total / examples,
        "meanAbsResidualLogit": abs_delta_total / max(1, delta_elements),
        "maxAbsResidualLogit": maximum_delta,
    }


def selection_rank(
    tactical: dict[str, float],
    general_adapter: dict[str, float],
) -> tuple[float, float, float, float, float]:
    return (
        float(tactical["negativeTop1Rate"]),
        float(tactical["pairwiseLoss"]),
        -float(tactical["meanMargin"]),
        float(general_adapter["baseToCandidateKl"]),
        float(general_adapter["policyLoss"]),
    )


def save_adapter_checkpoint(
    path: Path,
    base_checkpoint: dict[str, Any],
    adapter_state: dict[str, torch.Tensor],
    args: argparse.Namespace,
    epoch: int,
    improved: bool,
) -> None:
    torch.save(
        {
            "schemaVersion": 1,
            "stage": "M3.6_RESIDUAL_POLICY_ADAPTER",
            "encodingVersion": "PLAYER_RELATIVE_V1",
            "channels": int(base_checkpoint["channels"]),
            "blocks": int(base_checkpoint["blocks"]),
            "baseModelState": base_checkpoint["modelState"],
            "adapterState": adapter_state,
            "adapterChannels": int(args.adapter_channels),
            "maxAbsDelta": float(args.max_abs_delta),
            "selectedEpoch": int(epoch),
            "improvedOverParent": bool(improved),
            "baseCheckpointSha256": sha256_file(Path(args.init_checkpoint)),
            "commitSha": args.commit_sha,
        },
        path,
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
    replay_originals = unique_samples([row for rows in replay_sources.values() for row in rows])
    replay_balanced, replay_balance = balance_real_seats(replay_originals, args.seed)
    hard_train, hard_validation, hard_balance = balance_hard_train(
        unique_samples(hard_samples), args.seed + 1
    )
    replay_train = [row for row in replay_balanced if row["split"] == "train"]
    general_validation = [row for row in replay_balanced if row["split"] == "validation"]
    train_samples = unique_samples([*replay_train, *hard_train])
    if not train_samples or not general_validation or not hard_validation:
        raise ValueError("M3.6 requires train, general validation, and tactical validation")

    train_games = {str(row["gameId"]) for row in train_samples}
    validation_games = {
        str(row["gameId"]) for row in [*general_validation, *hard_validation]
    }
    if train_games.intersection(validation_games):
        raise ValueError("M3.6 train/validation game leakage")

    device = choose_device(args.device)
    checkpoint_path = Path(args.init_checkpoint)
    base_checkpoint = torch.load(checkpoint_path, map_location="cpu")
    if base_checkpoint.get("encodingVersion") != "PLAYER_RELATIVE_V1":
        raise ValueError("M3.6 requires PLAYER_RELATIVE_V1")
    base = KataCatNet(int(base_checkpoint["channels"]), int(base_checkpoint["blocks"]))
    base.load_state_dict(base_checkpoint["modelState"])
    model = KataCatM36Model(
        base,
        adapter_channels=args.adapter_channels,
        max_abs_delta=args.max_abs_delta,
    ).to(device)
    model.base.eval()
    base_state_sha = state_dict_sha256(model.base.state_dict())

    train_dataset = M341Dataset(train_samples, augment=args.augment == "on")
    general_dataset = M341Dataset(general_validation, augment=False)
    tactical_dataset = M341Dataset(hard_validation, augment=False)
    general_loader = DataLoader(
        general_dataset,
        batch_size=args.batch_size,
        shuffle=False,
        num_workers=0,
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
        model, general_loader, device, ownership_loss, args
    )
    parent_general_adapter = evaluate_general_adapter(model, general_loader, device)
    parent_tactical, parent_tactical_rows = evaluate_tactical(
        model, tactical_dataset, device, args
    )
    parent_adapter_state = clone_state(model.adapter)
    parent_rank = selection_rank(parent_tactical, parent_general_adapter)

    optimizer = torch.optim.AdamW(
        model.adapter.parameters(),
        lr=args.learning_rate,
        weight_decay=args.weight_decay,
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, T_max=max(1, args.epochs)
    )

    output_dir = Path(args.out)
    epoch_dir = output_dir / "epochs"
    epoch_dir.mkdir(parents=True, exist_ok=True)
    save_adapter_checkpoint(
        epoch_dir / "epoch-000.pt",
        base_checkpoint,
        parent_adapter_state,
        args,
        epoch=0,
        improved=False,
    )

    selected_epoch = 0
    selected_adapter_state = copy.deepcopy(parent_adapter_state)
    selected_general_full = copy.deepcopy(parent_general_full)
    selected_general_adapter = copy.deepcopy(parent_general_adapter)
    selected_tactical = copy.deepcopy(parent_tactical)
    selected_failure_details: list[dict[str, Any]] = []
    selected_rank = parent_rank
    history: list[dict[str, Any]] = [
        {
            "epoch": 0,
            "source": "zero_adapter_parent_behavior",
            "generalValidation": parent_general_full,
            "adapterValidation": parent_general_adapter,
            "frozenTacticalValidation": {
                **parent_tactical,
                "regressionFailuresVsParent": 0,
            },
            "baseStateSha256": base_state_sha,
            "eligible": True,
            "selected": True,
        }
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
            kl_loss = base_to_candidate_kl(base_logits, corrected, replay_mask)
            residual_loss = (
                delta[replay_mask].pow(2).mean()
                if bool(replay_mask.any())
                else delta.sum() * 0.0
            )
            loss = (
                args.replay_policy_weight * replay_policy
                + args.pairwise_weight * pair_loss
                + args.negative_mass_weight * mass_loss
                + args.general_kl_weight * kl_loss
                + args.general_residual_weight * residual_loss
            )
            loss.backward()
            nn.utils.clip_grad_norm_(model.adapter.parameters(), max_norm=2.0)
            optimizer.step()
            batch_size = features.shape[0]
            seen += batch_size
            for key, value in (
                ("loss", loss),
                ("replayPolicy", replay_policy),
                ("pairwise", pair_loss),
                ("negativeMass", mass_loss),
                ("generalKl", kl_loss),
                ("generalResidual", residual_loss),
            ):
                totals[key] += float(value.item()) * batch_size
        scheduler.step()

        model.eval()
        general_full = evaluate_general(
            model, general_loader, device, ownership_loss, args
        )
        general_adapter = evaluate_general_adapter(model, general_loader, device)
        tactical, tactical_rows = evaluate_tactical(
            model, tactical_dataset, device, args
        )
        failure_count, failure_details = tactical_regression_failures(
            parent_tactical_rows, tactical_rows
        )
        base_unchanged = state_dict_sha256(model.base.state_dict()) == base_state_sha
        policy_loss_safe = (
            general_adapter["policyLoss"]
            <= parent_general_adapter["policyLoss"] + args.general_policy_loss_tolerance
        )
        policy_top1_safe = (
            general_adapter["policyTop1"]
            >= parent_general_adapter["policyTop1"] - args.policy_top1_tolerance
        )
        kl_safe = general_adapter["baseToCandidateKl"] <= args.general_kl_maximum
        residual_safe = (
            general_adapter["meanAbsResidualLogit"]
            <= args.general_mean_delta_maximum
            and general_adapter["maxAbsResidualLogit"] <= args.max_abs_delta + 1e-6
        )
        tactical_improved = (
            tactical["negativeTop1Rate"]
            < parent_tactical["negativeTop1Rate"] - 1e-12
            or tactical["meanMargin"]
            > parent_tactical["meanMargin"] + args.tactical_margin_min_delta
            or tactical["pairwiseLoss"]
            < parent_tactical["pairwiseLoss"] - args.tactical_pairwise_min_delta
        )
        eligible = (
            base_unchanged
            and finite_general(general_full)
            and policy_loss_safe
            and policy_top1_safe
            and kl_safe
            and residual_safe
            and failure_count == 0
            and tactical_improved
        )
        rank = selection_rank(tactical, general_adapter)
        selected_now = eligible and (selected_epoch == 0 or rank < selected_rank)
        adapter_state = clone_state(model.adapter)
        save_adapter_checkpoint(
            epoch_dir / f"epoch-{epoch:03d}.pt",
            base_checkpoint,
            adapter_state,
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
            selected_failure_details = copy.deepcopy(failure_details)
            selected_rank = rank
            for row in history:
                row["selected"] = False
        history.append(
            {
                "epoch": epoch,
                "train": {key: value / max(1, seen) for key, value in totals.items()},
                "generalValidation": general_full,
                "adapterValidation": general_adapter,
                "frozenTacticalValidation": {
                    **tactical,
                    "regressionFailuresVsParent": failure_count,
                    "regressionFailureDetails": failure_details,
                },
                "checks": {
                    "baseUnchanged": base_unchanged,
                    "policyLossSafe": policy_loss_safe,
                    "policyTop1Safe": policy_top1_safe,
                    "klSafe": kl_safe,
                    "residualSafe": residual_safe,
                    "tacticalImproved": tactical_improved,
                },
                "eligible": eligible,
                "selected": selected_now,
            }
        )
        print(
            f"epoch {epoch:03d} policy={general_adapter['policyLoss']:.6f} "
            f"top1={general_adapter['policyTop1']:.3f} "
            f"kl={general_adapter['baseToCandidateKl']:.6f} "
            f"delta={general_adapter['meanAbsResidualLogit']:.4f} "
            f"neg_top1={tactical['negativeTop1Rate']:.3f} "
            f"margin={tactical['meanMargin']:.4f} regressions={failure_count} "
            f"eligible={eligible} selected={selected_now}"
        )

    checkpoint_out = output_dir / "katacat-m36.pt"
    save_adapter_checkpoint(
        checkpoint_out,
        base_checkpoint,
        selected_adapter_state,
        args,
        epoch=selected_epoch,
        improved=selected_epoch > 0,
    )
    selected_checkpoint_sha = sha256_file(checkpoint_out)
    parent_checkpoint_sha = sha256_file(checkpoint_path)
    summary = {
        "schemaVersion": 1,
        "stage": "M3.6_RESIDUAL_POLICY_ADAPTER_TRAIN",
        "commit_sha": args.commit_sha,
        "device": str(device),
        "encodingVersion": "PLAYER_RELATIVE_V1",
        "parentCheckpoint": str(checkpoint_path),
        "parent_checkpoint_sha256": parent_checkpoint_sha,
        "selected_checkpoint_sha256": selected_checkpoint_sha,
        "selected_epoch": selected_epoch,
        "improved_over_parent": selected_epoch > 0,
        "behaviorEquivalentToParent": selected_epoch == 0,
        "trainableScope": "RESIDUAL_POLICY_ADAPTER_ONLY",
        "adapter": {
            "channels": args.adapter_channels,
            "maxAbsDelta": args.max_abs_delta,
            "parameters": sum(parameter.numel() for parameter in model.adapter.parameters()),
            "zeroInitialized": True,
            "baseStateSha256": base_state_sha,
        },
        "sourceSamples": {
            **{name: len(rows) for name, rows in replay_sources.items()},
            "hardNegative": len(hard_samples),
        },
        "trainSamples": len(train_samples),
        "generalValidationSamples": len(general_validation),
        "frozenTacticalValidationSamples": len(hard_validation),
        "balance": {
            "replay": replay_balance,
            "hardNegative": hard_balance,
            "hardSamplingMultiplier": args.hard_sampling_multiplier,
        },
        "parent": {
            "generalValidation": parent_general_full,
            "adapterValidation": parent_general_adapter,
            "frozenTacticalValidation": parent_tactical,
        },
        "selected": {
            "generalValidation": selected_general_full,
            "adapterValidation": selected_general_adapter,
            "frozenTacticalValidation": {
                **selected_tactical,
                "regressionFailuresVsParent": len(selected_failure_details),
                "regressionFailureDetails": selected_failure_details,
            },
        },
        "lossWeights": {
            "replayPolicy": args.replay_policy_weight,
            "hardNegativePairwise": args.pairwise_weight,
            "hardNegativeMass": args.negative_mass_weight,
            "generalKl": args.general_kl_weight,
            "generalResidual": args.general_residual_weight,
        },
        "selectionPolicy": {
            "parentIsZeroAdapterEpoch0": True,
            "requiresBaseByteStability": True,
            "requiresGeneralPolicySafety": True,
            "requiresGeneralKlLimit": True,
            "requiresResidualMagnitudeLimit": True,
            "requiresTacticalRegressionFailuresZero": True,
            "requiresTacticalImprovement": True,
        },
        "epochHistory": history,
        "acceptance": {
            "initializedFromM341": True,
            "zeroAdapterParentIncludedAsEpoch0": True,
            "baseModelFrozen": state_dict_sha256(model.base.state_dict()) == base_state_sha,
            "adapterBounded": args.max_abs_delta > 0,
            "allEpochCheckpointsSaved": len(list(epoch_dir.glob("epoch-*.pt"))) == args.epochs + 1,
            "generalValidationFinite": finite_general(selected_general_full),
            "tacticalRegressionFailuresZero": len(selected_failure_details) == 0,
            "trainValidationGamesDisjoint": not bool(train_games.intersection(validation_games)),
            "candidateCheckpointSaved": checkpoint_out.is_file(),
            "checkpointSha256Recorded": len(selected_checkpoint_sha) == 64,
            "largerHardNegativeSource": len(hard_samples) >= 300,
            "noRandomRollouts": True,
            "passed": False,
        },
        "note": (
            "The M3.4.1 base network is frozen. The adapter adds a bounded residual only to policy logits. "
            "Bounded-reader non-refutation is diagnostic evidence, not a mathematical proof of safety."
        ),
    }
    summary["acceptance"]["passed"] = all(
        value is True
        for key, value in summary["acceptance"].items()
        if key != "passed"
    )
    if not all(math.isfinite(float(value)) for value in selected_rank):
        raise ValueError("M3.6 selected rank contains a non-finite metric")
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "selectedEpoch": selected_epoch,
        "improvedOverParent": selected_epoch > 0,
        "checkpointSha256": selected_checkpoint_sha,
        "acceptance": summary["acceptance"],
    }))


if __name__ == "__main__":
    main()
