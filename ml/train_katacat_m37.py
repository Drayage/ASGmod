from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import shutil
from pathlib import Path
from typing import Any

import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler

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
        description="M3.7 fresh league retraining of the last trunk blocks and all heads."
    )
    parser.add_argument("--league-data", required=True)
    parser.add_argument("--bootstrap-data", required=True)
    parser.add_argument("--selfplay-data", required=True)
    parser.add_argument("--mixed-data", required=True)
    parser.add_argument("--curriculum-data", required=True)
    parser.add_argument("--hard-negative-data", required=True)
    parser.add_argument("--init-checkpoint", required=True)
    parser.add_argument("--out", default="katacat-m37-model")
    parser.add_argument("--epochs", type=int, default=10)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--learning-rate", type=float, default=5e-5)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--trainable-trunk-blocks", type=int, default=2)
    parser.add_argument("--league-sampling-weight", type=float, default=3.0)
    parser.add_argument("--hard-sampling-weight", type=float, default=4.0)
    parser.add_argument("--stability-sampling-weight", type=float, default=1.0)
    parser.add_argument("--value-weight", type=float, default=1.0)
    parser.add_argument("--score-weight", type=float, default=0.25)
    parser.add_argument("--ownership-weight", type=float, default=1.0)
    parser.add_argument("--hard-pairwise-weight", type=float, default=0.75)
    parser.add_argument("--hard-pairwise-margin", type=float, default=0.5)
    parser.add_argument("--policy-distill-weight", type=float, default=2.0)
    parser.add_argument("--value-distill-weight", type=float, default=0.5)
    parser.add_argument("--score-distill-weight", type=float, default=0.25)
    parser.add_argument("--ownership-distill-weight", type=float, default=0.5)
    parser.add_argument("--league-loss-min-delta", type=float, default=0.002)
    parser.add_argument("--stability-policy-loss-tolerance", type=float, default=0.015)
    parser.add_argument("--stability-policy-top1-tolerance", type=float, default=0.015)
    parser.add_argument("--stability-value-loss-tolerance", type=float, default=0.03)
    parser.add_argument("--stability-score-mae-tolerance", type=float, default=0.5)
    parser.add_argument("--stability-iou-tolerance", type=float, default=0.02)
    parser.add_argument("--seed", type=int, default=20260801)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--augment", choices=("on", "off"), default="on")
    parser.add_argument(
        "--commit-sha",
        default=os.environ.get("KATACAT_M37_COMMIT_SHA", "unknown"),
    )
    args = parser.parse_args()
    # Shared M3.4.1 tactical evaluation expects this compatibility name.
    args.pairwise_margin = args.hard_pairwise_margin
    return args


class M37TrainDataset(Dataset):
    def __init__(self, samples: list[dict[str, Any]], augment: bool) -> None:
        self.samples = samples
        self.base = M341Dataset(samples, augment=augment)
        self.ownership = self.base.ownership
        self.source_codes = []
        for sample in samples:
            source = str(sample.get("trainingSource", ""))
            if source == "league":
                self.source_codes.append(0)
            elif source == "hardNegative":
                self.source_codes.append(2)
            else:
                self.source_codes.append(1)

    def __len__(self) -> int:
        return len(self.base)

    def __getitem__(self, index: int):
        return (*self.base[index], torch.tensor(self.source_codes[index], dtype=torch.long))


def clone_state(module: nn.Module) -> dict[str, torch.Tensor]:
    return {
        name: tensor.detach().cpu().clone()
        for name, tensor in module.state_dict().items()
    }


def selected_parameter_sha(model: KataCatNet, trainable_blocks: int) -> str:
    digest = hashlib.sha256()
    frozen_until = len(model.trunk) - trainable_blocks
    entries: list[tuple[str, torch.Tensor]] = []
    entries.extend((f"stem.{name}", value) for name, value in model.stem.state_dict().items())
    for index in range(max(0, frozen_until)):
        entries.extend(
            (f"trunk.{index}.{name}", value)
            for name, value in model.trunk[index].state_dict().items()
        )
    for name, tensor in sorted(entries, key=lambda item: item[0]):
        value = tensor.detach().cpu().contiguous()
        digest.update(name.encode("utf-8"))
        digest.update(str(tuple(value.shape)).encode("utf-8"))
        digest.update(value.numpy().tobytes())
    return digest.hexdigest()


def configure_trainable_scope(model: KataCatNet, trainable_blocks: int) -> list[str]:
    if trainable_blocks <= 0 or trainable_blocks > len(model.trunk):
        raise ValueError(
            f"--trainable-trunk-blocks must be in 1..{len(model.trunk)}, got {trainable_blocks}"
        )
    for parameter in model.parameters():
        parameter.requires_grad = False
    names: list[str] = []
    first_trainable = len(model.trunk) - trainable_blocks
    for index in range(first_trainable, len(model.trunk)):
        for name, parameter in model.trunk[index].named_parameters():
            parameter.requires_grad = True
            names.append(f"trunk.{index}.{name}")
    for head_name in ("policy_head", "value_head", "score_head", "ownership_head"):
        head = getattr(model, head_name)
        for name, parameter in head.named_parameters():
            parameter.requires_grad = True
            names.append(f"{head_name}.{name}")
    return names


def zero_like(logits: torch.Tensor) -> torch.Tensor:
    return logits.sum() * 0.0


def policy_kl(parent: torch.Tensor, candidate: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    if not bool(mask.any()):
        return zero_like(candidate)
    target = torch.softmax(parent[mask].detach(), dim=1)
    return nn.functional.kl_div(
        torch.log_softmax(candidate[mask], dim=1),
        target,
        reduction="batchmean",
    )


def ownership_kl(parent: torch.Tensor, candidate: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    if not bool(mask.any()):
        return zero_like(candidate)
    target = torch.softmax(parent[mask].detach(), dim=1)
    return nn.functional.kl_div(
        torch.log_softmax(candidate[mask], dim=1),
        target,
        reduction="batchmean",
    )


def stability_safe(
    parent: dict[str, float],
    candidate: dict[str, float],
    args: argparse.Namespace,
) -> tuple[bool, dict[str, bool]]:
    checks = {
        "policyLoss": candidate["policyLoss"]
        <= parent["policyLoss"] + args.stability_policy_loss_tolerance,
        "policyTop1": candidate["policyTop1"]
        >= parent["policyTop1"] - args.stability_policy_top1_tolerance,
        "valueLoss": candidate["valueLoss"]
        <= parent["valueLoss"] + args.stability_value_loss_tolerance,
        "scoreMaeCells": candidate["scoreMaeCells"]
        <= parent["scoreMaeCells"] + args.stability_score_mae_tolerance,
        "meanTerritoryIou": candidate["meanTerritoryIou"]
        >= parent["meanTerritoryIou"] - args.stability_iou_tolerance,
    }
    return all(checks.values()), checks


def rank_candidate(
    league: dict[str, float],
    tactical: dict[str, float],
    stability: dict[str, float],
) -> tuple[float, float, float, float, float]:
    return (
        float(league["loss"]),
        float(tactical["negativeTop1Rate"]),
        float(tactical["pairwiseLoss"]),
        -float(tactical["meanMargin"]),
        float(stability["loss"]),
    )


def save_checkpoint(
    path: Path,
    model: KataCatNet,
    base_checkpoint: dict[str, Any],
    epoch: int,
    commit_sha: str,
    trainable_blocks: int,
) -> None:
    torch.save(
        {
            "modelState": clone_state(model),
            "inputChannels": int(base_checkpoint.get("inputChannels", 16)),
            "policySize": int(base_checkpoint.get("policySize", 82)),
            "channels": int(base_checkpoint["channels"]),
            "blocks": int(base_checkpoint["blocks"]),
            "boardSize": int(base_checkpoint.get("boardSize", 9)),
            "maxMargin": int(base_checkpoint.get("maxMargin", 84)),
            "epoch": int(epoch),
            "stage": "M3.7_FRESH_LEAGUE_RETRAIN",
            "encodingVersion": "PLAYER_RELATIVE_V1",
            "trainableScope": f"LAST_{trainable_blocks}_TRUNK_BLOCKS_AND_ALL_HEADS",
            "commitSha": commit_sha,
        },
        path,
    )


def main() -> None:
    args = parse_args()
    seed_everything(args.seed)

    league_rows = tagged_samples("league", args.league_data)
    league_balanced, league_balance = balance_real_seats(
        unique_samples(league_rows), args.seed
    )
    league_train = [row for row in league_balanced if row["split"] == "train"]
    league_validation = [row for row in league_balanced if row["split"] == "validation"]

    stability_sources = {
        "stabilityBootstrap": tagged_samples("stabilityBootstrap", args.bootstrap_data),
        "stabilitySelfplay": tagged_samples("stabilitySelfplay", args.selfplay_data),
        "stabilityMixed": tagged_samples("stabilityMixed", args.mixed_data),
        "stabilityCurriculum": tagged_samples("stabilityCurriculum", args.curriculum_data),
    }
    stability_originals = unique_samples(
        [row for rows in stability_sources.values() for row in rows]
    )
    stability_balanced, stability_balance = balance_real_seats(
        stability_originals, args.seed + 1
    )
    stability_train = [row for row in stability_balanced if row["split"] == "train"]
    stability_validation = [
        row for row in stability_balanced if row["split"] == "validation"
    ]

    hard_rows = tagged_samples("hardNegative", args.hard_negative_data)
    hard_train, hard_validation, hard_balance = balance_hard_train(
        unique_samples(hard_rows), args.seed + 2
    )

    train_samples = unique_samples([*league_train, *stability_train, *hard_train])
    if not train_samples or not league_validation or not stability_validation or not hard_validation:
        raise ValueError(
            "M3.7 requires train, fresh league validation, stability validation, and tactical validation"
        )

    train_games = {str(row["gameId"]) for row in train_samples}
    validation_games = {
        str(row["gameId"])
        for row in [*league_validation, *stability_validation, *hard_validation]
    }
    if train_games.intersection(validation_games):
        raise ValueError("M3.7 train/validation game leakage")

    device = choose_device(args.device)
    checkpoint_path = Path(args.init_checkpoint)
    base_checkpoint = torch.load(checkpoint_path, map_location="cpu")
    if base_checkpoint.get("encodingVersion") != "PLAYER_RELATIVE_V1":
        raise ValueError("M3.7 requires PLAYER_RELATIVE_V1")
    model = KataCatNet(int(base_checkpoint["channels"]), int(base_checkpoint["blocks"]))
    model.load_state_dict(base_checkpoint["modelState"])
    parent = copy.deepcopy(model).to(device).eval()
    for parameter in parent.parameters():
        parameter.requires_grad = False
    model = model.to(device)
    trainable_names = configure_trainable_scope(model, args.trainable_trunk_blocks)
    frozen_sha = selected_parameter_sha(model, args.trainable_trunk_blocks)

    train_dataset = M37TrainDataset(train_samples, augment=args.augment == "on")
    league_dataset = M341Dataset(league_validation, augment=False)
    stability_dataset = M341Dataset(stability_validation, augment=False)
    tactical_dataset = M341Dataset(hard_validation, augment=False)
    league_loader = DataLoader(
        league_dataset, batch_size=args.batch_size, shuffle=False, num_workers=0
    )
    stability_loader = DataLoader(
        stability_dataset, batch_size=args.batch_size, shuffle=False, num_workers=0
    )
    ownership_loss = nn.CrossEntropyLoss(
        weight=ownership_class_weights(train_dataset, device)
    )

    sample_weights = []
    for row in train_samples:
        source = str(row.get("trainingSource", ""))
        if source == "league":
            sample_weights.append(args.league_sampling_weight)
        elif source == "hardNegative":
            sample_weights.append(args.hard_sampling_weight)
        else:
            sample_weights.append(args.stability_sampling_weight)
    sampler = WeightedRandomSampler(
        torch.tensor(sample_weights, dtype=torch.double),
        num_samples=max(len(train_samples), 2 * len(league_train)),
        replacement=True,
        generator=torch.Generator().manual_seed(args.seed),
    )
    train_loader = DataLoader(
        train_dataset,
        batch_size=args.batch_size,
        sampler=sampler,
        num_workers=0,
        pin_memory=device.type == "cuda",
    )

    parent_league = evaluate_general(
        parent, league_loader, device, ownership_loss, args
    )
    parent_stability = evaluate_general(
        parent, stability_loader, device, ownership_loss, args
    )
    parent_tactical, parent_tactical_rows = evaluate_tactical(
        parent, tactical_dataset, device, args
    )

    optimizer = torch.optim.AdamW(
        [parameter for parameter in model.parameters() if parameter.requires_grad],
        lr=args.learning_rate,
        weight_decay=args.weight_decay,
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, T_max=max(1, args.epochs)
    )

    output_dir = Path(args.out)
    epoch_dir = output_dir / "epochs"
    epoch_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(checkpoint_path, epoch_dir / "epoch-000.pt")

    selected_epoch = 0
    selected_state = clone_state(model)
    selected_league = copy.deepcopy(parent_league)
    selected_stability = copy.deepcopy(parent_stability)
    selected_tactical = copy.deepcopy(parent_tactical)
    selected_failures: list[dict[str, Any]] = []
    selected_rank = rank_candidate(parent_league, parent_tactical, parent_stability)
    history: list[dict[str, Any]] = [
        {
            "epoch": 0,
            "source": "M3.4.1_parent",
            "freshLeagueValidation": parent_league,
            "stabilityValidation": parent_stability,
            "frozenTacticalValidation": {
                **parent_tactical,
                "regressionFailuresVsParent": 0,
            },
            "eligible": True,
            "selected": True,
        }
    ]

    for epoch in range(1, args.epochs + 1):
        model.train()
        totals = {
            "loss": 0.0,
            "supervised": 0.0,
            "hardPairwise": 0.0,
            "policyDistill": 0.0,
            "valueDistill": 0.0,
            "scoreDistill": 0.0,
            "ownershipDistill": 0.0,
        }
        seen = 0
        for batch in train_loader:
            (
                features,
                policy,
                value,
                score,
                ownership,
                hard_flags,
                positive_actions,
                negative_masks,
                source_codes,
            ) = batch
            features = features.to(device)
            policy = policy.to(device)
            value = value.to(device)
            score = score.to(device)
            ownership = ownership.to(device)
            hard_flags = hard_flags.to(device)
            positive_actions = positive_actions.to(device)
            negative_masks = negative_masks.to(device)
            source_codes = source_codes.to(device)

            optimizer.zero_grad(set_to_none=True)
            candidate_policy, candidate_value, candidate_score, candidate_ownership = model(features)
            with torch.no_grad():
                parent_policy, parent_value, parent_score, parent_ownership = parent(features)

            p_rows = per_sample_policy_loss(candidate_policy, policy)
            v_rows = nn.functional.mse_loss(candidate_value, value, reduction="none")
            s_rows = nn.functional.smooth_l1_loss(candidate_score, score, reduction="none")
            o_rows = nn.functional.cross_entropy(
                candidate_ownership,
                ownership,
                weight=ownership_loss.weight,
                reduction="none",
            ).mean(dim=(1, 2))
            supervised = (
                p_rows
                + args.value_weight * v_rows
                + args.score_weight * s_rows
                + args.ownership_weight * o_rows
            ).mean()
            hard_pairwise, _margins, _positive, _negative = pairwise_components(
                candidate_policy,
                hard_flags,
                positive_actions,
                negative_masks,
                args.hard_pairwise_margin,
            )
            stability_mask = source_codes == 1
            p_distill = policy_kl(parent_policy, candidate_policy, stability_mask)
            if bool(stability_mask.any()):
                v_distill = nn.functional.mse_loss(
                    candidate_value[stability_mask], parent_value[stability_mask]
                )
                s_distill = nn.functional.mse_loss(
                    candidate_score[stability_mask], parent_score[stability_mask]
                )
            else:
                v_distill = zero_like(candidate_value)
                s_distill = zero_like(candidate_score)
            o_distill = ownership_kl(
                parent_ownership, candidate_ownership, stability_mask
            )
            loss = (
                supervised
                + args.hard_pairwise_weight * hard_pairwise
                + args.policy_distill_weight * p_distill
                + args.value_distill_weight * v_distill
                + args.score_distill_weight * s_distill
                + args.ownership_distill_weight * o_distill
            )
            loss.backward()
            nn.utils.clip_grad_norm_(
                [parameter for parameter in model.parameters() if parameter.requires_grad],
                max_norm=2.0,
            )
            optimizer.step()

            batch_size = features.shape[0]
            seen += batch_size
            for key, value_tensor in (
                ("loss", loss),
                ("supervised", supervised),
                ("hardPairwise", hard_pairwise),
                ("policyDistill", p_distill),
                ("valueDistill", v_distill),
                ("scoreDistill", s_distill),
                ("ownershipDistill", o_distill),
            ):
                totals[key] += float(value_tensor.item()) * batch_size
        scheduler.step()

        model.eval()
        league_metrics = evaluate_general(
            model, league_loader, device, ownership_loss, args
        )
        stability_metrics = evaluate_general(
            model, stability_loader, device, ownership_loss, args
        )
        tactical_metrics, tactical_rows = evaluate_tactical(
            model, tactical_dataset, device, args
        )
        failure_count, failure_details = tactical_regression_failures(
            parent_tactical_rows, tactical_rows
        )
        frozen_unchanged = (
            selected_parameter_sha(model, args.trainable_trunk_blocks) == frozen_sha
        )
        stability_ok, stability_checks = stability_safe(
            parent_stability, stability_metrics, args
        )
        league_improved = (
            league_metrics["loss"]
            <= parent_league["loss"] - args.league_loss_min_delta
        )
        eligible = (
            frozen_unchanged
            and finite_general(league_metrics)
            and finite_general(stability_metrics)
            and stability_ok
            and failure_count == 0
            and league_improved
        )
        rank = rank_candidate(league_metrics, tactical_metrics, stability_metrics)
        selected_now = eligible and (selected_epoch == 0 or rank < selected_rank)
        save_checkpoint(
            epoch_dir / f"epoch-{epoch:03d}.pt",
            model,
            base_checkpoint,
            epoch,
            args.commit_sha,
            args.trainable_trunk_blocks,
        )
        if selected_now:
            selected_epoch = epoch
            selected_state = clone_state(model)
            selected_league = copy.deepcopy(league_metrics)
            selected_stability = copy.deepcopy(stability_metrics)
            selected_tactical = copy.deepcopy(tactical_metrics)
            selected_failures = copy.deepcopy(failure_details)
            selected_rank = rank
            for row in history:
                row["selected"] = False
        history.append(
            {
                "epoch": epoch,
                "train": {key: value / max(1, seen) for key, value in totals.items()},
                "freshLeagueValidation": league_metrics,
                "stabilityValidation": stability_metrics,
                "frozenTacticalValidation": {
                    **tactical_metrics,
                    "regressionFailuresVsParent": failure_count,
                    "regressionFailureDetails": failure_details,
                },
                "checks": {
                    "frozenPrefixUnchanged": frozen_unchanged,
                    "leagueImproved": league_improved,
                    "stabilitySafe": stability_ok,
                    "stability": stability_checks,
                    "tacticalRegressionFailuresZero": failure_count == 0,
                },
                "eligible": eligible,
                "selected": selected_now,
            }
        )
        print(
            f"epoch {epoch:03d} league={league_metrics['loss']:.6f} "
            f"league_policy={league_metrics['policyTop1']:.3f} "
            f"stability={stability_metrics['loss']:.6f} "
            f"tactical_neg={tactical_metrics['negativeTop1Rate']:.3f} "
            f"regressions={failure_count} eligible={eligible} selected={selected_now}"
        )

    model.load_state_dict(selected_state)
    checkpoint_out = output_dir / "katacat-m37.pt"
    if selected_epoch == 0:
        shutil.copyfile(checkpoint_path, checkpoint_out)
    else:
        save_checkpoint(
            checkpoint_out,
            model,
            base_checkpoint,
            selected_epoch,
            args.commit_sha,
            args.trainable_trunk_blocks,
        )
    selected_sha = sha256_file(checkpoint_out)
    parent_sha = sha256_file(checkpoint_path)

    acceptance = {
        "initializedFromM341": True,
        "freshLeagueSourcePresent": len(league_rows) >= 1000,
        "gameSplitDisjoint": not bool(train_games.intersection(validation_games)),
        "frozenPrefixUnchanged": selected_parameter_sha(model, args.trainable_trunk_blocks)
        == frozen_sha,
        "allEpochCheckpointsSaved": len(list(epoch_dir.glob("epoch-*.pt")))
        == args.epochs + 1,
        "candidateCheckpointSaved": checkpoint_out.is_file(),
        "checkpointSha256Recorded": len(selected_sha) == 64,
        "selectedStabilityFinite": finite_general(selected_stability),
        "selectedLeagueFinite": finite_general(selected_league),
        "selectedTacticalRegressionFailuresZero": len(selected_failures) == 0,
        "noRandomRollouts": True,
        "passed": False,
    }
    acceptance["passed"] = all(
        value for key, value in acceptance.items() if key != "passed"
    )
    if not all(math.isfinite(float(value)) for value in selected_rank):
        raise ValueError("M3.7 selected rank contains non-finite values")

    summary = {
        "schemaVersion": 1,
        "stage": "M3.7_FRESH_LEAGUE_RETRAIN",
        "commit_sha": args.commit_sha,
        "device": str(device),
        "encodingVersion": "PLAYER_RELATIVE_V1",
        "parent_checkpoint_sha256": parent_sha,
        "selected_checkpoint_sha256": selected_sha,
        "selected_epoch": selected_epoch,
        "improved_over_parent": selected_epoch > 0,
        "behaviorEquivalentToParent": selected_epoch == 0,
        "trainableScope": f"LAST_{args.trainable_trunk_blocks}_TRUNK_BLOCKS_AND_ALL_HEADS",
        "trainableParameterNames": trainable_names,
        "trainableParameters": sum(
            parameter.numel() for parameter in model.parameters() if parameter.requires_grad
        ),
        "sourceSamples": {
            "league": len(league_rows),
            **{name: len(rows) for name, rows in stability_sources.items()},
            "hardNegative": len(hard_rows),
        },
        "trainSamples": len(train_samples),
        "freshLeagueValidationSamples": len(league_validation),
        "stabilityValidationSamples": len(stability_validation),
        "frozenTacticalValidationSamples": len(hard_validation),
        "balance": {
            "league": league_balance,
            "stability": stability_balance,
            "hardNegative": hard_balance,
        },
        "samplingWeights": {
            "league": args.league_sampling_weight,
            "stability": args.stability_sampling_weight,
            "hardNegative": args.hard_sampling_weight,
        },
        "parent": {
            "freshLeagueValidation": parent_league,
            "stabilityValidation": parent_stability,
            "frozenTacticalValidation": parent_tactical,
        },
        "selected": {
            "freshLeagueValidation": selected_league,
            "stabilityValidation": selected_stability,
            "frozenTacticalValidation": {
                **selected_tactical,
                "regressionFailuresVsParent": len(selected_failures),
                "regressionFailureDetails": selected_failures,
            },
        },
        "selectionPolicy": {
            "parentIsEpochZero": True,
            "requiresFreshLeagueLossImprovement": args.league_loss_min_delta,
            "requiresStabilityBounds": True,
            "requiresFrozenTacticalRegressionFailuresZero": True,
            "requiresFrozenPrefixByteStability": True,
        },
        "lossWeights": {
            "policy": 1.0,
            "value": args.value_weight,
            "score": args.score_weight,
            "ownership": args.ownership_weight,
            "hardPairwise": args.hard_pairwise_weight,
            "policyDistill": args.policy_distill_weight,
            "valueDistill": args.value_distill_weight,
            "scoreDistill": args.score_distill_weight,
            "ownershipDistill": args.ownership_distill_weight,
        },
        "acceptance": acceptance,
        "epochHistory": history,
        "note": (
            "M3.7 uses a new game-level league source rather than repeatedly fitting the old hard-negative subset. "
            "Only the final residual trunk blocks and the four existing heads are trainable. Frozen M3.3 replay "
            "is used for output distillation, while an independent hard-negative validation set remains a strict guard."
        ),
    }
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({
        "selectedEpoch": selected_epoch,
        "improvedOverParent": selected_epoch > 0,
        "checkpointSha256": selected_sha,
        "acceptance": acceptance,
    }))


if __name__ == "__main__":
    main()
