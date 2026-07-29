from __future__ import annotations

import argparse
import json
import random
from pathlib import Path
from typing import Any

BOARD_SIZE = 9
BOARD_CELLS = BOARD_SIZE * BOARD_SIZE
FIRST_PLAYER_MARGIN = 3


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Measure trivial baselines on the held-out ownership games.")
    parser.add_argument("--data", default="ownership-dataset.jsonl")
    parser.add_argument("--out", default="ownership-training/baseline.json")
    parser.add_argument("--validation-fraction", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=20260729)
    return parser.parse_args()


def load_samples(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as handle:
        samples = [json.loads(line) for line in handle if line.strip()]
    if not samples:
        raise ValueError(f"No samples found in {path}")
    return samples


def validation_samples(
    samples: list[dict[str, Any]], validation_fraction: float, seed: int
) -> tuple[list[dict[str, Any]], list[int]]:
    games = sorted({int(sample["game"]) for sample in samples})
    if len(games) < 2:
        raise ValueError("At least two games are required for validation")
    random.Random(seed).shuffle(games)
    count = max(1, min(len(games) - 1, round(len(games) * validation_fraction)))
    selected = sorted(games[:count])
    selected_set = set(selected)
    return [sample for sample in samples if int(sample["game"]) in selected_set], selected


def encode_final(text: str) -> list[int]:
    mapping = {".": 0, "A": 1, "B": 2}
    return [mapping[value] for value in text]


def current_territory_prediction(sample: dict[str, Any]) -> list[int]:
    prediction = [0] * BOARD_CELLS
    for index in sample["territoryA"]:
        prediction[int(index)] = 1
    for index in sample["territoryB"]:
        prediction[int(index)] = 2
    return prediction


def iou(predictions: list[list[int]], targets: list[list[int]], class_index: int) -> float:
    intersection = 0
    union = 0
    for prediction, target in zip(predictions, targets):
        for predicted_value, target_value in zip(prediction, target):
            predicted = predicted_value == class_index
            actual = target_value == class_index
            if predicted and actual:
                intersection += 1
            if predicted or actual:
                union += 1
    return intersection / union if union else 0.0


def accuracy(predictions: list[list[int]], targets: list[list[int]]) -> float:
    correct = 0
    total = 0
    for prediction, target in zip(predictions, targets):
        for predicted_value, target_value in zip(prediction, target):
            correct += int(predicted_value == target_value)
            total += 1
    return correct / total


def metrics_for(predictions: list[list[int]], targets: list[list[int]]) -> dict[str, float]:
    iou_a = iou(predictions, targets, 1)
    iou_b = iou(predictions, targets, 2)
    return {
        "ownershipAccuracy": accuracy(predictions, targets),
        "iouA": iou_a,
        "iouB": iou_b,
        "meanTerritoryIou": (iou_a + iou_b) / 2,
    }


def main() -> None:
    args = parse_args()
    samples = load_samples(Path(args.data))
    validation, games = validation_samples(samples, args.validation_fraction, args.seed)
    targets = [encode_final(sample["finalOwnership"]) for sample in validation]

    neutral_predictions = [[0] * BOARD_CELLS for _ in validation]
    current_predictions = [current_territory_prediction(sample) for sample in validation]
    current_score_errors = [
        abs(
            (len(sample["territoryA"]) - len(sample["territoryB"]) - FIRST_PLAYER_MARGIN)
            - float(sample["finalMargin"])
        )
        for sample in validation
    ]
    zero_score_errors = [abs(float(sample["finalMargin"])) for sample in validation]

    result = {
        "validationGames": games,
        "validationSamples": len(validation),
        "neutralOwnership": metrics_for(neutral_predictions, targets),
        "currentConfirmedTerritory": {
            **metrics_for(current_predictions, targets),
            "scoreMaeCells": sum(current_score_errors) / len(current_score_errors),
        },
        "zeroMargin": {
            "scoreMaeCells": sum(zero_score_errors) / len(zero_score_errors),
        },
    }

    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"Saved baseline metrics to {output}")


if __name__ == "__main__":
    main()
