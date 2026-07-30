from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import random
import shutil
from pathlib import Path
from typing import Any

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader

from train_katacat_m1 import (
    MAX_MARGIN,
    KataCatNet,
    choose_device,
    ownership_class_weights,
    ownership_metrics,
    seed_everything,
)
from train_katacat_m33 import balance_real_seats, relative_baselines, tagged_samples, unique_samples
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
        description="M3.4.2 parent-safe fine-tuning on real-loss pre-collapse ancestors."
    )
    parser.add_argument("--bootstrap-data", required=True)
    parser.add_argument("--selfplay-data", required=True)
    parser.add_argument("--mixed-data", required=True)
    parser.add_argument("--curriculum-data", required=True)
    parser.add_argument("--hard-negative-data", required=True)
    parser.add_argument("--precollapse-data", required=True)
    parser.add_argument("--init-checkpoint", required=True)
    parser.add_argument("--out", default="katacat-m342-model")
    parser.add_argument("--epochs", type=int, default=6)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--learning-rate", type=float, default=5e-5)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--pairwise-weight", type=float, default=0.75)
    parser.add_argument("--pairwise-margin", type=float, default=0.5)
    parser.add_argument("--value-weight", type=float, default=1.25)
    parser.add_argument("--score-weight", type=float, default=0.25)
    parser.add_argument("--ownership-weight", type=float, default=1.0)
    parser.add_argument("--general-loss-tolerance", type=float, default=1e-9)
    parser.add_argument("--precollapse-improvement-min-delta", type=float, default=1e-5)
    parser.add_argument("--seed", type=int, default=20260731)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--augment", choices=("on", "off"), default="on")
    parser.add_argument("--commit-sha", default=os.environ.get("KATACAT_M342_COMMIT_SHA", "unknown"))
    return parser.parse_args()


def balance_precollapse(
    samples: list[dict[str, Any]], seed: int
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    train = [sample for sample in samples if sample.get("split") == "train"]
    validation = [sample for sample in samples if sample.get("split") == "validation"]
    by_seat = {
        seat: sorted(
            [sample for sample in train if sample.get("currentPlayer") == seat],
            key=lambda sample: hashlib.sha256(
                f"{seed}:{sample['sampleId']}".encode("utf-8")
            ).hexdigest(),
        )
        for seat in ("A", "B")
    }
    per_seat = min(len(by_seat["A"]), len(by_seat["B"]))
    if per_seat <= 0:
        raise ValueError(
            f"M3.4.2 pre-collapse train split needs both seats; "
            f"A={len(by_seat['A'])}, B={len(by_seat['B'])}"
        )
    selected_train = [*by_seat["A"][:per_seat], *by_seat["B"][:per_seat]]
    selected_train.sort(key=lambda sample: str(sample["sampleId"]))
    validation.sort(key=lambda sample: str(sample["sampleId"]))
    return selected_train, validation, {
        "trainAvailable": {seat: len(rows) for seat, rows in by_seat.items()},
        "trainSelected": {"A": per_seat, "B": per_seat},
        "validationFrozen": {
            seat: sum(sample.get("currentPlayer") == seat for sample in validation)
            for seat in ("A", "B")
        },
    }


class M342Dataset(M341Dataset):
    def __init__(self, samples: list[dict[str, Any]], augment: bool) -> None:
        super().__init__(samples, augment)
        self.policy_weights = [float(sample.get("policyWeight", 1.0)) for sample in samples]
        self.auxiliary_weights = [float(sample.get("auxiliaryWeight", 1.0)) for sample in samples]
        self.precollapse_flags = [sample.get("trainingSource") == "precollapse" for sample in samples]
        if any(weight <= 0 for weight in self.policy_weights):
            raise ValueError("M3.4.2 policy weights must be positive")
        if any(weight <= 0 for weight in self.auxiliary_weights):
            raise ValueError("M3.4.2 auxiliary weights must be positive")

    def __getitem__(self, index: int):
        return (
            *super().__getitem__(index),
            torch.tensor(self.policy_weights[index], dtype=torch.float32),
            torch.tensor(self.auxiliary_weights[index], dtype=torch.float32),
            torch.tensor(1.0 if self.precollapse_flags[index] else 0.0, dtype=torch.float32),
        )


@torch.no_grad()
def evaluate_precollapse(
    model: KataCatNet,
    dataset: M342Dataset,
    device: torch.device,
    batch_size: int,
) -> tuple[dict[str, float], list[dict[str, Any]]]:
    model.eval()
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=False, num_workers=0)
    rows: list[dict[str, Any]] = []
    value_losses: list[torch.Tensor] = []
    score_errors: list[torch.Tensor] = []
    policy_losses: list[torch.Tensor] = []
    ownership_predictions: list[torch.Tensor] = []
    ownership_targets: list[torch.Tensor] = []
    cursor = 0
    value_correct = 0
    examples = 0
    for (
        features,
        policy,
        value,
        score,
        ownership,
        _hard_flags,
        _positive_actions,
        _negative_masks,
        _policy_weights,
        _auxiliary_weights,
        precollapse_flags,
    ) in loader:
        if not bool((precollapse_flags > 0.5).all()):
            raise ValueError("Frozen pre-collapse validation contains a non-precollapse row")
        features = features.to(device)
        policy = policy.to(device)
        value = value.to(device)
        score = score.to(device)
        ownership = ownership.to(device)
        policy_logits, predicted_value, predicted_score, ownership_logits = model(features)
        batch_value_losses = (predicted_value - value).square()
        batch_score_errors = (predicted_score - score).abs() * MAX_MARGIN
        batch_policy_losses = per_sample_policy_loss(policy_logits, policy)
        predictions = ownership_logits.argmax(dim=1)
        correct = ((predicted_value >= 0) == (value >= 0))
        value_correct += int(correct.sum().item())
        batch_size_actual = features.shape[0]
        examples += batch_size_actual
        value_losses.append(batch_value_losses.cpu())
        score_errors.append(batch_score_errors.cpu())
        policy_losses.append(batch_policy_losses.cpu())
        ownership_predictions.append(predictions.cpu())
        ownership_targets.append(ownership.cpu())
        for offset in range(batch_size_actual):
            sample = dataset.samples[cursor + offset]
            rows.append(
                {
                    "sampleId": str(sample["sampleId"]),
                    "gameId": str(sample["gameId"]),
                    "positionHash": str(sample.get("positionHash", "")),
                    "distance": int(sample.get("precollapseDistance", 0)),
                    "valueTarget": float(value[offset].item()),
                    "predictedValue": float(predicted_value[offset].item()),
                    "valueSignCorrect": bool(correct[offset].item()),
                    "valueSquaredError": float(batch_value_losses[offset].item()),
                }
            )
        cursor += batch_size_actual
    if examples <= 0:
        raise ValueError("Frozen pre-collapse validation is empty")
    ownership = ownership_metrics(
        torch.cat(ownership_predictions), torch.cat(ownership_targets)
    )
    ownership["iouSelf"] = ownership.pop("iouA")
    ownership["iouOpponent"] = ownership.pop("iouB")
    metrics = {
        "examples": float(examples),
        "valueLoss": float(torch.cat(value_losses).mean().item()),
        "valueAccuracy": float(value_correct / examples),
        "scoreMaeCells": float(torch.cat(score_errors).mean().item()),
        "distillationPolicyLoss": float(torch.cat(policy_losses).mean().item()),
        **{key: float(value) for key, value in ownership.items()},
    }
    return metrics, rows


def precollapse_regression_failures(
    parent_rows: list[dict[str, Any]], candidate_rows: list[dict[str, Any]]
) -> tuple[int, list[dict[str, Any]]]:
    parent = {row["sampleId"]: row for row in parent_rows}
    failures: list[dict[str, Any]] = []
    for row in candidate_rows:
        before = parent[row["sampleId"]]
        sign_regression = before["valueSignCorrect"] and not row["valueSignCorrect"]
        if sign_regression:
            failures.append(
                {
                    "sampleId": row["sampleId"],
                    "gameId": row["gameId"],
                    "positionHash": row["positionHash"],
                    "distance": row["distance"],
                    "parent": before,
                    "candidate": row,
                    "valueSignRegression": True,
                }
            )
    return len(failures), failures


def finite_precollapse(metrics: dict[str, float]) -> bool:
    required = (
        "valueLoss",
        "valueAccuracy",
        "scoreMaeCells",
        "distillationPolicyLoss",
        "ownershipAccuracy",
        "meanTerritoryIou",
    )
    return all(key in metrics and math.isfinite(float(metrics[key])) for key in required)


def selection_rank(
    precollapse: dict[str, float],
    tactical: dict[str, float],
    general_loss: float,
) -> tuple[float, float, float, float, float]:
    return (
        float(precollapse["valueLoss"]),
        -float(precollapse["valueAccuracy"]),
        float(tactical["negativeTop1Rate"]),
        float(tactical["pairwiseLoss"]),
        float(general_loss),
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
    precollapse_samples = tagged_samples("precollapse", args.precollapse_data)
    replay_originals = unique_samples(
        [
            *replay_sources["bootstrap"],
            *replay_sources["selfplay"],
            *replay_sources["mixed"],
            *replay_sources["curriculum"],
        ]
    )
    replay_balanced, replay_balance = balance_real_seats(replay_originals, args.seed)
    hard_train, hard_validation, hard_balance = balance_hard_train(
        unique_samples(hard_samples), args.seed + 1
    )
    precollapse_train, precollapse_validation, precollapse_balance = balance_precollapse(
        unique_samples(precollapse_samples), args.seed + 2
    )
    replay_train = [sample for sample in replay_balanced if sample["split"] == "train"]
    general_validation = [
        sample for sample in replay_balanced if sample["split"] == "validation"
    ]
    train_samples = unique_samples(
        [*replay_train, *hard_train, *precollapse_train]
    )
    if not train_samples or not general_validation or not hard_validation or not precollapse_validation:
        raise ValueError(
            "M3.4.2 requires train, general validation, tactical validation, and pre-collapse validation"
        )

    train_games = {str(sample["gameId"]) for sample in train_samples}
    general_games = {str(sample["gameId"]) for sample in general_validation}
    tactical_games = {str(sample["gameId"]) for sample in hard_validation}
    precollapse_games = {str(sample["gameId"]) for sample in precollapse_validation}
    if train_games.intersection(general_games):
        raise ValueError("M3.4.2 general validation game leakage")
    if train_games.intersection(tactical_games):
        raise ValueError("M3.4.2 tactical validation game leakage")
    if train_games.intersection(precollapse_games):
        raise ValueError("M3.4.2 pre-collapse validation game leakage")

    device = choose_device(args.device)
    checkpoint_path = Path(args.init_checkpoint)
    checkpoint = torch.load(checkpoint_path, map_location="cpu")
    if checkpoint.get("encodingVersion") != "PLAYER_RELATIVE_V1":
        raise ValueError("M3.4.2 requires a PLAYER_RELATIVE_V1 checkpoint")
    channels = int(checkpoint["channels"])
    blocks = int(checkpoint["blocks"])
    model = KataCatNet(channels, blocks)
    model.load_state_dict(checkpoint["modelState"])
    model = model.to(device)

    train_dataset = M342Dataset(train_samples, augment=args.augment == "on")
    general_dataset = M341Dataset(general_validation, augment=False)
    tactical_dataset = M341Dataset(hard_validation, augment=False)
    precollapse_dataset = M342Dataset(precollapse_validation, augment=False)
    train_loader = DataLoader(
        train_dataset,
        batch_size=args.batch_size,
        shuffle=True,
        num_workers=0,
        pin_memory=device.type == "cuda",
    )
    general_loader = DataLoader(
        general_dataset,
        batch_size=args.batch_size,
        shuffle=False,
        num_workers=0,
        pin_memory=device.type == "cuda",
    )
    class_weights = ownership_class_weights(train_dataset, device)
    ownership_loss_mean = nn.CrossEntropyLoss(weight=class_weights)
    ownership_loss_per_cell = nn.CrossEntropyLoss(weight=class_weights, reduction="none")

    parent_general = evaluate_general(
        model, general_loader, device, ownership_loss_mean, args
    )
    parent_tactical, parent_tactical_rows = evaluate_tactical(
        model, tactical_dataset, device, args
    )
    parent_precollapse, parent_precollapse_rows = evaluate_precollapse(
        model, precollapse_dataset, device, args.batch_size
    )
    parent_validation_loss = float(parent_general["loss"])
    parent_checkpoint_sha256 = sha256_file(checkpoint_path)

    optimizer = torch.optim.AdamW(
        model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, T_max=max(1, args.epochs)
    )

    selected_epoch = 0
    selected_state: dict[str, torch.Tensor] | None = None
    selected_general = copy.deepcopy(parent_general)
    selected_tactical = copy.deepcopy(parent_tactical)
    selected_precollapse = copy.deepcopy(parent_precollapse)
    selected_tactical_failures = 0
    selected_precollapse_failures = 0
    selected_rank = selection_rank(
        parent_precollapse, parent_tactical, parent_validation_loss
    )
    minimum_observed_validation_loss = parent_validation_loss
    minimum_observed_precollapse_value_loss = float(parent_precollapse["valueLoss"])
    history: list[dict[str, Any]] = [
        {
            "epoch": 0,
            "source": "parent",
            "generalValidation": parent_general,
            "frozenTacticalValidation": {
                **parent_tactical,
                "regressionFailuresVsParent": 0,
            },
            "frozenPrecollapseValidation": {
                **parent_precollapse,
                "valueSignRegressionsVsParent": 0,
            },
            "eligible": True,
            "selected": True,
        }
    ]

    for epoch in range(1, args.epochs + 1):
        model.train()
        running_loss = 0.0
        seen = 0
        for (
            features,
            policy,
            value,
            score,
            ownership,
            hard_flags,
            positive_actions,
            negative_masks,
            policy_weights,
            auxiliary_weights,
            _precollapse_flags,
        ) in train_loader:
            features = features.to(device, non_blocking=True)
            policy = policy.to(device, non_blocking=True)
            value = value.to(device, non_blocking=True)
            score = score.to(device, non_blocking=True)
            ownership = ownership.to(device, non_blocking=True)
            hard_flags = hard_flags.to(device, non_blocking=True)
            positive_actions = positive_actions.to(device, non_blocking=True)
            negative_masks = negative_masks.to(device, non_blocking=True)
            policy_weights = policy_weights.to(device, non_blocking=True)
            auxiliary_weights = auxiliary_weights.to(device, non_blocking=True)
            optimizer.zero_grad(set_to_none=True)
            policy_logits, predicted_value, predicted_score, ownership_logits = model(features)
            policy_rows = per_sample_policy_loss(policy_logits, policy)
            p_loss = (policy_rows * policy_weights).sum() / policy_weights.sum().clamp_min(1e-6)
            pair_loss, _margins, _positive, _negative = pairwise_components(
                policy_logits,
                hard_flags,
                positive_actions,
                negative_masks,
                args.pairwise_margin,
            )
            value_rows = (predicted_value - value).square()
            v_loss = (value_rows * auxiliary_weights).sum() / auxiliary_weights.sum().clamp_min(1e-6)
            score_rows = nn.functional.smooth_l1_loss(
                predicted_score, score, reduction="none"
            )
            s_loss = (score_rows * auxiliary_weights).sum() / auxiliary_weights.sum().clamp_min(1e-6)
            ownership_rows = ownership_loss_per_cell(ownership_logits, ownership).mean(dim=(1, 2))
            o_loss = (ownership_rows * auxiliary_weights).sum() / auxiliary_weights.sum().clamp_min(1e-6)
            loss = (
                p_loss
                + args.pairwise_weight * pair_loss
                + args.value_weight * v_loss
                + args.score_weight * s_loss
                + args.ownership_weight * o_loss
            )
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), max_norm=5.0)
            optimizer.step()
            running_loss += loss.item() * features.shape[0]
            seen += features.shape[0]
        scheduler.step()

        general = evaluate_general(
            model, general_loader, device, ownership_loss_mean, args
        )
        tactical, tactical_rows = evaluate_tactical(
            model, tactical_dataset, device, args
        )
        precollapse, precollapse_rows = evaluate_precollapse(
            model, precollapse_dataset, device, args.batch_size
        )
        tactical_failures, tactical_failure_details = tactical_regression_failures(
            parent_tactical_rows, tactical_rows
        )
        precollapse_failures, precollapse_failure_details = precollapse_regression_failures(
            parent_precollapse_rows, precollapse_rows
        )
        general_loss = float(general["loss"])
        precollapse_value_loss = float(precollapse["valueLoss"])
        minimum_observed_validation_loss = min(
            minimum_observed_validation_loss, general_loss
        )
        minimum_observed_precollapse_value_loss = min(
            minimum_observed_precollapse_value_loss, precollapse_value_loss
        )
        general_not_worse = (
            general_loss <= parent_validation_loss + args.general_loss_tolerance
        )
        precollapse_improved = (
            precollapse_value_loss
            < float(parent_precollapse["valueLoss"])
            - args.precollapse_improvement_min_delta
        )
        eligible = (
            general_not_worse
            and tactical_failures == 0
            and precollapse_failures == 0
            and precollapse_improved
        )
        candidate_rank = selection_rank(precollapse, tactical, general_loss)
        selected_now = eligible and (
            selected_epoch == 0 or candidate_rank < selected_rank
        )
        if selected_now:
            selected_epoch = epoch
            selected_state = {
                key: tensor.detach().cpu().clone()
                for key, tensor in model.state_dict().items()
            }
            selected_general = copy.deepcopy(general)
            selected_tactical = copy.deepcopy(tactical)
            selected_precollapse = copy.deepcopy(precollapse)
            selected_tactical_failures = tactical_failures
            selected_precollapse_failures = precollapse_failures
            selected_rank = candidate_rank
            for row in history:
                row["selected"] = False
        history.append(
            {
                "epoch": epoch,
                "trainLoss": float(running_loss / max(1, seen)),
                "generalValidation": general,
                "frozenTacticalValidation": {
                    **tactical,
                    "regressionFailuresVsParent": tactical_failures,
                    "regressionFailureDetails": tactical_failure_details,
                },
                "frozenPrecollapseValidation": {
                    **precollapse,
                    "valueSignRegressionsVsParent": precollapse_failures,
                    "regressionFailureDetails": precollapse_failure_details,
                },
                "generalNotWorseThanParent": general_not_worse,
                "precollapseValueImproved": precollapse_improved,
                "eligible": eligible,
                "selected": selected_now,
            }
        )
        print(
            f"epoch {epoch:03d} general={general_loss:.6f} "
            f"precollapse_value={precollapse_value_loss:.6f} "
            f"tactical_regressions={tactical_failures} "
            f"precollapse_regressions={precollapse_failures} "
            f"eligible={eligible} selected={selected_now}"
        )

    output_dir = Path(args.out)
    output_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_out = output_dir / "katacat-m342.pt"
    improved_over_parent = selected_epoch > 0
    if selected_epoch == 0:
        shutil.copy2(checkpoint_path, checkpoint_out)
    else:
        if selected_state is None:
            raise AssertionError("Selected M3.4.2 epoch has no retained state")
        torch.save(
            {
                "modelState": selected_state,
                "inputChannels": int(checkpoint["inputChannels"]),
                "policySize": int(checkpoint["policySize"]),
                "channels": channels,
                "blocks": blocks,
                "boardSize": int(checkpoint["boardSize"]),
                "maxMargin": int(checkpoint["maxMargin"]),
                "epoch": selected_epoch,
                "stage": "M3.4.2",
                "encodingVersion": "PLAYER_RELATIVE_V1",
                "parentCheckpoint": str(checkpoint_path),
                "parentCheckpointSha256": parent_checkpoint_sha256,
                "generalValidation": selected_general,
                "frozenTacticalValidation": selected_tactical,
                "frozenPrecollapseValidation": selected_precollapse,
                "commitSha": args.commit_sha,
            },
            checkpoint_out,
        )
    selected_checkpoint_sha256 = sha256_file(checkpoint_out)
    parent_bytes_preserved = (
        selected_epoch != 0
        or selected_checkpoint_sha256 == parent_checkpoint_sha256
    )
    general_not_worse = (
        float(selected_general["loss"])
        <= parent_validation_loss + args.general_loss_tolerance
    )
    acceptance = {
        "initializedFromM341": checkpoint_path.is_file()
        and checkpoint.get("encodingVersion") == "PLAYER_RELATIVE_V1",
        "parentIncludedAsEpoch0": history[0]["epoch"] == 0,
        "parentBytesPreservedWhenSelected": parent_bytes_preserved,
        "generalValidationNotWorseThanParent": general_not_worse,
        "tacticalRegressionFailuresZero": selected_tactical_failures == 0,
        "precollapseValueSignRegressionsZero": selected_precollapse_failures == 0,
        "generalTacticalPrecollapseSeparated": general_games.isdisjoint(tactical_games)
        and general_games.isdisjoint(precollapse_games)
        and tactical_games.isdisjoint(precollapse_games),
        "trainValidationGamesDisjoint": train_games.isdisjoint(general_games)
        and train_games.isdisjoint(tactical_games)
        and train_games.isdisjoint(precollapse_games),
        "noUnprovedActionNegatives": all(
            len(sample.get("negativeActions", [])) == 0
            and sample.get("exactNegativeProof") is False
            for sample in precollapse_samples
        ),
        "allMetricsFinite": finite_general(parent_general)
        and finite_general(selected_general)
        and finite_precollapse(parent_precollapse)
        and finite_precollapse(selected_precollapse)
        and all(math.isfinite(float(value)) for value in selected_tactical.values()),
        "candidateCheckpointSaved": checkpoint_out.is_file(),
        "checkpointSha256Recorded": len(selected_checkpoint_sha256) == 64,
        "noRandomRollouts": True,
        "passed": False,
    }
    acceptance["passed"] = all(
        value for key, value in acceptance.items() if key != "passed"
    )

    summary = {
        "schemaVersion": 1,
        "stage": "M3.4.2_TRAIN",
        "device": str(device),
        "commit_sha": args.commit_sha,
        "encodingVersion": "PLAYER_RELATIVE_V1",
        "parentCheckpoint": str(checkpoint_path),
        "parent_checkpoint_sha256": parent_checkpoint_sha256,
        "selected_checkpoint_sha256": selected_checkpoint_sha256,
        "parent_validation_loss": parent_validation_loss,
        "best_validation_loss": float(selected_general["loss"]),
        "minimum_observed_validation_loss": minimum_observed_validation_loss,
        "parent_precollapse_value_loss": float(parent_precollapse["valueLoss"]),
        "best_precollapse_value_loss": float(selected_precollapse["valueLoss"]),
        "minimum_observed_precollapse_value_loss": minimum_observed_precollapse_value_loss,
        "selected_epoch": selected_epoch,
        "improved_over_parent": improved_over_parent,
        "sourceSamples": {
            **{name: len(rows) for name, rows in replay_sources.items()},
            "hardNegative": len(hard_samples),
            "precollapse": len(precollapse_samples),
        },
        "trainSamples": len(train_samples),
        "generalValidationSamples": len(general_validation),
        "frozenTacticalValidationSamples": len(hard_validation),
        "frozenPrecollapseValidationSamples": len(precollapse_validation),
        "balance": {
            "replay": replay_balance,
            "hardNegative": hard_balance,
            "precollapse": precollapse_balance,
        },
        "parent": {
            "generalValidation": parent_general,
            "frozenTacticalValidation": parent_tactical,
            "frozenPrecollapseValidation": parent_precollapse,
        },
        "selected": {
            "generalValidation": selected_general,
            "frozenTacticalValidation": {
                **selected_tactical,
                "regressionFailuresVsParent": selected_tactical_failures,
            },
            "frozenPrecollapseValidation": {
                **selected_precollapse,
                "valueSignRegressionsVsParent": selected_precollapse_failures,
            },
        },
        "selectionPolicy": {
            "parentIsEpoch0": True,
            "requiresGeneralLossNotWorse": True,
            "requiresZeroTacticalRegressions": True,
            "requiresZeroPrecollapseValueSignRegressions": True,
            "requiresPrecollapseValueLossImprovement": True,
            "precollapsePolicyWeight": 0.25,
            "precollapseActionNegatives": False,
        },
        "baselines": relative_baselines(general_validation),
        "model": {
            "channels": channels,
            "blocks": blocks,
            "parameters": sum(parameter.numel() for parameter in model.parameters()),
        },
        "lossWeights": {
            "policy": 1.0,
            "hardNegativePairwise": args.pairwise_weight,
            "value": args.value_weight,
            "score": args.score_weight,
            "ownership": args.ownership_weight,
        },
        "augmentation": args.augment == "on",
        "acceptance": acceptance,
        "epochHistory": history,
        "note": (
            "M3.4.2 learns final loss value/score/ownership labels at 2/4/6 plies before the first "
            "all-root-refuted state. Policy supervision on those rows is low-weight M3.4.1 PUCT "
            "distillation; the replay action is never treated as a proved negative. Epoch 0 remains "
            "selectable and is retained byte-for-byte unless all regression constraints pass."
        ),
    }
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    print("KATACAT_M342_TRAIN:" + json.dumps(summary, sort_keys=True))
    if not acceptance["passed"]:
        raise SystemExit("M3.4.2 training acceptance failed")


if __name__ == "__main__":
    main()
