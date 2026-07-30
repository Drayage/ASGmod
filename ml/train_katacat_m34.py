from __future__ import annotations

import argparse
import json
import math
import random
from pathlib import Path
from typing import Any

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset

from katacat_m33_relative import relative_featurize, relative_ownership_target
from train_katacat_m1 import (
    BOARD_CELLS,
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
        description="Fine-tune KataCat M3.3 with verified tactical hard-negative policy corrections."
    )
    parser.add_argument("--bootstrap-data", required=True)
    parser.add_argument("--selfplay-data", required=True)
    parser.add_argument("--mixed-data", required=True)
    parser.add_argument("--curriculum-data", required=True)
    parser.add_argument("--hard-negative-data", required=True)
    parser.add_argument("--init-checkpoint", required=True)
    parser.add_argument("--out", default="katacat-m34-model")
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--learning-rate", type=float, default=1e-4)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--pairwise-weight", type=float, default=0.5)
    parser.add_argument("--pairwise-margin", type=float, default=0.5)
    parser.add_argument("--value-weight", type=float, default=1.0)
    parser.add_argument("--score-weight", type=float, default=0.25)
    parser.add_argument("--ownership-weight", type=float, default=1.0)
    parser.add_argument("--seed", type=int, default=20260730)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--augment", choices=("on", "off"), default="on")
    return parser.parse_args()


class M34Dataset(
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
        self.positive_actions = []
        self.negative_masks = []
        for sample, policy, is_hard in zip(samples, self.policies, self.hard_negative, strict=True):
            positive = int(sample.get("positiveAction", int(policy.argmax())))
            if not 0 <= positive < POLICY_SIZE:
                raise ValueError(f"Invalid positiveAction in {sample.get('sampleId')}: {positive}")
            negative_mask = np.zeros(POLICY_SIZE, dtype=np.float32)
            for action in sample.get("negativeActions", []):
                index = int(action)
                if not 0 <= index < POLICY_SIZE:
                    raise ValueError(f"Invalid negative action in {sample.get('sampleId')}: {index}")
                negative_mask[index] = 1.0
            if is_hard and negative_mask.sum() <= 0:
                raise ValueError(f"Hard-negative sample {sample.get('sampleId')} has no negatives")
            if negative_mask[positive] > 0:
                raise ValueError(f"Positive action is also negative in {sample.get('sampleId')}")
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
            features, policy, ownership = apply_symmetry(features, policy, ownership, symmetry)
            _, negative_mask, _ = apply_symmetry(
                self.features[index], negative_mask, self.ownership[index], symmetry
            )
            _, positive_vector, _ = apply_symmetry(
                self.features[index], positive_vector, self.ownership[index], symmetry
            )
        positive_action = int(positive_vector.argmax())
        return (
            torch.from_numpy(features.copy()),
            torch.from_numpy(policy.copy()),
            torch.tensor(self.values[index], dtype=torch.float32),
            torch.tensor(self.scores[index], dtype=torch.float32),
            torch.from_numpy(ownership.copy()),
            torch.tensor(1.0 if self.hard_negative[index] else 0.0, dtype=torch.float32),
            torch.tensor(positive_action, dtype=torch.long),
            torch.from_numpy(negative_mask.copy()).bool(),
        )


def per_sample_policy_loss(logits: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    return -(target * torch.log_softmax(logits, dim=1)).sum(dim=1)


def hard_negative_pairwise_loss(
    logits: torch.Tensor,
    hard_flags: torch.Tensor,
    positive_actions: torch.Tensor,
    negative_masks: torch.Tensor,
    margin: float,
) -> tuple[torch.Tensor, int, torch.Tensor]:
    valid = torch.logical_and(hard_flags > 0.5, negative_masks.any(dim=1))
    if not bool(valid.any()):
        return logits.sum() * 0.0, 0, torch.empty(0, device=logits.device)
    selected_logits = logits[valid]
    selected_positive = positive_actions[valid]
    selected_negative_masks = negative_masks[valid]
    positive_logits = selected_logits.gather(1, selected_positive.unsqueeze(1)).squeeze(1)
    negative_logits = selected_logits.masked_fill(~selected_negative_masks, -1e9).max(dim=1).values
    margins = positive_logits - negative_logits
    loss = nn.functional.softplus(float(margin) - margins).mean()
    return loss, int(valid.sum().item()), margins


def evaluate(
    model: KataCatNet,
    loader: DataLoader,
    device: torch.device,
    ownership_loss: nn.CrossEntropyLoss,
    args: argparse.Namespace,
) -> dict[str, float]:
    model.eval()
    examples = 0
    hard_examples = 0
    total_loss = 0.0
    policy_loss_total = 0.0
    pairwise_loss_total = 0.0
    value_loss_total = 0.0
    score_loss_total = 0.0
    ownership_loss_total = 0.0
    policy_correct = 0
    value_correct = 0
    hard_top1 = 0
    negative_top1 = 0
    hard_margins: list[torch.Tensor] = []
    score_errors: list[torch.Tensor] = []
    ownership_predictions: list[torch.Tensor] = []
    ownership_targets: list[torch.Tensor] = []

    with torch.no_grad():
        for (
            features,
            policy,
            value,
            score,
            ownership,
            hard_flags,
            positive_actions,
            negative_masks,
        ) in loader:
            features = features.to(device)
            policy = policy.to(device)
            value = value.to(device)
            score = score.to(device)
            ownership = ownership.to(device)
            hard_flags = hard_flags.to(device)
            positive_actions = positive_actions.to(device)
            negative_masks = negative_masks.to(device)
            policy_logits, predicted_value, predicted_score, ownership_logits = model(features)
            p_losses = per_sample_policy_loss(policy_logits, policy)
            p_loss = p_losses.mean()
            pair_loss, hard_count, margins = hard_negative_pairwise_loss(
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
            batch_size = features.shape[0]
            examples += batch_size
            hard_examples += hard_count
            total_loss += loss.item() * batch_size
            policy_loss_total += p_loss.item() * batch_size
            pairwise_loss_total += pair_loss.item() * hard_count
            value_loss_total += v_loss.item() * batch_size
            score_loss_total += s_loss.item() * batch_size
            ownership_loss_total += o_loss.item() * batch_size
            prediction = policy_logits.argmax(dim=1)
            policy_correct += (prediction == policy.argmax(dim=1)).sum().item()
            value_correct += ((predicted_value >= 0) == (value >= 0)).sum().item()
            hard_rows = hard_flags > 0.5
            if bool(hard_rows.any()):
                hard_prediction = prediction[hard_rows]
                hard_positive = positive_actions[hard_rows]
                hard_negative_mask = negative_masks[hard_rows]
                hard_top1 += (hard_prediction == hard_positive).sum().item()
                negative_top1 += hard_negative_mask.gather(1, hard_prediction.unsqueeze(1)).sum().item()
            if margins.numel() > 0:
                hard_margins.append(margins.cpu())
            score_errors.append((predicted_score - score).abs().cpu() * MAX_MARGIN)
            ownership_predictions.append(ownership_logits.argmax(dim=1).cpu())
            ownership_targets.append(ownership.cpu())

    if examples <= 0:
        raise ValueError("Cannot evaluate empty M3.4 loader")
    ownership_prediction = torch.cat(ownership_predictions)
    ownership_target = torch.cat(ownership_targets)
    metrics = ownership_metrics(ownership_prediction, ownership_target)
    metrics["iouSelf"] = metrics.pop("iouA")
    metrics["iouOpponent"] = metrics.pop("iouB")
    metrics.update(
        {
            "loss": total_loss / examples,
            "policyLoss": policy_loss_total / examples,
            "policyTop1": policy_correct / examples,
            "pairwiseLoss": pairwise_loss_total / max(1, hard_examples),
            "hardNegativeSamples": float(hard_examples),
            "hardNegativeTop1": hard_top1 / max(1, hard_examples),
            "hardNegativeNegativeTop1Rate": negative_top1 / max(1, hard_examples),
            "hardNegativeMeanMargin": float(torch.cat(hard_margins).mean().item())
            if hard_margins
            else 0.0,
            "valueLoss": value_loss_total / examples,
            "valueAccuracy": value_correct / examples,
            "scoreLoss": score_loss_total / examples,
            "scoreMaeCells": float(torch.cat(score_errors).mean().item()),
            "ownershipLoss": ownership_loss_total / examples,
        }
    )
    return {key: float(value) for key, value in metrics.items()}


def finite_metrics(metrics: dict[str, float]) -> bool:
    required = (
        "loss",
        "policyLoss",
        "policyTop1",
        "pairwiseLoss",
        "hardNegativeTop1",
        "hardNegativeNegativeTop1Rate",
        "hardNegativeMeanMargin",
        "valueLoss",
        "valueAccuracy",
        "scoreLoss",
        "scoreMaeCells",
        "ownershipLoss",
        "ownershipAccuracy",
        "meanTerritoryIou",
    )
    return all(key in metrics and math.isfinite(float(metrics[key])) for key in required)


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
    hard_balanced, hard_balance = balance_real_seats(unique_samples(hard_samples), args.seed + 1)
    samples = unique_samples([*replay_balanced, *hard_balanced])
    train_samples = [sample for sample in samples if sample["split"] == "train"]
    validation_samples = [sample for sample in samples if sample["split"] == "validation"]
    if not train_samples or not validation_samples:
        raise ValueError("M3.4 requires train and validation samples")
    train_games = {str(sample["gameId"]) for sample in train_samples}
    validation_games = {str(sample["gameId"]) for sample in validation_samples}
    if not train_games.isdisjoint(validation_games):
        raise ValueError("M3.4 game split leakage")

    device = choose_device(args.device)
    checkpoint_path = Path(args.init_checkpoint)
    checkpoint = torch.load(checkpoint_path, map_location="cpu")
    if checkpoint.get("encodingVersion") != "PLAYER_RELATIVE_V1":
        raise ValueError("M3.4 requires a PLAYER_RELATIVE_V1 checkpoint")
    channels = int(checkpoint["channels"])
    blocks = int(checkpoint["blocks"])
    model = KataCatNet(channels, blocks)
    model.load_state_dict(checkpoint["modelState"])
    model = model.to(device)

    train_dataset = M34Dataset(train_samples, augment=args.augment == "on")
    validation_dataset = M34Dataset(validation_samples, augment=False)
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
    ownership_loss = nn.CrossEntropyLoss(weight=ownership_class_weights(train_dataset, device))
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, T_max=max(1, args.epochs)
    )

    initial_metrics = evaluate(model, validation_loader, device, ownership_loss, args)
    best_objective = math.inf
    best_epoch = 0
    best_metrics: dict[str, float] = {}
    history: list[dict[str, Any]] = []
    output_dir = Path(args.out)
    output_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_out = output_dir / "katacat-m34.pt"

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
            policy_logits, predicted_value, predicted_score, ownership_logits = model(features)
            p_loss = per_sample_policy_loss(policy_logits, policy).mean()
            pair_loss, _, _ = hard_negative_pairwise_loss(
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
        metrics = evaluate(model, validation_loader, device, ownership_loss, args)
        train_loss = float(running_loss / max(1, seen))
        history.append({"epoch": epoch, "trainLoss": train_loss, "validation": metrics})
        print(
            f"epoch {epoch:03d} train={train_loss:.4f} val={metrics['loss']:.4f} "
            f"policy={metrics['policyTop1']:.3f} hard_top1={metrics['hardNegativeTop1']:.3f} "
            f"negative_top1={metrics['hardNegativeNegativeTop1Rate']:.3f} "
            f"margin={metrics['hardNegativeMeanMargin']:.3f}"
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
                    "stage": "M3.4",
                    "encodingVersion": "PLAYER_RELATIVE_V1",
                    "parentCheckpoint": str(checkpoint_path),
                    "validationMetrics": metrics,
                    "hardNegativePolicy": {
                        "pairwiseWeight": args.pairwise_weight,
                        "pairwiseMargin": args.pairwise_margin,
                    },
                },
                checkpoint_out,
            )

    hard_sources = {str(sample.get("policySource", "UNKNOWN")) for sample in hard_samples}
    hard_positive_legal = all(
        int(sample["positiveAction"]) in {int(action) for action in sample["legalActions"]}
        for sample in hard_samples
    )
    hard_positive_not_negative = all(
        int(sample["positiveAction"]) not in {int(action) for action in sample["negativeActions"]}
        for sample in hard_samples
    )
    acceptance = {
        "initializedFromM33": checkpoint_path.is_file()
        and checkpoint.get("encodingVersion") == "PLAYER_RELATIVE_V1",
        "hardNegativeSamplesPresent": len(hard_balanced) > 0,
        "hardNegativeTrainAndValidationPresent": any(
            sample["split"] == "train" for sample in hard_balanced
        )
        and any(sample["split"] == "validation" for sample in hard_balanced),
        "maskedPuctPolicySourceOnly": hard_sources
        == {"TACTICAL_HARD_NEGATIVE_MASKED_PUCT"},
        "positiveActionsLegal": hard_positive_legal,
        "positiveActionsNotNegative": hard_positive_not_negative,
        "provenNegativesPresent": all(
            bool(sample.get("exactNegativeProof")) and len(sample.get("negativeActions", [])) > 0
            for sample in hard_samples
        ),
        "unverifiedFallbackTeachersExcluded": all(
            not bool(sample.get("targetUsesUnverifiedFallback")) for sample in hard_samples
        ),
        "gameSplitDisjoint": train_games.isdisjoint(validation_games),
        "allMetricsFinite": finite_metrics(initial_metrics) and finite_metrics(best_metrics),
        "candidateCheckpointSaved": checkpoint_out.is_file(),
        "noRandomRollouts": True,
        "passed": False,
    }
    acceptance["passed"] = all(value for key, value in acceptance.items() if key != "passed")
    summary = {
        "schemaVersion": 1,
        "stage": "M3.4_TRAIN",
        "device": str(device),
        "encodingVersion": "PLAYER_RELATIVE_V1",
        "parentCheckpoint": str(checkpoint_path),
        "sourceSamples": {
            **{name: len(rows) for name, rows in replay_sources.items()},
            "hardNegative": len(hard_samples),
        },
        "balancedSamples": {
            "replay": len(replay_balanced),
            "hardNegative": len(hard_balanced),
            "total": len(samples),
        },
        "balance": {"replay": replay_balance, "hardNegative": hard_balance},
        "trainSamples": len(train_samples),
        "validationSamples": len(validation_samples),
        "trainGames": len(train_games),
        "validationGames": len(validation_games),
        "epochs": args.epochs,
        "bestEpoch": best_epoch,
        "initialValidation": initial_metrics,
        "bestValidation": best_metrics,
        "baselines": relative_baselines(train_samples, validation_samples),
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
            "M3.4 continues from the frozen M3.3 player-relative checkpoint. Proven forced-capture "
            "moves are removed from policy targets, a separately verified CURRENT move supplies the "
            "positive target, and an auxiliary pairwise loss pushes that positive above every proven "
            "negative. Unverified and all-root-refuted fallback actions are never policy teachers."
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
