from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import torch
from torch import nn
from torch.utils.data import DataLoader

from train_katacat_m1 import (
    KataCatDataset,
    KataCatNet,
    baseline_metrics,
    choose_device,
    evaluate,
    load_jsonl,
    ownership_class_weights,
    seed_everything,
    soft_policy_loss,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Retrain a KataCat M3 candidate from M0 bootstrap and PUCT self-play visits."
    )
    parser.add_argument("--bootstrap-data", default="katacat-m0-output/katacat-samples.jsonl")
    parser.add_argument("--selfplay-data", default="katacat-m3-output/katacat-selfplay-samples.jsonl")
    parser.add_argument("--init-checkpoint", default="katacat-m1-output/katacat-m1.pt")
    parser.add_argument("--out", default="katacat-m3-model")
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--learning-rate", type=float, default=1e-4)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
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
            raise ValueError("Every M3 training sample needs sampleId")
        if sample_id in seen:
            raise ValueError(f"Duplicate sampleId: {sample_id}")
        seen.add(sample_id)
        result.append(sample)
    return result


def visit_target_stats(samples: list[dict[str, Any]]) -> dict[str, Any]:
    visit_sums: list[float] = []
    nonzero_actions: list[int] = []
    targets_with_repeat = 0
    puct_samples = 0
    for sample in samples:
        target = sample.get("policyTarget", [])
        visits = [float(item.get("visits", 0)) for item in target if float(item.get("visits", 0)) > 0]
        if not visits:
            raise ValueError(f"Sample {sample.get('sampleId')} has no positive policy visits")
        visit_sums.append(sum(visits))
        nonzero_actions.append(len(visits))
        if max(visits) > 1:
            targets_with_repeat += 1
        if sample.get("policySource") == "PUCT_VISITS":
            puct_samples += 1
    return {
        "samples": len(samples),
        "puctSamples": puct_samples,
        "targetsWithRepeatedVisits": targets_with_repeat,
        "meanVisitSum": float(sum(visit_sums) / len(visit_sums)),
        "maxVisitSum": float(max(visit_sums)),
        "meanVisitedActions": float(sum(nonzero_actions) / len(nonzero_actions)),
    }


def main() -> None:
    args = parse_args()
    seed_everything(args.seed)
    output_dir = Path(args.out)
    output_dir.mkdir(parents=True, exist_ok=True)

    bootstrap_samples = load_jsonl(Path(args.bootstrap_data))
    selfplay_samples = load_jsonl(Path(args.selfplay_data))
    samples = unique_samples([*bootstrap_samples, *selfplay_samples])
    train_samples = [sample for sample in samples if sample["split"] == "train"]
    validation_samples = [sample for sample in samples if sample["split"] == "validation"]
    if not train_samples or not validation_samples:
        raise ValueError("Both train and validation samples are required")

    train_games = {sample["gameId"] for sample in train_samples}
    validation_games = {sample["gameId"] for sample in validation_samples}
    if train_games.intersection(validation_games):
        raise ValueError("A game appears in both train and validation splits")

    selfplay_stats = visit_target_stats(selfplay_samples)
    if selfplay_stats["puctSamples"] != len(selfplay_samples):
        raise ValueError("Every self-play sample must use PUCT_VISITS policy targets")

    checkpoint_path = Path(args.init_checkpoint)
    checkpoint = torch.load(checkpoint_path, map_location="cpu")
    channels = int(checkpoint["channels"])
    blocks = int(checkpoint["blocks"])
    device = choose_device(args.device)
    model = KataCatNet(channels, blocks)
    model.load_state_dict(checkpoint["modelState"])
    model = model.to(device)

    train_dataset = KataCatDataset(train_samples, augment=args.augment == "on")
    validation_dataset = KataCatDataset(validation_samples, augment=False)
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

    ownership_loss = nn.CrossEntropyLoss(
        weight=ownership_class_weights(train_dataset, device)
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
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, T_max=max(1, args.epochs)
    )

    best_objective = math.inf
    best_epoch = 0
    best_metrics: dict[str, float] = {}
    candidate_path = output_dir / "katacat-m3.pt"
    epoch_history: list[dict[str, float]] = []

    print(
        f"KataCat M3 on {device}: train={len(train_dataset)} samples/{len(train_games)} games, "
        f"validation={len(validation_dataset)} samples/{len(validation_games)} games, "
        f"bootstrap={len(bootstrap_samples)} selfplay={len(selfplay_samples)}"
    )

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
            loss = (
                p_loss
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

        metrics = evaluate(
            model,
            validation_loader,
            device,
            ownership_loss,
            args.value_weight,
            args.score_weight,
            args.ownership_weight,
        )
        train_loss = float(running_loss / seen)
        epoch_history.append({"epoch": float(epoch), "trainLoss": train_loss, **metrics})
        print(
            f"epoch {epoch:03d} train={train_loss:.4f} val={metrics['loss']:.4f} "
            f"policy_top1={metrics['policyTop1']:.3f} value_acc={metrics['valueAccuracy']:.3f} "
            f"score_mae={metrics['scoreMaeCells']:.2f} ownership_iou={metrics['meanTerritoryIou']:.3f}"
        )
        if metrics["loss"] < best_objective:
            best_objective = metrics["loss"]
            best_epoch = epoch
            best_metrics = metrics
            torch.save(
                {
                    "modelState": model.state_dict(),
                    "inputChannels": int(checkpoint["inputChannels"]),
                    "policySize": int(checkpoint["policySize"]),
                    "channels": channels,
                    "blocks": blocks,
                    "boardSize": int(checkpoint["boardSize"]),
                    "maxMargin": int(checkpoint["maxMargin"]),
                    "epoch": epoch,
                    "stage": "M3",
                    "parentCheckpoint": str(checkpoint_path),
                    "validationMetrics": metrics,
                },
                candidate_path,
            )

    finite_metric_values = [
        float(value)
        for metrics in (initial_metrics, best_metrics)
        for value in metrics.values()
        if isinstance(value, (int, float)) and not math.isnan(float(value))
    ]
    all_metrics_finite = all(math.isfinite(value) for value in finite_metric_values)
    smoke_acceptance = {
        "gameSplitDisjoint": train_games.isdisjoint(validation_games),
        "puctVisitTargetsPresent": selfplay_stats["puctSamples"] > 0,
        "multiVisitTargetsObserved": selfplay_stats["targetsWithRepeatedVisits"] > 0,
        "initializedFromM1": checkpoint_path.is_file(),
        "allMetricsFinite": all_metrics_finite,
        "candidateCheckpointSaved": candidate_path.is_file(),
        "passed": False,
    }
    smoke_acceptance["passed"] = all(smoke_acceptance.values())

    summary = {
        "schemaVersion": 1,
        "stage": "M3_TRAIN",
        "device": str(device),
        "bootstrapData": str(args.bootstrap_data),
        "selfplayData": str(args.selfplay_data),
        "parentCheckpoint": str(checkpoint_path),
        "trainGames": len(train_games),
        "validationGames": len(validation_games),
        "trainSamples": len(train_samples),
        "validationSamples": len(validation_samples),
        "bootstrapSamples": len(bootstrap_samples),
        "selfplaySamples": len(selfplay_samples),
        "selfplayVisitTargets": selfplay_stats,
        "epochs": args.epochs,
        "bestEpoch": best_epoch,
        "initialValidation": initial_metrics,
        "bestValidation": best_metrics,
        "baselines": baseline_metrics(train_samples, validation_samples),
        "model": {
            "channels": channels,
            "blocks": blocks,
            "parameters": sum(parameter.numel() for parameter in model.parameters()),
        },
        "lossWeights": {
            "policy": 1.0,
            "value": args.value_weight,
            "score": args.score_weight,
            "ownership": args.ownership_weight,
        },
        "augmentation": args.augment == "on",
        "smokeAcceptance": smoke_acceptance,
        "epochHistory": epoch_history,
        "note": "M3 is the self-play/retraining loop gate. Strength promotion remains M4; no game AI is replaced here.",
    }
    (output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print("KATACAT_M3_TRAIN:" + json.dumps(summary, ensure_ascii=False))
    if not smoke_acceptance["passed"]:
        raise RuntimeError(f"KataCat M3 training acceptance failed: {smoke_acceptance}")


if __name__ == "__main__":
    main()
