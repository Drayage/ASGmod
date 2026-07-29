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
STARTING_CATS = 40
MAX_MARGIN = BOARD_CELLS + 3
INPUT_CHANNELS = 16
OWNERSHIP_CLASSES = {".": 0, "A": 1, "B": 2}
DIRECTIONS = ((-1, 0), (1, 0), (0, -1), (0, 1))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train the first Alley Boss Cats ownership and final-margin model."
    )
    parser.add_argument("--data", default="ownership-dataset.jsonl")
    parser.add_argument("--out", default="ownership-training")
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--channels", type=int, default=64)
    parser.add_argument("--blocks", type=int, default=4)
    parser.add_argument("--score-loss-weight", type=float, default=0.25)
    parser.add_argument("--validation-fraction", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=20260729)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    return parser.parse_args()


def seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


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
                raise ValueError(f"Sample on line {line_number} has an invalid board")
            if len(sample.get("finalOwnership", "")) != BOARD_CELLS:
                raise ValueError(f"Sample on line {line_number} has an invalid ownership label")
            samples.append(sample)
    if not samples:
        raise ValueError(f"No samples found in {path}")
    return samples


def index_plane(indices: list[int]) -> np.ndarray:
    plane = np.zeros((BOARD_SIZE, BOARD_SIZE), dtype=np.float32)
    for index in indices:
        if 0 <= index < BOARD_CELLS:
            plane[index // BOARD_SIZE, index % BOARD_SIZE] = 1.0
    return plane


def liberty_planes(board_text: str) -> tuple[np.ndarray, np.ndarray]:
    board = np.array(list(board_text), dtype="U1").reshape(BOARD_SIZE, BOARD_SIZE)
    output = {
        "A": np.zeros((BOARD_SIZE, BOARD_SIZE), dtype=np.float32),
        "B": np.zeros((BOARD_SIZE, BOARD_SIZE), dtype=np.float32),
    }
    visited: set[tuple[int, int]] = set()

    for row in range(BOARD_SIZE):
        for col in range(BOARD_SIZE):
            stone = board[row, col]
            if stone not in ("A", "B") or (row, col) in visited:
                continue

            group: list[tuple[int, int]] = []
            liberties: set[tuple[int, int]] = set()
            stack = [(row, col)]
            visited.add((row, col))

            while stack:
                current_row, current_col = stack.pop()
                group.append((current_row, current_col))
                for delta_row, delta_col in DIRECTIONS:
                    next_row = current_row + delta_row
                    next_col = current_col + delta_col
                    if not (0 <= next_row < BOARD_SIZE and 0 <= next_col < BOARD_SIZE):
                        continue
                    value = board[next_row, next_col]
                    if value == ".":
                        liberties.add((next_row, next_col))
                    elif value == stone and (next_row, next_col) not in visited:
                        visited.add((next_row, next_col))
                        stack.append((next_row, next_col))

            normalized = min(len(liberties), 4) / 4.0
            for group_row, group_col in group:
                output[str(stone)][group_row, group_col] = normalized

    return output["A"], output["B"]


def featurize(sample: dict[str, Any]) -> np.ndarray:
    board = np.array(list(sample["board"]), dtype="U1").reshape(BOARD_SIZE, BOARD_SIZE)
    features = np.zeros((INPUT_CHANNELS, BOARD_SIZE, BOARD_SIZE), dtype=np.float32)

    features[0] = board == "A"
    features[1] = board == "B"
    features[2] = board == "N"
    features[3] = board == "."
    features[4] = index_plane(sample["territoryA"])
    features[5] = index_plane(sample["territoryB"])
    features[6] = index_plane(sample["legal"])
    features[7].fill(1.0 if sample["currentPlayer"] == "A" else 0.0)
    features[8].fill(1.0 if sample["currentPlayer"] == "B" else 0.0)

    last_move = int(sample["lastMove"])
    if 0 <= last_move < BOARD_CELLS:
        features[9, last_move // BOARD_SIZE, last_move % BOARD_SIZE] = 1.0

    liberties_a, liberties_b = liberty_planes(sample["board"])
    features[10] = liberties_a
    features[11] = liberties_b
    features[12].fill(float(sample["remainingA"]) / STARTING_CATS)
    features[13].fill(float(sample["remainingB"]) / STARTING_CATS)
    features[14].fill(min(float(sample["consecutivePasses"]), 2.0) / 2.0)
    features[15].fill(min(float(sample["ply"]), 80.0) / 80.0)
    return features


def ownership_target(sample: dict[str, Any]) -> np.ndarray:
    try:
        encoded = [OWNERSHIP_CLASSES[value] for value in sample["finalOwnership"]]
    except KeyError as exc:
        raise ValueError(f"Unexpected ownership label: {exc.args[0]}") from exc
    return np.asarray(encoded, dtype=np.int64).reshape(BOARD_SIZE, BOARD_SIZE)


class OwnershipDataset(Dataset[tuple[torch.Tensor, torch.Tensor, torch.Tensor]]):
    def __init__(self, samples: list[dict[str, Any]]) -> None:
        self.features = torch.from_numpy(np.stack([featurize(sample) for sample in samples]))
        self.ownership = torch.from_numpy(np.stack([ownership_target(sample) for sample in samples]))
        margins = np.asarray([float(sample["finalMargin"]) / MAX_MARGIN for sample in samples], dtype=np.float32)
        self.margin = torch.from_numpy(margins)

    def __len__(self) -> int:
        return self.features.shape[0]

    def __getitem__(self, index: int) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        return self.features[index], self.ownership[index], self.margin[index]


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


class OwnershipNet(nn.Module):
    def __init__(self, channels: int, blocks: int) -> None:
        super().__init__()
        groups = 8 if channels % 8 == 0 else 1
        self.stem = nn.Sequential(
            nn.Conv2d(INPUT_CHANNELS, channels, kernel_size=3, padding=1, bias=False),
            nn.GroupNorm(groups, channels),
            nn.ReLU(inplace=True),
        )
        self.trunk = nn.Sequential(*(ResidualBlock(channels) for _ in range(blocks)))
        self.ownership_head = nn.Sequential(
            nn.Conv2d(channels, 32, kernel_size=1, bias=False),
            nn.GroupNorm(8, 32),
            nn.ReLU(inplace=True),
            nn.Conv2d(32, 3, kernel_size=1),
        )
        self.score_head = nn.Sequential(
            nn.Conv2d(channels, 16, kernel_size=1, bias=False),
            nn.GroupNorm(4, 16),
            nn.ReLU(inplace=True),
            nn.AdaptiveAvgPool2d(1),
            nn.Flatten(),
            nn.Linear(16, 64),
            nn.ReLU(inplace=True),
            nn.Linear(64, 1),
            nn.Tanh(),
        )

    def forward(self, inputs: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        trunk = self.trunk(self.stem(inputs))
        ownership_logits = self.ownership_head(trunk)
        margin = self.score_head(trunk).squeeze(1)
        return ownership_logits, margin


def split_by_game(
    samples: list[dict[str, Any]], validation_fraction: float, seed: int
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[int], list[int]]:
    games = sorted({int(sample["game"]) for sample in samples})
    if len(games) < 2:
        raise ValueError("At least two generated games are required for a held-out validation split")

    random.Random(seed).shuffle(games)
    validation_count = max(1, min(len(games) - 1, round(len(games) * validation_fraction)))
    validation_games = sorted(games[:validation_count])
    train_games = sorted(games[validation_count:])
    validation_set = set(validation_games)
    train_samples = [sample for sample in samples if int(sample["game"]) not in validation_set]
    validation_samples = [sample for sample in samples if int(sample["game"]) in validation_set]
    return train_samples, validation_samples, train_games, validation_games


def class_weights(dataset: OwnershipDataset, device: torch.device) -> torch.Tensor:
    counts = torch.bincount(dataset.ownership.reshape(-1), minlength=3).float()
    weights = torch.sqrt(counts.sum() / counts.clamp_min(1.0))
    weights = weights / weights.mean()
    return weights.to(device)


def ownership_metrics(prediction: torch.Tensor, target: torch.Tensor) -> dict[str, float]:
    correct = (prediction == target).float().mean().item()
    ious: list[float] = []
    per_class: dict[str, float] = {}
    for class_index, name in ((1, "A"), (2, "B")):
        predicted = prediction == class_index
        actual = target == class_index
        intersection = torch.logical_and(predicted, actual).sum().item()
        union = torch.logical_or(predicted, actual).sum().item()
        iou = float(intersection / union) if union > 0 else math.nan
        per_class[f"iou{name}"] = iou
        if not math.isnan(iou):
            ious.append(iou)
    per_class["meanTerritoryIou"] = float(sum(ious) / len(ious)) if ious else 0.0
    per_class["ownershipAccuracy"] = float(correct)
    return per_class


@torch.no_grad()
def evaluate(
    model: OwnershipNet,
    loader: DataLoader[tuple[torch.Tensor, torch.Tensor, torch.Tensor]],
    device: torch.device,
    ownership_loss: nn.CrossEntropyLoss,
    score_loss: nn.MSELoss,
    score_loss_weight: float,
) -> dict[str, float]:
    model.eval()
    losses: list[float] = []
    predictions: list[torch.Tensor] = []
    ownership_targets: list[torch.Tensor] = []
    margin_errors: list[torch.Tensor] = []

    for features, ownership, margin in loader:
        features = features.to(device)
        ownership = ownership.to(device)
        margin = margin.to(device)
        logits, predicted_margin = model(features)
        loss = ownership_loss(logits, ownership) + score_loss_weight * score_loss(predicted_margin, margin)
        losses.append(loss.item() * features.shape[0])
        predictions.append(logits.argmax(dim=1).cpu())
        ownership_targets.append(ownership.cpu())
        margin_errors.append((predicted_margin - margin).abs().cpu() * MAX_MARGIN)

    prediction = torch.cat(predictions)
    target = torch.cat(ownership_targets)
    metrics = ownership_metrics(prediction, target)
    metrics["loss"] = float(sum(losses) / len(loader.dataset))
    metrics["scoreMaeCells"] = float(torch.cat(margin_errors).mean().item())
    return metrics


def choose_device(requested: str) -> torch.device:
    if requested == "cpu":
        return torch.device("cpu")
    if requested == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA was requested but is not available")
        return torch.device("cuda")
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def main() -> None:
    args = parse_args()
    seed_everything(args.seed)
    data_path = Path(args.data)
    output_dir = Path(args.out)
    output_dir.mkdir(parents=True, exist_ok=True)

    samples = load_jsonl(data_path)
    train_samples, validation_samples, train_games, validation_games = split_by_game(
        samples, args.validation_fraction, args.seed
    )
    train_dataset = OwnershipDataset(train_samples)
    validation_dataset = OwnershipDataset(validation_samples)

    device = choose_device(args.device)
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

    model = OwnershipNet(args.channels, args.blocks).to(device)
    ownership_loss = nn.CrossEntropyLoss(weight=class_weights(train_dataset, device))
    score_loss = nn.MSELoss()
    optimizer = torch.optim.AdamW(
        model.parameters(), learning_rate=args.learning_rate, weight_decay=args.weight_decay
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=max(1, args.epochs))

    best_objective = math.inf
    best_epoch = 0
    best_metrics: dict[str, float] = {}
    checkpoint_path = output_dir / "ownership-model.pt"

    print(
        f"Training on {device}: train={len(train_dataset)} samples/{len(train_games)} games, "
        f"validation={len(validation_dataset)} samples/{len(validation_games)} games"
    )

    for epoch in range(1, args.epochs + 1):
        model.train()
        running_loss = 0.0
        for features, ownership, margin in train_loader:
            features = features.to(device, non_blocking=True)
            ownership = ownership.to(device, non_blocking=True)
            margin = margin.to(device, non_blocking=True)

            optimizer.zero_grad(set_to_none=True)
            logits, predicted_margin = model(features)
            loss = ownership_loss(logits, ownership) + args.score_loss_weight * score_loss(
                predicted_margin, margin
            )
            loss.backward()
            optimizer.step()
            running_loss += loss.item() * features.shape[0]

        scheduler.step()
        metrics = evaluate(
            model,
            validation_loader,
            device,
            ownership_loss,
            score_loss,
            args.score_loss_weight,
        )
        train_loss = running_loss / len(train_dataset)
        objective = metrics["loss"] + metrics["scoreMaeCells"] / 100.0
        print(
            f"epoch {epoch:03d} train_loss={train_loss:.4f} val_loss={metrics['loss']:.4f} "
            f"territory_iou={metrics['meanTerritoryIou']:.3f} "
            f"score_mae={metrics['scoreMaeCells']:.2f} cells"
        )

        if objective < best_objective:
            best_objective = objective
            best_epoch = epoch
            best_metrics = metrics
            torch.save(
                {
                    "modelState": model.state_dict(),
                    "inputChannels": INPUT_CHANNELS,
                    "channels": args.channels,
                    "blocks": args.blocks,
                    "boardSize": BOARD_SIZE,
                    "maxMargin": MAX_MARGIN,
                    "epoch": epoch,
                    "validationMetrics": metrics,
                },
                checkpoint_path,
            )

    summary = {
        "data": str(data_path),
        "device": str(device),
        "trainGames": train_games,
        "validationGames": validation_games,
        "trainSamples": len(train_dataset),
        "validationSamples": len(validation_dataset),
        "epochs": args.epochs,
        "bestEpoch": best_epoch,
        "bestValidation": best_metrics,
        "model": {
            "inputChannels": INPUT_CHANNELS,
            "channels": args.channels,
            "blocks": args.blocks,
            "parameters": sum(parameter.numel() for parameter in model.parameters()),
        },
        "labelCaveat": (
            "The first dataset uses quiet CURRENT-guided rollouts with capture-ending moves skipped "
            "and forced territory termination. It measures learnability, not optimal-play strength."
        ),
    }
    summary_path = output_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"Saved best checkpoint from epoch {best_epoch} to {checkpoint_path}")
    print(f"Saved training summary to {summary_path}")


if __name__ == "__main__":
    main()
