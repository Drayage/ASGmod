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
from torch.utils.data import DataLoader, Dataset

from katacat_m33_relative import relative_featurize, relative_ownership_target
from train_katacat_m1 import (
    MAX_MARGIN,
    POLICY_SIZE,
    KataCatNet,
    apply_symmetry,
    choose_device,
    load_jsonl,
    ownership_class_weights,
    ownership_metrics,
    policy_target,
    score_target,
    seed_everything,
    value_target,
)
from train_katacat_m33 import balance_real_seats, relative_baselines, tagged_samples, unique_samples


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="M3.4.1 parent-safe fine-tuning with separate general and frozen tactical validation."
    )
    parser.add_argument("--bootstrap-data", required=True)
    parser.add_argument("--selfplay-data", required=True)
    parser.add_argument("--mixed-data", required=True)
    parser.add_argument("--curriculum-data", required=True)
    parser.add_argument("--hard-negative-data", required=True)
    parser.add_argument("--init-checkpoint", required=True)
    parser.add_argument("--out", default="katacat-m341-model")
    parser.add_argument("--epochs", type=int, default=6)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--learning-rate", type=float, default=7.5e-5)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--pairwise-weight", type=float, default=0.75)
    parser.add_argument("--pairwise-margin", type=float, default=0.5)
    parser.add_argument("--value-weight", type=float, default=1.0)
    parser.add_argument("--score-weight", type=float, default=0.25)
    parser.add_argument("--ownership-weight", type=float, default=1.0)
    parser.add_argument("--general-loss-tolerance", type=float, default=1e-9)
    parser.add_argument("--general-improvement-min-delta", type=float, default=1e-6)
    parser.add_argument("--seed", type=int, default=20260730)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--augment", choices=("on", "off"), default="on")
    parser.add_argument("--commit-sha", default=os.environ.get("KATACAT_M341_COMMIT_SHA", "unknown"))
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def balance_hard_train(
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
            f"M3.4.1 hard-negative train split needs both seats; "
            f"A={len(by_seat['A'])}, B={len(by_seat['B'])}"
        )
    balanced_train = [*by_seat["A"][:per_seat], *by_seat["B"][:per_seat]]
    balanced_train.sort(key=lambda sample: str(sample["sampleId"]))
    validation.sort(key=lambda sample: str(sample["sampleId"]))
    return balanced_train, validation, {
        "trainAvailable": {seat: len(rows) for seat, rows in by_seat.items()},
        "trainSelected": {"A": per_seat, "B": per_seat},
        "validationFrozen": {
            seat: sum(sample.get("currentPlayer") == seat for sample in validation)
            for seat in ("A", "B")
        },
    }


class M341Dataset(
    Dataset[
        tuple[
            torch.Tensor,
            torch.Tensor,
            torch.Tensor,
            torch.Tensor,
            torch.Tensor,
            torch.Tensor,
            torch.Tensor,
            torch.Tensor,
        ]
    ]
):
    def __init__(self, samples: list[dict[str, Any]], augment: bool) -> None:
        self.samples = samples
        self.augment = augment
        self.features = [relative_featurize(sample) for sample in samples]
        self.policies = [policy_target(sample) for sample in samples]
        self.ownership = [relative_ownership_target(sample) for sample in samples]
        self.values = [value_target(sample) for sample in samples]
        self.scores = [score_target(sample) for sample in samples]
        self.hard_negative = [sample.get("trainingSource") == "hardNegative" for sample in samples]
        self.positive_actions: list[int] = []
        self.negative_masks: list[np.ndarray] = []
        for sample, policy, is_hard in zip(
            samples, self.policies, self.hard_negative, strict=True
        ):
            positive = int(sample.get("positiveAction", int(policy.argmax())))
            if not 0 <= positive < POLICY_SIZE:
                raise ValueError(f"Invalid positiveAction in {sample.get('sampleId')}: {positive}")
            negative_mask = np.zeros(POLICY_SIZE, dtype=np.float32)
            for action in sample.get("negativeActions", []):
                index = int(action)
                if not 0 <= index < POLICY_SIZE:
                    raise ValueError(
                        f"Invalid negative action in {sample.get('sampleId')}: {index}"
                    )
                negative_mask[index] = 1.0
            if is_hard and negative_mask.sum() <= 0:
                raise ValueError(
                    f"Hard-negative sample {sample.get('sampleId')} has no negatives"
                )
            if negative_mask[positive] > 0:
                raise ValueError(
                    f"Positive action is also negative in {sample.get('sampleId')}"
                )
            self.positive_actions.append(positive)
            self.negative_masks.append(negative_mask)

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(
        self, index: int
    ) -> tuple[
        torch.Tensor,
        torch.Tensor,
        torch.Tensor,
        torch.Tensor,
        torch.Tensor,
        torch.Tensor,
        torch.Tensor,
        torch.Tensor,
    ]:
        features = self.features[index]
        policy = self.policies[index]
        ownership = self.ownership[index]
        negative_mask = self.negative_masks[index]
        positive_vector = np.zeros(POLICY_SIZE, dtype=np.float32)
        positive_vector[self.positive_actions[index]] = 1.0
        if self.augment:
            symmetry = random.randrange(8)
            features, policy, ownership = apply_symmetry(
                features, policy, ownership, symmetry
            )
            _, negative_mask, _ = apply_symmetry(
                self.features[index], negative_mask, self.ownership[index], symmetry
            )
            _, positive_vector, _ = apply_symmetry(
                self.features[index], positive_vector, self.ownership[index], symmetry
            )
        return (
            torch.from_numpy(features.copy()),
            torch.from_numpy(policy.copy()),
            torch.tensor(self.values[index], dtype=torch.float32),
            torch.tensor(self.scores[index], dtype=torch.float32),
            torch.from_numpy(ownership.copy()),
            torch.tensor(1.0 if self.hard_negative[index] else 0.0, dtype=torch.float32),
            torch.tensor(int(positive_vector.argmax()), dtype=torch.long),
            torch.from_numpy(negative_mask.copy()).bool(),
        )


def per_sample_policy_loss(logits: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    return -(target * torch.log_softmax(logits, dim=1)).sum(dim=1)


def pairwise_components(
    logits: torch.Tensor,
    hard_flags: torch.Tensor,
    positive_actions: torch.Tensor,
    negative_masks: torch.Tensor,
    margin: float,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
    valid = torch.logical_and(hard_flags > 0.5, negative_masks.any(dim=1))
    if not bool(valid.any()):
        empty = torch.empty(0, device=logits.device)
        return logits.sum() * 0.0, empty, empty.bool(), empty.bool()
    selected_logits = logits[valid]
    selected_positive = positive_actions[valid]
    selected_negative_masks = negative_masks[valid]
    positive_logits = selected_logits.gather(
        1, selected_positive.unsqueeze(1)
    ).squeeze(1)
    negative_logits = selected_logits.masked_fill(
        ~selected_negative_masks, -1e9
    ).max(dim=1).values
    margins = positive_logits - negative_logits
    predictions = selected_logits.argmax(dim=1)
    positive_top1 = predictions == selected_positive
    negative_top1 = selected_negative_masks.gather(
        1, predictions.unsqueeze(1)
    ).squeeze(1)
    loss = nn.functional.softplus(float(margin) - margins).mean()
    return loss, margins, positive_top1, negative_top1


@torch.no_grad()
def evaluate_general(
    model: KataCatNet,
    loader: DataLoader,
    device: torch.device,
    ownership_loss: nn.CrossEntropyLoss,
    args: argparse.Namespace,
) -> dict[str, float]:
    model.eval()
    examples = 0
    total_loss = 0.0
    policy_loss_total = 0.0
    value_loss_total = 0.0
    score_loss_total = 0.0
    ownership_loss_total = 0.0
    policy_correct = 0
    value_correct = 0
    score_errors: list[torch.Tensor] = []
    ownership_predictions: list[torch.Tensor] = []
    ownership_targets: list[torch.Tensor] = []

    for (
        features,
        policy,
        value,
        score,
        ownership,
        _hard_flags,
        _positive_actions,
        _negative_masks,
    ) in loader:
        features = features.to(device)
        policy = policy.to(device)
        value = value.to(device)
        score = score.to(device)
        ownership = ownership.to(device)
        policy_logits, predicted_value, predicted_score, ownership_logits = model(features)
        p_loss = per_sample_policy_loss(policy_logits, policy).mean()
        v_loss = nn.functional.mse_loss(predicted_value, value)
        s_loss = nn.functional.smooth_l1_loss(predicted_score, score)
        o_loss = ownership_loss(ownership_logits, ownership)
        loss = (
            p_loss
            + args.value_weight * v_loss
            + args.score_weight * s_loss
            + args.ownership_weight * o_loss
        )
        batch_size = features.shape[0]
        examples += batch_size
        total_loss += loss.item() * batch_size
        policy_loss_total += p_loss.item() * batch_size
        value_loss_total += v_loss.item() * batch_size
        score_loss_total += s_loss.item() * batch_size
        ownership_loss_total += o_loss.item() * batch_size
        policy_correct += (
            policy_logits.argmax(dim=1) == policy.argmax(dim=1)
        ).sum().item()
        value_correct += ((predicted_value >= 0) == (value >= 0)).sum().item()
        score_errors.append((predicted_score - score).abs().cpu() * MAX_MARGIN)
        ownership_predictions.append(ownership_logits.argmax(dim=1).cpu())
        ownership_targets.append(ownership.cpu())

    if examples <= 0:
        raise ValueError("Cannot evaluate empty M3.4.1 general validation loader")
    prediction = torch.cat(ownership_predictions)
    target = torch.cat(ownership_targets)
    metrics = ownership_metrics(prediction, target)
    metrics["iouSelf"] = metrics.pop("iouA")
    metrics["iouOpponent"] = metrics.pop("iouB")
    metrics.update(
        {
            "loss": total_loss / examples,
            "policyLoss": policy_loss_total / examples,
            "policyTop1": policy_correct / examples,
            "valueLoss": value_loss_total / examples,
            "valueAccuracy": value_correct / examples,
            "scoreLoss": score_loss_total / examples,
            "scoreMaeCells": float(torch.cat(score_errors).mean().item()),
            "ownershipLoss": ownership_loss_total / examples,
            "examples": float(examples),
        }
    )
    return {key: float(value) for key, value in metrics.items()}


@torch.no_grad()
def evaluate_tactical(
    model: KataCatNet,
    dataset: M341Dataset,
    device: torch.device,
    args: argparse.Namespace,
) -> tuple[dict[str, float], list[dict[str, Any]]]:
    model.eval()
    loader = DataLoader(dataset, batch_size=args.batch_size, shuffle=False, num_workers=0)
    rows: list[dict[str, Any]] = []
    cursor = 0
    losses: list[torch.Tensor] = []
    margins_all: list[torch.Tensor] = []
    positive_all: list[torch.Tensor] = []
    negative_all: list[torch.Tensor] = []
    for (
        features,
        _policy,
        _value,
        _score,
        _ownership,
        hard_flags,
        positive_actions,
        negative_masks,
    ) in loader:
        features = features.to(device)
        hard_flags = hard_flags.to(device)
        positive_actions = positive_actions.to(device)
        negative_masks = negative_masks.to(device)
        logits = model(features)[0]
        loss, margins, positive_top1, negative_top1 = pairwise_components(
            logits,
            hard_flags,
            positive_actions,
            negative_masks,
            args.pairwise_margin,
        )
        valid_count = int((hard_flags > 0.5).sum().item())
        if valid_count != features.shape[0]:
            raise ValueError("Frozen tactical validation contains a non-hard-negative row")
        losses.append(loss.detach().repeat(max(1, valid_count)).cpu())
        margins_all.append(margins.cpu())
        positive_all.append(positive_top1.cpu())
        negative_all.append(negative_top1.cpu())
        for offset in range(valid_count):
            sample = dataset.samples[cursor + offset]
            rows.append(
                {
                    "sampleId": str(sample["sampleId"]),
                    "gameId": str(sample["gameId"]),
                    "positionHash": str(sample.get("positionHash", "")),
                    "margin": float(margins[offset].item()),
                    "positiveTop1": bool(positive_top1[offset].item()),
                    "negativeTop1": bool(negative_top1[offset].item()),
                }
            )
        cursor += valid_count
    if not rows:
        raise ValueError("Frozen tactical validation is empty")
    margins = torch.cat(margins_all)
    positive = torch.cat(positive_all)
    negative = torch.cat(negative_all)
    metrics = {
        "examples": float(len(rows)),
        "pairwiseLoss": float(torch.cat(losses).mean().item()),
        "positiveTop1": float(positive.float().mean().item()),
        "negativeTop1Rate": float(negative.float().mean().item()),
        "meanMargin": float(margins.mean().item()),
        "minimumMargin": float(margins.min().item()),
    }
    return metrics, rows


def tactical_regression_failures(
    parent_rows: list[dict[str, Any]], candidate_rows: list[dict[str, Any]]
) -> tuple[int, list[dict[str, Any]]]:
    parent = {row["sampleId"]: row for row in parent_rows}
    failures: list[dict[str, Any]] = []
    for row in candidate_rows:
        before = parent[row["sampleId"]]
        negative_regression = not before["negativeTop1"] and row["negativeTop1"]
        positive_regression = before["positiveTop1"] and not row["positiveTop1"]
        if negative_regression or positive_regression:
            failures.append(
                {
                    "sampleId": row["sampleId"],
                    "gameId": row["gameId"],
                    "positionHash": row["positionHash"],
                    "parent": before,
                    "candidate": row,
                    "negativeTop1Regression": negative_regression,
                    "positiveTop1Regression": positive_regression,
                }
            )
    return len(failures), failures


def finite_general(metrics: dict[str, float]) -> bool:
    required = (
        "loss",
        "policyLoss",
        "policyTop1",
        "valueLoss",
        "valueAccuracy",
        "scoreLoss",
        "scoreMaeCells",
        "ownershipLoss",
        "ownershipAccuracy",
        "meanTerritoryIou",
    )
    return all(key in metrics and math.isfinite(float(metrics[key])) for key in required)


def tactical_rank(metrics: dict[str, float], general_loss: float) -> tuple[float, float, float, float]:
    return (
        float(metrics["negativeTop1Rate"]),
        float(metrics["pairwiseLoss"]),
        -float(metrics["meanMargin"]),
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
    replay_train = [sample for sample in replay_balanced if sample["split"] == "train"]
    general_validation = [
        sample for sample in replay_balanced if sample["split"] == "validation"
    ]
    train_samples = unique_samples([*replay_train, *hard_train])
    if not train_samples or not general_validation or not hard_validation:
        raise ValueError(
            "M3.4.1 requires training, general validation, and frozen tactical validation"
        )

    train_games = {str(sample["gameId"]) for sample in train_samples}
    general_validation_games = {
        str(sample["gameId"]) for sample in general_validation
    }
    tactical_validation_games = {
        str(sample["gameId"]) for sample in hard_validation
    }
    if train_games.intersection(general_validation_games):
        raise ValueError("M3.4.1 general validation game leakage")
    if train_games.intersection(tactical_validation_games):
        raise ValueError("M3.4.1 frozen tactical validation game leakage")

    device = choose_device(args.device)
    checkpoint_path = Path(args.init_checkpoint)
    checkpoint = torch.load(checkpoint_path, map_location="cpu")
    if checkpoint.get("encodingVersion") != "PLAYER_RELATIVE_V1":
        raise ValueError("M3.4.1 requires a PLAYER_RELATIVE_V1 checkpoint")
    channels = int(checkpoint["channels"])
    blocks = int(checkpoint["blocks"])
    model = KataCatNet(channels, blocks)
    model.load_state_dict(checkpoint["modelState"])
    model = model.to(device)

    train_dataset = M341Dataset(train_samples, augment=args.augment == "on")
    general_validation_dataset = M341Dataset(general_validation, augment=False)
    tactical_validation_dataset = M341Dataset(hard_validation, augment=False)
    train_loader = DataLoader(
        train_dataset,
        batch_size=args.batch_size,
        shuffle=True,
        num_workers=0,
        pin_memory=device.type == "cuda",
    )
    general_validation_loader = DataLoader(
        general_validation_dataset,
        batch_size=args.batch_size,
        shuffle=False,
        num_workers=0,
        pin_memory=device.type == "cuda",
    )
    ownership_loss = nn.CrossEntropyLoss(
        weight=ownership_class_weights(train_dataset, device)
    )

    parent_general = evaluate_general(
        model, general_validation_loader, device, ownership_loss, args
    )
    parent_tactical, parent_tactical_rows = evaluate_tactical(
        model, tactical_validation_dataset, device, args
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
    selected_regression_failures = 0
    selected_failure_details: list[dict[str, Any]] = []
    selected_rank = tactical_rank(parent_tactical, parent_validation_loss)
    minimum_observed_validation_loss = parent_validation_loss
    history: list[dict[str, Any]] = [
        {
            "epoch": 0,
            "generalValidation": parent_general,
            "frozenTacticalValidation": {
                **parent_tactical,
                "regressionFailuresVsParent": 0,
            },
            "eligible": True,
            "selected": True,
            "source": "parent",
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
        ) in train_loader:
            features = features.to(device, non_blocking=True)
            policy = policy.to(device, non_blocking=True)
            value = value.to(device, non_blocking=True)
            score = score.to(device, non_blocking=True)
            ownership = ownership.to(device, non_blocking=True)
            hard_flags = hard_flags.to(device, non_blocking=True)
            positive_actions = positive_actions.to(device, non_blocking=True)
            negative_masks = negative_masks.to(device, non_blocking=True)
            optimizer.zero_grad(set_to_none=True)
            policy_logits, predicted_value, predicted_score, ownership_logits = model(
                features
            )
            p_loss = per_sample_policy_loss(policy_logits, policy).mean()
            pair_loss, _margins, _positive, _negative = pairwise_components(
                policy_logits,
                hard_flags,
                positive_actions,
                negative_masks,
                args.pairwise_margin,
            )
            v_loss = nn.functional.mse_loss(predicted_value, value)
            s_loss = nn.functional.smooth_l1_loss(predicted_score, score)
            o_loss = ownership_loss(ownership_logits, ownership)
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
            model, general_validation_loader, device, ownership_loss, args
        )
        tactical, tactical_rows = evaluate_tactical(
            model, tactical_validation_dataset, device, args
        )
        regression_failures, failure_details = tactical_regression_failures(
            parent_tactical_rows, tactical_rows
        )
        general_loss = float(general["loss"])
        minimum_observed_validation_loss = min(
            minimum_observed_validation_loss, general_loss
        )
        general_not_worse = (
            general_loss <= parent_validation_loss + args.general_loss_tolerance
        )
        general_improved = (
            general_loss
            < parent_validation_loss - args.general_improvement_min_delta
        )
        eligible = general_not_worse and general_improved and regression_failures == 0
        candidate_rank = tactical_rank(tactical, general_loss)
        selected_now = eligible and (
            selected_epoch == 0 or candidate_rank < selected_rank
        )
        if selected_now:
            selected_epoch = epoch
            selected_state = {
                key: value.detach().cpu().clone()
                for key, value in model.state_dict().items()
            }
            selected_general = copy.deepcopy(general)
            selected_tactical = copy.deepcopy(tactical)
            selected_regression_failures = regression_failures
            selected_failure_details = failure_details
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
                    "regressionFailuresVsParent": regression_failures,
                    "regressionFailureDetails": failure_details,
                },
                "generalNotWorseThanParent": general_not_worse,
                "generalImprovedOverParent": general_improved,
                "eligible": eligible,
                "selected": selected_now,
            }
        )
        print(
            f"epoch {epoch:03d} general={general_loss:.6f} "
            f"parent={parent_validation_loss:.6f} negative_top1={tactical['negativeTop1Rate']:.3f} "
            f"margin={tactical['meanMargin']:.3f} regressions={regression_failures} "
            f"eligible={eligible} selected={selected_now}"
        )

    output_dir = Path(args.out)
    output_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_out = output_dir / "katacat-m341.pt"
    improved_over_parent = selected_epoch > 0
    if selected_epoch == 0:
        shutil.copy2(checkpoint_path, checkpoint_out)
    else:
        if selected_state is None:
            raise AssertionError("Selected fine-tuned epoch has no retained state")
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
                "stage": "M3.4.1",
                "encodingVersion": "PLAYER_RELATIVE_V1",
                "parentCheckpoint": str(checkpoint_path),
                "parentCheckpointSha256": parent_checkpoint_sha256,
                "generalValidation": selected_general,
                "frozenTacticalValidation": selected_tactical,
                "commitSha": args.commit_sha,
            },
            checkpoint_out,
        )
    selected_checkpoint_sha256 = sha256_file(checkpoint_out)
    parent_bytes_preserved = (
        selected_epoch != 0
        or selected_checkpoint_sha256 == parent_checkpoint_sha256
    )

    hard_sources = {
        str(sample.get("policySource", "UNKNOWN")) for sample in hard_samples
    }
    general_loss_not_worse = (
        float(selected_general["loss"])
        <= parent_validation_loss + args.general_loss_tolerance
    )
    acceptance = {
        "initializedFromM33": checkpoint_path.is_file()
        and checkpoint.get("encodingVersion") == "PLAYER_RELATIVE_V1",
        "parentIncludedAsEpoch0": history[0]["epoch"] == 0,
        "parentBytesPreservedWhenSelected": parent_bytes_preserved,
        "generalAndTacticalValidationSeparated": set(general_validation_games).isdisjoint(
            tactical_validation_games
        ),
        "frozenTacticalValidationPresent": len(hard_validation) > 0,
        "maskedPuctPolicySourceOnly": hard_sources
        == {"TACTICAL_HARD_NEGATIVE_MASKED_PUCT"},
        "generalValidationNotWorseThanParent": general_loss_not_worse,
        "selectedTacticalRegressionFailuresZero": selected_regression_failures == 0,
        "trainGeneralGameDisjoint": train_games.isdisjoint(
            general_validation_games
        ),
        "trainTacticalGameDisjoint": train_games.isdisjoint(
            tactical_validation_games
        ),
        "allMetricsFinite": finite_general(parent_general)
        and finite_general(selected_general)
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
        "stage": "M3.4.1_TRAIN",
        "device": str(device),
        "commit_sha": args.commit_sha,
        "encodingVersion": "PLAYER_RELATIVE_V1",
        "parentCheckpoint": str(checkpoint_path),
        "parent_checkpoint_sha256": parent_checkpoint_sha256,
        "selected_checkpoint_sha256": selected_checkpoint_sha256,
        "parent_validation_loss": parent_validation_loss,
        "best_validation_loss": float(selected_general["loss"]),
        "minimum_observed_validation_loss": minimum_observed_validation_loss,
        "selected_epoch": selected_epoch,
        "improved_over_parent": improved_over_parent,
        "sourceSamples": {
            **{name: len(rows) for name, rows in replay_sources.items()},
            "hardNegative": len(hard_samples),
        },
        "trainSamples": len(train_samples),
        "generalValidationSamples": len(general_validation),
        "frozenTacticalValidationSamples": len(hard_validation),
        "games": {
            "train": len(train_games),
            "generalValidation": len(general_validation_games),
            "frozenTacticalValidation": len(tactical_validation_games),
        },
        "balance": {
            "replay": replay_balance,
            "hardNegative": hard_balance,
        },
        "parent": {
            "generalValidation": parent_general,
            "frozenTacticalValidation": parent_tactical,
        },
        "selected": {
            "generalValidation": selected_general,
            "frozenTacticalValidation": {
                **selected_tactical,
                "regressionFailuresVsParent": selected_regression_failures,
                "regressionFailureDetails": selected_failure_details,
            },
        },
        "selectionPolicy": {
            "parentIsEpoch0": True,
            "requiresStrictGeneralLossImprovement": True,
            "generalLossTolerance": args.general_loss_tolerance,
            "generalImprovementMinDelta": args.general_improvement_min_delta,
            "requiresZeroTacticalRegressions": True,
            "tacticalTieBreak": [
                "negativeTop1Rate",
                "pairwiseLoss",
                "meanMarginDescending",
                "generalLoss",
            ],
        },
        "baselines": relative_baselines(
            replay_train, general_validation
        ),
        "model": {
            "channels": channels,
            "blocks": blocks,
            "parameters": sum(parameter.numel() for parameter in model.parameters()),
        },
        "lossWeights": {
            "policy": 1.0,
            "hardNegativePairwise": args.pairwise_weight,
            "hardNegativeMargin": args.pairwise_margin,
            "value": args.value_weight,
            "score": args.score_weight,
            "ownership": args.ownership_weight,
        },
        "augmentation": args.augment == "on",
        "acceptance": acceptance,
        "epochHistory": history,
        "note": (
            "The frozen M3.3 checkpoint is epoch 0. General replay validation and the independent "
            "frozen tactical validation are evaluated separately. A fine-tuned epoch is selectable "
            "only when general validation strictly improves over the parent and no frozen tactical "
            "top-1 regression is introduced; otherwise the exact parent checkpoint bytes are copied."
        ),
    }
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, separators=(",", ":")))
    if not acceptance["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
