from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader

from katacat_m33_relative import (
    RelativeKataCatDataset,
    expand_seat_balanced,
    relative_ownership_target,
)
from train_katacat_m1 import (
    BOARD_SIZE,
    MAX_MARGIN,
    KataCatNet,
    choose_device,
    load_jsonl,
    ownership_class_weights,
    ownership_metrics,
    score_target,
    seed_everything,
    soft_policy_loss,
    value_target,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train KataCat M3.3 with player-relative features and balanced seat twins."
    )
    parser.add_argument("--bootstrap-data", required=True)
    parser.add_argument("--selfplay-data", required=True)
    parser.add_argument("--mixed-data", required=True)
    parser.add_argument("--curriculum-data", required=True)
    parser.add_argument("--out", default="katacat-m33-model")
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--channels", type=int, default=96)
    parser.add_argument("--blocks", type=int, default=8)
    parser.add_argument("--value-weight", type=float, default=1.0)
    parser.add_argument("--score-weight", type=float, default=0.25)
    parser.add_argument("--ownership-weight", type=float, default=1.0)
    parser.add_argument("--seed", type=int, default=20260730)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--augment", choices=("on", "off"), default="on")
    return parser.parse_args()


def unique_samples(samples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for sample in samples:
        sample_id = str(sample.get("sampleId", ""))
        if not sample_id:
            raise ValueError("Every M3.3 sample needs sampleId")
        if sample_id in seen:
            raise ValueError(f"Duplicate sampleId: {sample_id}")
        seen.add(sample_id)
        result.append(sample)
    return result


def required_metrics_are_finite(metrics: dict[str, float]) -> bool:
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


def evaluate(
    model: KataCatNet,
    loader: DataLoader,
    device: torch.device,
    ownership_loss: nn.CrossEntropyLoss,
    value_weight: float,
    score_weight: float,
    ownership_weight: float,
) -> dict[str, float]:
    model.eval()
    total_examples = 0
    totals = {"loss": 0.0, "policy": 0.0, "value": 0.0, "score": 0.0, "ownership": 0.0}
    policy_correct = 0
    value_correct = 0
    score_errors: list[torch.Tensor] = []
    ownership_predictions: list[torch.Tensor] = []
    ownership_targets: list[torch.Tensor] = []
    with torch.no_grad():
        for features, policy, value, score, ownership in loader:
            features = features.to(device)
            policy = policy.to(device)
            value = value.to(device)
            score = score.to(device)
            ownership = ownership.to(device)
            policy_logits, predicted_value, predicted_score, ownership_logits = model(features)
            p_loss = soft_policy_loss(policy_logits, policy)
            v_loss = nn.functional.mse_loss(predicted_value, value)
            s_loss = nn.functional.smooth_l1_loss(predicted_score, score)
            o_loss = ownership_loss(ownership_logits, ownership)
            loss = p_loss + value_weight * v_loss + score_weight * s_loss + ownership_weight * o_loss
            batch_size = features.shape[0]
            total_examples += batch_size
            totals["loss"] += loss.item() * batch_size
            totals["policy"] += p_loss.item() * batch_size
            totals["value"] += v_loss.item() * batch_size
            totals["score"] += s_loss.item() * batch_size
            totals["ownership"] += o_loss.item() * batch_size
            policy_correct += (policy_logits.argmax(dim=1) == policy.argmax(dim=1)).sum().item()
            value_correct += ((predicted_value >= 0) == (value >= 0)).sum().item()
            score_errors.append((predicted_score - score).abs().cpu() * MAX_MARGIN)
            ownership_predictions.append(ownership_logits.argmax(dim=1).cpu())
            ownership_targets.append(ownership.cpu())
    if total_examples == 0:
        raise ValueError("Cannot evaluate an empty loader")
    prediction = torch.cat(ownership_predictions)
    target = torch.cat(ownership_targets)
    metrics = ownership_metrics(prediction, target)
    # The inherited metric names iouA/iouB now mean self/opponent territory.
    metrics["iouSelf"] = metrics.pop("iouA")
    metrics["iouOpponent"] = metrics.pop("iouB")
    metrics.update(
        {
            "loss": totals["loss"] / total_examples,
            "policyLoss": totals["policy"] / total_examples,
            "policyTop1": policy_correct / total_examples,
            "valueLoss": totals["value"] / total_examples,
            "valueAccuracy": value_correct / total_examples,
            "scoreLoss": totals["score"] / total_examples,
            "scoreMaeCells": float(torch.cat(score_errors).mean().item()),
            "ownershipLoss": totals["ownership"] / total_examples,
        }
    )
    return {key: float(value) for key, value in metrics.items()}


def loader_for(samples: list[dict[str, Any]], batch_size: int) -> DataLoader:
    return DataLoader(
        RelativeKataCatDataset(samples, augment=False),
        batch_size=batch_size,
        shuffle=False,
        num_workers=0,
    )


def relative_baselines(
    train_samples: list[dict[str, Any]], validation_samples: list[dict[str, Any]]
) -> dict[str, Any]:
    train_values = [value_target(sample) for sample in train_samples]
    majority_value = 1.0 if sum(train_values) >= 0 else -1.0
    value_accuracy = float(
        np.mean([majority_value == value_target(sample) for sample in validation_samples])
    )
    zero_score_mae = float(
        np.mean([abs(score_target(sample)) * MAX_MARGIN for sample in validation_samples])
    )
    uniform_policy_nll = float(
        np.mean([math.log(max(1, len(sample["legalActions"]))) for sample in validation_samples])
    )
    targets: list[np.ndarray] = []
    neutral: list[np.ndarray] = []
    confirmed: list[np.ndarray] = []
    for sample in validation_samples:
        target = relative_ownership_target(sample)
        prediction = np.zeros_like(target)
        self_indices = sample["territoryA"] if sample["currentPlayer"] == "A" else sample["territoryB"]
        opponent_indices = sample["territoryB"] if sample["currentPlayer"] == "A" else sample["territoryA"]
        for index in self_indices:
            prediction[int(index) // BOARD_SIZE, int(index) % BOARD_SIZE] = 1
        for index in opponent_indices:
            prediction[int(index) // BOARD_SIZE, int(index) % BOARD_SIZE] = 2
        targets.append(target)
        neutral.append(np.zeros_like(target))
        confirmed.append(prediction)
    target_tensor = torch.from_numpy(np.stack(targets))
    neutral_metrics = ownership_metrics(torch.from_numpy(np.stack(neutral)), target_tensor)
    confirmed_metrics = ownership_metrics(torch.from_numpy(np.stack(confirmed)), target_tensor)
    for metrics in (neutral_metrics, confirmed_metrics):
        metrics["iouSelf"] = metrics.pop("iouA")
        metrics["iouOpponent"] = metrics.pop("iouB")
    return {
        "uniformLegalPolicy": {"policyNll": uniform_policy_nll},
        "majorityValue": {"prediction": int(majority_value), "valueAccuracy": value_accuracy},
        "zeroScore": {"scoreMaeCells": zero_score_mae},
        "neutralOwnership": neutral_metrics,
        "currentConfirmedTerritory": confirmed_metrics,
    }


def main() -> None:
    args = parse_args()
    seed_everything(args.seed)
    sources = {
        "bootstrap": load_jsonl(Path(args.bootstrap_data)),
        "selfplay": load_jsonl(Path(args.selfplay_data)),
        "mixed": load_jsonl(Path(args.mixed_data)),
        "curriculum": load_jsonl(Path(args.curriculum_data)),
    }
    originals = unique_samples(
        [*sources["bootstrap"], *sources["selfplay"], *sources["mixed"], *sources["curriculum"]]
    )
    expanded = unique_samples(expand_seat_balanced(originals))
    train_samples = [sample for sample in expanded if sample["split"] == "train"]
    validation_samples = [sample for sample in expanded if sample["split"] == "validation"]
    if not train_samples or not validation_samples:
        raise ValueError("Both train and validation samples are required")
    train_games = {sample["gameId"] for sample in train_samples}
    validation_games = {sample["gameId"] for sample in validation_samples}
    if train_games.intersection(validation_games):
        raise ValueError("A game appears in both M3.3 splits")

    seat_counts = {
        split: {
            seat: sum(sample["currentPlayer"] == seat for sample in rows)
            for seat in ("A", "B")
        }
        for split, rows in (("train", train_samples), ("validation", validation_samples))
    }
    device = choose_device(args.device)
    train_dataset = RelativeKataCatDataset(train_samples, augment=args.augment == "on")
    validation_dataset = RelativeKataCatDataset(validation_samples, augment=False)
    train_loader = DataLoader(
        train_dataset,
        batch_size=args.batch_size,
        shuffle=True,
        num_workers=0,
        pin_memory=device.type == "cuda",
    )
    validation_loader = DataLoader(
        validation_dataset,
        batch_size=args.batch_size,
        shuffle=False,
        num_workers=0,
        pin_memory=device.type == "cuda",
    )
    validation_by_seat = {
        seat: [sample for sample in validation_samples if sample["currentPlayer"] == seat]
        for seat in ("A", "B")
    }

    model = KataCatNet(args.channels, args.blocks).to(device)
    ownership_loss = nn.CrossEntropyLoss(weight=ownership_class_weights(train_dataset, device))
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, T_max=max(1, args.epochs)
    )

    initial_metrics = evaluate(
        model,
        validation_loader,
        device,
        ownership_loss,
        args.value_weight,
        args.score_weight,
        args.ownership_weight,
    )
    best_objective = math.inf
    best_epoch = 0
    best_metrics: dict[str, float] = {}
    best_seat_metrics: dict[str, dict[str, float]] = {}
    history: list[dict[str, Any]] = []
    output_dir = Path(args.out)
    output_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_path = output_dir / "katacat-m33.pt"

    for epoch in range(1, args.epochs + 1):
        model.train()
        running_loss = 0.0
        seen = 0
        for features, policy, value, score, ownership in train_loader:
            features = features.to(device, non_blocking=True)
            policy = policy.to(device, non_blocking=True)
            value = value.to(device, non_blocking=True)
            score = score.to(device, non_blocking=True)
            ownership = ownership.to(device, non_blocking=True)
            optimizer.zero_grad(set_to_none=True)
            policy_logits, predicted_value, predicted_score, ownership_logits = model(features)
            p_loss = soft_policy_loss(policy_logits, policy)
            v_loss = nn.functional.mse_loss(predicted_value, value)
            s_loss = nn.functional.smooth_l1_loss(predicted_score, score)
            o_loss = ownership_loss(ownership_logits, ownership)
            loss = p_loss + args.value_weight * v_loss + args.score_weight * s_loss + args.ownership_weight * o_loss
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), max_norm=5.0)
            optimizer.step()
            running_loss += loss.item() * features.shape[0]
            seen += features.shape[0]
        scheduler.step()
        metrics = evaluate(
            model,
            validation_loader,
            device,
            ownership_loss,
            args.value_weight,
            args.score_weight,
            args.ownership_weight,
        )
        seat_metrics = {
            seat: evaluate(
                model,
                loader_for(rows, args.batch_size),
                device,
                ownership_loss,
                args.value_weight,
                args.score_weight,
                args.ownership_weight,
            )
            for seat, rows in validation_by_seat.items()
        }
        train_loss = float(running_loss / seen)
        history.append({"epoch": epoch, "trainLoss": train_loss, "validation": metrics, "bySeat": seat_metrics})
        print(
            f"epoch {epoch:03d} train={train_loss:.4f} val={metrics['loss']:.4f} "
            f"policy={metrics['policyTop1']:.3f} value={metrics['valueAccuracy']:.3f} "
            f"A_policy={seat_metrics['A']['policyTop1']:.3f} B_policy={seat_metrics['B']['policyTop1']:.3f}"
        )
        if metrics["loss"] < best_objective:
            best_objective = metrics["loss"]
            best_epoch = epoch
            best_metrics = metrics
            best_seat_metrics = seat_metrics
            torch.save(
                {
                    "modelState": model.state_dict(),
                    "inputChannels": 16,
                    "policySize": 82,
                    "channels": args.channels,
                    "blocks": args.blocks,
                    "boardSize": 9,
                    "maxMargin": MAX_MARGIN,
                    "epoch": epoch,
                    "stage": "M3.3",
                    "encodingVersion": "PLAYER_RELATIVE_V1",
                    "validationMetrics": metrics,
                    "validationBySeat": seat_metrics,
                },
                checkpoint_path,
            )

    curriculum_sources = {
        str(sample.get("policySource", "UNKNOWN"))
        for sample in sources["curriculum"]
    }
    acceptance = {
        "playerRelativeEncoding": True,
        "freshRelativeModel": True,
        "seatSwapExpandedEverySample": len(expanded) == len(originals) * 2,
        "exactTrainSeatBalance": seat_counts["train"]["A"] == seat_counts["train"]["B"],
        "exactValidationSeatBalance": seat_counts["validation"]["A"] == seat_counts["validation"]["B"],
        "bSeatCurriculumPresent": any(
            sample.get("currentPlayer") == "B" for sample in sources["curriculum"]
        ),
        "safeTeacherCurriculumOnly": curriculum_sources == {"CURRENT_TACTICAL_TEACHER"},
        "gameSplitDisjoint": train_games.isdisjoint(validation_games),
        "allMetricsFinite": required_metrics_are_finite(initial_metrics)
        and required_metrics_are_finite(best_metrics)
        and all(required_metrics_are_finite(metrics) for metrics in best_seat_metrics.values()),
        "candidateCheckpointSaved": checkpoint_path.is_file(),
        "passed": False,
    }
    acceptance["passed"] = all(value for key, value in acceptance.items() if key != "passed")
    summary = {
        "schemaVersion": 1,
        "stage": "M3.3_TRAIN",
        "device": str(device),
        "encodingVersion": "PLAYER_RELATIVE_V1",
        "freshModel": True,
        "sources": {name: len(rows) for name, rows in sources.items()},
        "originalSamples": len(originals),
        "expandedSamples": len(expanded),
        "trainSamples": len(train_samples),
        "validationSamples": len(validation_samples),
        "seatCounts": seat_counts,
        "trainGames": len(train_games),
        "validationGames": len(validation_games),
        "epochs": args.epochs,
        "bestEpoch": best_epoch,
        "initialValidation": initial_metrics,
        "bestValidation": best_metrics,
        "bestValidationBySeat": best_seat_metrics,
        "baselines": relative_baselines(train_samples, validation_samples),
        "model": {
            "channels": args.channels,
            "blocks": args.blocks,
            "parameters": sum(parameter.numel() for parameter in model.parameters()),
        },
        "lossWeights": {
            "policy": 1.0,
            "value": args.value_weight,
            "score": args.score_weight,
            "ownership": args.ownership_weight,
        },
        "augmentation": args.augment == "on",
        "acceptance": acceptance,
        "epochHistory": history,
        "note": (
            "M3.3 trains a fresh network because absolute A/B input weights are not compatible "
            "with mover-relative planes. Every sample receives a color-swapped twin, and the "
            "extra curriculum contains only CURRENT teacher actions with B-seat tactical priority."
        ),
    }
    (output_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, separators=(",", ":")))
    if not acceptance["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
