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

BOARD_SIZE = 9
BOARD_CELLS = BOARD_SIZE * BOARD_SIZE
PASS_INDEX = BOARD_CELLS
POLICY_SIZE = BOARD_CELLS + 1
INPUT_CHANNELS = 16
STARTING_CATS = 40
MAX_MARGIN = BOARD_CELLS + 3
OWNERSHIP_CLASS = {".": 0, "A": 1, "B": 2}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train KataCat M1 policy/value/score/ownership network."
    )
    parser.add_argument("--data", default="katacat-m0-output/katacat-samples.jsonl")
    parser.add_argument("--out", default="katacat-m1-output")
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--channels", type=int, default=96)
    parser.add_argument("--blocks", type=int, default=8)
    parser.add_argument("--value-weight", type=float, default=1.0)
    parser.add_argument("--score-weight", type=float, default=0.25)
    parser.add_argument("--ownership-weight", type=float, default=1.0)
    parser.add_argument("--seed", type=int, default=20260729)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--augment", choices=("on", "off"), default="on")
    return parser.parse_args()


def seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def choose_device(requested: str) -> torch.device:
    if requested == "cpu":
        return torch.device("cpu")
    if requested == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA was requested but is not available")
        return torch.device("cuda")
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                sample = json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSON on line {line_number} of {path}") from exc
            if len(sample.get("board", "")) != BOARD_CELLS:
                raise ValueError(f"Sample {line_number} has invalid board length")
            if len(sample.get("finalOwnership", "")) != BOARD_CELLS:
                raise ValueError(f"Sample {line_number} has invalid ownership length")
            if sample.get("split") not in ("train", "validation"):
                raise ValueError(f"Sample {line_number} has invalid split")
            samples.append(sample)
    if not samples:
        raise ValueError(f"No samples found in {path}")
    return samples


def index_plane(indices: list[int]) -> np.ndarray:
    plane = np.zeros((BOARD_SIZE, BOARD_SIZE), dtype=np.float32)
    for index in indices:
        if 0 <= int(index) < BOARD_CELLS:
            plane[int(index) // BOARD_SIZE, int(index) % BOARD_SIZE] = 1.0
    return plane


def featurize(sample: dict[str, Any]) -> np.ndarray:
    board = np.asarray(list(sample["board"]), dtype="U1").reshape(BOARD_SIZE, BOARD_SIZE)
    features = np.zeros((INPUT_CHANNELS, BOARD_SIZE, BOARD_SIZE), dtype=np.float32)
    features[0] = board == "A"
    features[1] = board == "B"
    features[2] = board == "N"
    features[3] = board == "."
    features[4] = index_plane(sample["territoryA"])
    features[5] = index_plane(sample["territoryB"])
    features[6] = index_plane([index for index in sample["legalActions"] if index < BOARD_CELLS])
    features[7].fill(1.0 if sample["currentPlayer"] == "A" else 0.0)
    features[8].fill(1.0 if sample["currentPlayer"] == "B" else 0.0)
    last_action = int(sample["lastAction"])
    if 0 <= last_action < BOARD_CELLS:
        features[9, last_action // BOARD_SIZE, last_action % BOARD_SIZE] = 1.0
    features[10].fill(float(sample["remainingA"]) / STARTING_CATS)
    features[11].fill(float(sample["remainingB"]) / STARTING_CATS)
    features[12].fill(min(float(sample["consecutivePasses"]), 2.0) / 2.0)
    features[13].fill(min(float(sample["ply"]), 90.0) / 90.0)
    features[14].fill(3.0 / BOARD_CELLS)
    features[15].fill(1.0 if PASS_INDEX in sample["legalActions"] else 0.0)
    return features


def policy_target(sample: dict[str, Any]) -> np.ndarray:
    target = np.zeros(POLICY_SIZE, dtype=np.float32)
    total_visits = 0.0
    for item in sample["policyTarget"]:
        action = int(item["action"])
        visits = float(item["visits"])
        if 0 <= action < POLICY_SIZE and visits > 0:
            target[action] += visits
            total_visits += visits
    if total_visits <= 0:
        raise ValueError(f"Sample {sample.get('sampleId')} has empty policy target")
    target /= total_visits
    return target


def ownership_target(sample: dict[str, Any]) -> np.ndarray:
    try:
        values = [OWNERSHIP_CLASS[value] for value in sample["finalOwnership"]]
    except KeyError as exc:
        raise ValueError(f"Unexpected ownership label {exc.args[0]}") from exc
    return np.asarray(values, dtype=np.int64).reshape(BOARD_SIZE, BOARD_SIZE)


def value_target(sample: dict[str, Any]) -> float:
    return 1.0 if sample["finalWinner"] == sample["currentPlayer"] else -1.0


def score_target(sample: dict[str, Any]) -> float:
    margin_a = float(sample["finalAdjustedMarginA"])
    perspective_margin = margin_a if sample["currentPlayer"] == "A" else -margin_a
    return float(np.clip(perspective_margin / MAX_MARGIN, -1.0, 1.0))


def transform_plane(plane: np.ndarray, symmetry: int) -> np.ndarray:
    transformed = np.rot90(plane, k=symmetry % 4)
    if symmetry >= 4:
        transformed = np.fliplr(transformed)
    return np.ascontiguousarray(transformed)


def apply_symmetry(
    features: np.ndarray,
    policy: np.ndarray,
    ownership: np.ndarray,
    symmetry: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    transformed_features = np.stack(
        [transform_plane(features[channel], symmetry) for channel in range(features.shape[0])]
    )
    policy_board = transform_plane(policy[:BOARD_CELLS].reshape(BOARD_SIZE, BOARD_SIZE), symmetry)
    transformed_policy = np.concatenate(
        [policy_board.reshape(-1), np.asarray([policy[PASS_INDEX]], dtype=np.float32)]
    )
    transformed_ownership = transform_plane(ownership, symmetry)
    return transformed_features, transformed_policy, transformed_ownership


class KataCatDataset(
    Dataset[tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]]
):
    def __init__(self, samples: list[dict[str, Any]], augment: bool) -> None:
        self.samples = samples
        self.augment = augment
        self.features = [featurize(sample) for sample in samples]
        self.policies = [policy_target(sample) for sample in samples]
        self.ownership = [ownership_target(sample) for sample in samples]
        self.values = [value_target(sample) for sample in samples]
        self.scores = [score_target(sample) for sample in samples]

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(
        self, index: int
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        features = self.features[index]
        policy = self.policies[index]
        ownership = self.ownership[index]
        if self.augment:
            features, policy, ownership = apply_symmetry(
                features, policy, ownership, random.randrange(8)
            )
        return (
            torch.from_numpy(features.copy()),
            torch.from_numpy(policy.copy()),
            torch.tensor(self.values[index], dtype=torch.float32),
            torch.tensor(self.scores[index], dtype=torch.float32),
            torch.from_numpy(ownership.copy()),
        )


class ResidualBlock(nn.Module):
    def __init__(self, channels: int) -> None:
        super().__init__()
        groups = 8 if channels % 8 == 0 else 1
        self.body = nn.Sequential(
            nn.Conv2d(channels, channels, kernel_size=3, padding=1, bias=False),
            nn.GroupNorm(groups, channels),
            nn.ReLU(inplace=True),
            nn.Conv2d(channels, channels, kernel_size=3, padding=1, bias=False),
            nn.GroupNorm(groups, channels),
        )
        self.activation = nn.ReLU(inplace=True)

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        return self.activation(inputs + self.body(inputs))


class KataCatNet(nn.Module):
    def __init__(self, channels: int, blocks: int) -> None:
        super().__init__()
        groups = 8 if channels % 8 == 0 else 1
        self.stem = nn.Sequential(
            nn.Conv2d(INPUT_CHANNELS, channels, kernel_size=3, padding=1, bias=False),
            nn.GroupNorm(groups, channels),
            nn.ReLU(inplace=True),
        )
        self.trunk = nn.Sequential(*(ResidualBlock(channels) for _ in range(blocks)))
        self.policy_head = nn.Sequential(
            nn.Conv2d(channels, 4, kernel_size=1, bias=False),
            nn.GroupNorm(1, 4),
            nn.ReLU(inplace=True),
            nn.Flatten(),
            nn.Linear(4 * BOARD_CELLS, POLICY_SIZE),
        )
        self.value_head = nn.Sequential(
            nn.Conv2d(channels, 2, kernel_size=1, bias=False),
            nn.GroupNorm(1, 2),
            nn.ReLU(inplace=True),
            nn.Flatten(),
            nn.Linear(2 * BOARD_CELLS, 128),
            nn.ReLU(inplace=True),
            nn.Linear(128, 1),
            nn.Tanh(),
        )
        self.score_head = nn.Sequential(
            nn.Conv2d(channels, 2, kernel_size=1, bias=False),
            nn.GroupNorm(1, 2),
            nn.ReLU(inplace=True),
            nn.Flatten(),
            nn.Linear(2 * BOARD_CELLS, 128),
            nn.ReLU(inplace=True),
            nn.Linear(128, 1),
            nn.Tanh(),
        )
        self.ownership_head = nn.Sequential(
            nn.Conv2d(channels, 32, kernel_size=1, bias=False),
            nn.GroupNorm(8, 32),
            nn.ReLU(inplace=True),
            nn.Conv2d(32, 3, kernel_size=1),
        )

    def forward(
        self, inputs: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        trunk = self.trunk(self.stem(inputs))
        return (
            self.policy_head(trunk),
            self.value_head(trunk).squeeze(1),
            self.score_head(trunk).squeeze(1),
            self.ownership_head(trunk),
        )


def soft_policy_loss(logits: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    return -(target * torch.log_softmax(logits, dim=1)).sum(dim=1).mean()


def ownership_class_weights(dataset: KataCatDataset, device: torch.device) -> torch.Tensor:
    flattened = np.concatenate([target.reshape(-1) for target in dataset.ownership])
    counts = torch.bincount(torch.from_numpy(flattened), minlength=3).float()
    weights = torch.sqrt(counts.sum() / counts.clamp_min(1.0))
    weights = torch.clamp(weights / weights.mean(), 0.35, 3.0)
    return weights.to(device)


def ownership_metrics(prediction: torch.Tensor, target: torch.Tensor) -> dict[str, float]:
    metrics: dict[str, float] = {
        "ownershipAccuracy": float((prediction == target).float().mean().item())
    }
    ious: list[float] = []
    for class_index, name in ((1, "A"), (2, "B")):
        predicted = prediction == class_index
        actual = target == class_index
        intersection = torch.logical_and(predicted, actual).sum().item()
        union = torch.logical_or(predicted, actual).sum().item()
        iou = float(intersection / union) if union > 0 else math.nan
        metrics[f"iou{name}"] = iou
        if not math.isnan(iou):
            ious.append(iou)
    metrics["meanTerritoryIou"] = float(sum(ious) / len(ious)) if ious else 0.0
    return metrics


@torch.no_grad()
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

    prediction = torch.cat(ownership_predictions)
    target = torch.cat(ownership_targets)
    metrics = ownership_metrics(prediction, target)
    metrics.update(
        {
            "loss": float(total_loss / total_examples),
            "policyLoss": float(policy_loss_total / total_examples),
            "policyTop1": float(policy_correct / total_examples),
            "valueLoss": float(value_loss_total / total_examples),
            "valueAccuracy": float(value_correct / total_examples),
            "scoreLoss": float(score_loss_total / total_examples),
            "scoreMaeCells": float(torch.cat(score_errors).mean().item()),
            "ownershipLoss": float(ownership_loss_total / total_examples),
        }
    )
    return metrics


def baseline_metrics(
    train_samples: list[dict[str, Any]], validation_samples: list[dict[str, Any]]
) -> dict[str, Any]:
    train_values = [value_target(sample) for sample in train_samples]
    majority_value = 1.0 if sum(train_values) >= 0 else -1.0
    value_accuracy = np.mean(
        [majority_value == value_target(sample) for sample in validation_samples]
    )
    zero_score_mae = np.mean(
        [abs(score_target(sample)) * MAX_MARGIN for sample in validation_samples]
    )
    uniform_policy_nll = np.mean(
        [math.log(max(1, len(sample["legalActions"]))) for sample in validation_samples]
    )

    neutral_predictions: list[np.ndarray] = []
    confirmed_predictions: list[np.ndarray] = []
    ownership_targets: list[np.ndarray] = []
    for sample in validation_samples:
        target = ownership_target(sample)
        neutral_predictions.append(np.zeros_like(target))
        confirmed = np.zeros_like(target)
        for index in sample["territoryA"]:
            confirmed[int(index) // BOARD_SIZE, int(index) % BOARD_SIZE] = 1
        for index in sample["territoryB"]:
            confirmed[int(index) // BOARD_SIZE, int(index) % BOARD_SIZE] = 2
        confirmed_predictions.append(confirmed)
        ownership_targets.append(target)

    target_tensor = torch.from_numpy(np.stack(ownership_targets))
    return {
        "uniformLegalPolicy": {"policyNll": float(uniform_policy_nll)},
        "majorityValue": {
            "prediction": int(majority_value),
            "valueAccuracy": float(value_accuracy),
        },
        "zeroScore": {"scoreMaeCells": float(zero_score_mae)},
        "neutralOwnership": ownership_metrics(
            torch.from_numpy(np.stack(neutral_predictions)), target_tensor
        ),
        "currentConfirmedTerritory": ownership_metrics(
            torch.from_numpy(np.stack(confirmed_predictions)), target_tensor
        ),
    }


def main() -> None:
    args = parse_args()
    seed_everything(args.seed)
    data_path = Path(args.data)
    output_dir = Path(args.out)
    output_dir.mkdir(parents=True, exist_ok=True)
    samples = load_jsonl(data_path)
    train_samples = [sample for sample in samples if sample["split"] == "train"]
    validation_samples = [sample for sample in samples if sample["split"] == "validation"]
    if not train_samples or not validation_samples:
        raise ValueError("Both train and validation samples are required")
    train_games = {sample["gameId"] for sample in train_samples}
    validation_games = {sample["gameId"] for sample in validation_samples}
    if train_games.intersection(validation_games):
        raise ValueError("A game appears in both train and validation splits")

    device = choose_device(args.device)
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

    model = KataCatNet(args.channels, args.blocks).to(device)
    ownership_loss = nn.CrossEntropyLoss(
        weight=ownership_class_weights(train_dataset, device)
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
    checkpoint_path = output_dir / "katacat-m1.pt"
    epoch_history: list[dict[str, float]] = []

    print(
        f"KataCat M1 on {device}: train={len(train_dataset)} samples/{len(train_games)} games, "
        f"validation={len(validation_dataset)} samples/{len(validation_games)} games, "
        f"model={args.channels}x{args.blocks}"
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
                    "inputChannels": INPUT_CHANNELS,
                    "policySize": POLICY_SIZE,
                    "channels": args.channels,
                    "blocks": args.blocks,
                    "boardSize": BOARD_SIZE,
                    "maxMargin": MAX_MARGIN,
                    "epoch": epoch,
                    "validationMetrics": metrics,
                },
                checkpoint_path,
            )

    baselines = baseline_metrics(train_samples, validation_samples)
    all_metrics_finite = all(
        math.isfinite(float(value))
        for value in best_metrics.values()
        if isinstance(value, (int, float))
    )
    smoke_acceptance = {
        "gameSplitDisjoint": train_games.isdisjoint(validation_games),
        "allFourHeadsReported": all(
            key in best_metrics
            for key in (
                "policyLoss",
                "valueLoss",
                "scoreLoss",
                "ownershipLoss",
            )
        ),
        "allMetricsFinite": all_metrics_finite,
        "checkpointSaved": checkpoint_path.exists(),
    }
    smoke_acceptance["passed"] = all(smoke_acceptance.values())
    summary = {
        "schemaVersion": 1,
        "stage": "M1",
        "data": str(data_path),
        "device": str(device),
        "trainGames": len(train_games),
        "validationGames": len(validation_games),
        "trainSamples": len(train_dataset),
        "validationSamples": len(validation_dataset),
        "epochs": args.epochs,
        "bestEpoch": best_epoch,
        "bestValidation": best_metrics,
        "baselines": baselines,
        "model": {
            "inputChannels": INPUT_CHANNELS,
            "policySize": POLICY_SIZE,
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
        "smokeAcceptance": smoke_acceptance,
        "trainingSignalObserved": (
            len(epoch_history) >= 2
            and epoch_history[-1]["trainLoss"] < epoch_history[0]["trainLoss"]
        ),
        "epochHistory": epoch_history,
        "note": (
            "M1 is a pipeline and representation gate, not a strength gate. "
            "One-visit CURRENT/bootstrap policy labels are replaced by PUCT visit targets in M2."
        ),
    }
    summary_path = output_dir / "summary.json"
    summary_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Saved checkpoint from epoch {best_epoch} to {checkpoint_path}")
    print(f"Saved summary to {summary_path}")
    print(f"KATACAT_M1_SUMMARY:{json.dumps(summary, ensure_ascii=False)}")
    if not smoke_acceptance["passed"]:
        raise RuntimeError(f"M1 smoke acceptance failed: {smoke_acceptance}")


if __name__ == "__main__":
    main()
