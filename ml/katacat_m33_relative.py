from __future__ import annotations

import copy
import json
import random
import sys
from typing import Any

import numpy as np
import torch
from torch.utils.data import Dataset

from train_katacat_m1 import (
    BOARD_CELLS,
    BOARD_SIZE,
    INPUT_CHANNELS,
    MAX_MARGIN,
    PASS_INDEX,
    STARTING_CATS,
    apply_symmetry,
    policy_target,
    score_target,
    value_target,
)


def index_plane(indices: list[int]) -> np.ndarray:
    plane = np.zeros((BOARD_SIZE, BOARD_SIZE), dtype=np.float32)
    for index in indices:
        value = int(index)
        if 0 <= value < BOARD_CELLS:
            plane[value // BOARD_SIZE, value % BOARD_SIZE] = 1.0
    return plane


def relative_featurize(sample: dict[str, Any]) -> np.ndarray:
    """Encode every position from state.currentPlayer's point of view.

    Plane semantics stay fixed regardless of whether the mover is A or B:
      0 self stones, 1 opponent stones, 2 neutral, 3 empty,
      4 self confirmed territory, 5 opponent confirmed territory, 6 legal moves,
      7 mover is first player A, 8 mover is second player B, 9 last action,
      10 self cats remaining, 11 opponent cats remaining, 12 consecutive passes,
      13 ply, 14 signed first-player margin, 15 PASS legal.
    """
    board = np.asarray(list(sample["board"]), dtype="U1").reshape(BOARD_SIZE, BOARD_SIZE)
    player = str(sample["currentPlayer"])
    if player not in ("A", "B"):
        raise ValueError(f"Unexpected currentPlayer {player}")
    opponent = "B" if player == "A" else "A"
    self_territory = sample["territoryA"] if player == "A" else sample["territoryB"]
    opponent_territory = sample["territoryB"] if player == "A" else sample["territoryA"]
    self_remaining = sample["remainingA"] if player == "A" else sample["remainingB"]
    opponent_remaining = sample["remainingB"] if player == "A" else sample["remainingA"]

    features = np.zeros((INPUT_CHANNELS, BOARD_SIZE, BOARD_SIZE), dtype=np.float32)
    features[0] = board == player
    features[1] = board == opponent
    features[2] = board == "N"
    features[3] = board == "."
    features[4] = index_plane(self_territory)
    features[5] = index_plane(opponent_territory)
    features[6] = index_plane([index for index in sample["legalActions"] if int(index) < BOARD_CELLS])
    features[7].fill(1.0 if player == "A" else 0.0)
    features[8].fill(1.0 if player == "B" else 0.0)
    last_action = int(sample["lastAction"])
    if 0 <= last_action < BOARD_CELLS:
        features[9, last_action // BOARD_SIZE, last_action % BOARD_SIZE] = 1.0
    features[10].fill(float(self_remaining) / STARTING_CATS)
    features[11].fill(float(opponent_remaining) / STARTING_CATS)
    features[12].fill(min(float(sample["consecutivePasses"]), 2.0) / 2.0)
    features[13].fill(min(float(sample["ply"]), 90.0) / 90.0)
    signed_margin = 3.0 / BOARD_CELLS if player == "A" else -3.0 / BOARD_CELLS
    features[14].fill(signed_margin)
    features[15].fill(1.0 if PASS_INDEX in sample["legalActions"] else 0.0)
    return features


def relative_ownership_target(sample: dict[str, Any]) -> np.ndarray:
    player = str(sample["currentPlayer"])
    opponent = "B" if player == "A" else "A"
    classes = {".": 0, player: 1, opponent: 2}
    try:
        values = [classes[value] for value in sample["finalOwnership"]]
    except KeyError as exc:
        raise ValueError(f"Unexpected ownership label {exc.args[0]}") from exc
    return np.asarray(values, dtype=np.int64).reshape(BOARD_SIZE, BOARD_SIZE)


def swap_token(value: str) -> str:
    if value == "A":
        return "B"
    if value == "B":
        return "A"
    return value


def seat_swap_sample(sample: dict[str, Any]) -> dict[str, Any]:
    """Create the color-swapped training twin while preserving mover-relative labels."""
    swapped = copy.deepcopy(sample)
    swapped["sampleId"] = f"{sample['sampleId']}:seat-swap"
    swapped["gameId"] = f"{sample['gameId']}:seat-swap"
    swapped["board"] = "".join(swap_token(value) for value in sample["board"])
    swapped["currentPlayer"] = swap_token(str(sample["currentPlayer"]))
    swapped["territoryA"], swapped["territoryB"] = list(sample["territoryB"]), list(sample["territoryA"])
    swapped["remainingA"], swapped["remainingB"] = sample["remainingB"], sample["remainingA"]
    swapped["finalWinner"] = swap_token(str(sample["finalWinner"]))
    swapped["finalAdjustedMarginA"] = -float(sample["finalAdjustedMarginA"])
    swapped["finalOwnership"] = "".join(swap_token(value) for value in sample["finalOwnership"])
    swapped["seatSwapped"] = True
    return swapped


def expand_seat_balanced(samples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    expanded: list[dict[str, Any]] = []
    for sample in samples:
        expanded.append(sample)
        expanded.append(seat_swap_sample(sample))
    return expanded


class RelativeKataCatDataset(
    Dataset[tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]]
):
    def __init__(self, samples: list[dict[str, Any]], augment: bool) -> None:
        self.samples = samples
        self.augment = augment
        self.features = [relative_featurize(sample) for sample in samples]
        self.policies = [policy_target(sample) for sample in samples]
        self.ownership = [relative_ownership_target(sample) for sample in samples]
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


def self_test() -> dict[str, Any]:
    sample = {
        "sampleId": "relative-self-test",
        "gameId": "relative-self-test-game",
        "split": "train",
        "board": "A" + "." * 39 + "N" + "." * 39 + "B",
        "currentPlayer": "A",
        "legalActions": [1, 2, PASS_INDEX],
        "territoryA": [3],
        "territoryB": [77],
        "remainingA": 31,
        "remainingB": 27,
        "consecutivePasses": 0,
        "lastAction": 80,
        "ply": 12,
        "policyTarget": [{"action": 1, "visits": 3}, {"action": 2, "visits": 1}],
        "finalWinner": "A",
        "finalAdjustedMarginA": 5,
        "finalOwnership": "A" + "." * 79 + "B",
    }
    swapped = seat_swap_sample(sample)
    original_features = relative_featurize(sample)
    swapped_features = relative_featurize(swapped)
    invariant_planes = [0, 1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 15]
    invariant = all(
        np.array_equal(original_features[index], swapped_features[index])
        for index in invariant_planes
    )
    ownership_invariant = np.array_equal(
        relative_ownership_target(sample), relative_ownership_target(swapped)
    )
    score_invariant = score_target(sample) == score_target(swapped)
    value_invariant = value_target(sample) == value_target(swapped)
    seat_planes_swapped = (
        float(original_features[7, 0, 0]) == 1.0
        and float(original_features[8, 0, 0]) == 0.0
        and float(swapped_features[7, 0, 0]) == 0.0
        and float(swapped_features[8, 0, 0]) == 1.0
    )
    signed_margin_flipped = float(original_features[14, 0, 0]) == -float(swapped_features[14, 0, 0])
    result = {
        "relativeInvariantPlanes": invariant,
        "relativeOwnershipInvariant": ownership_invariant,
        "relativeScoreInvariant": score_invariant,
        "relativeValueInvariant": value_invariant,
        "seatPlanesSwapped": seat_planes_swapped,
        "signedMarginFlipped": signed_margin_flipped,
        "passed": False,
    }
    result["passed"] = all(value for key, value in result.items() if key != "passed")
    if not result["passed"]:
        raise AssertionError(json.dumps(result, indent=2))
    return result


if __name__ == "__main__":
    if "--self-test" not in sys.argv:
        raise SystemExit("Use --self-test")
    print(json.dumps(self_test(), separators=(",", ":")))
