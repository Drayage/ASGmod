from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import torch

from katacat_m33_relative import relative_featurize
from train_katacat_m1 import POLICY_SIZE, KataCatNet

PAIR_RE = re.compile(r"^(?P<pair>.+-p\d+)-[AB]$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Prepare M3.7.1 parent-preserving soft policy targets, pair-level splits, "
            "and territory-balanced training rows."
        )
    )
    parser.add_argument("--league-data", required=True)
    parser.add_argument("--hard-negative-data", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--out", default="katacat-m371-data")
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--temperature", type=float, default=1.0)
    parser.add_argument("--candidate-executed-boost", type=float, default=0.15)
    parser.add_argument("--current-executed-boost", type=float, default=0.08)
    parser.add_argument("--hard-positive-boost", type=float, default=0.15)
    parser.add_argument("--territory-train-copies", type=int, default=6)
    parser.add_argument("--pair-validation-modulo", type=int, default=5)
    return parser.parse_args()


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            text = line.strip()
            if not text:
                continue
            try:
                row = json.loads(text)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSON at {path}:{line_number}") from exc
            rows.append(row)
    if not rows:
        raise ValueError(f"No rows found in {path}")
    return rows


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.write_text(
        "".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows),
        encoding="utf-8",
    )


def pair_id(game_id: str) -> str:
    match = PAIR_RE.match(game_id)
    if match is None:
        raise ValueError(f"M3.7.1 cannot parse mirrored pair from gameId={game_id}")
    return match.group("pair")


def pair_split(identifier: str, modulo: int) -> str:
    if modulo < 2:
        raise ValueError("--pair-validation-modulo must be at least 2")
    bucket = int(hashlib.sha256(identifier.encode("utf-8")).hexdigest()[:8], 16) % modulo
    return "validation" if bucket == 0 else "train"


def load_model(path: Path) -> KataCatNet:
    checkpoint = torch.load(path, map_location="cpu")
    if checkpoint.get("encodingVersion") != "PLAYER_RELATIVE_V1":
        raise ValueError("M3.7.1 requires a PLAYER_RELATIVE_V1 checkpoint")
    model = KataCatNet(int(checkpoint["channels"]), int(checkpoint["blocks"]))
    model.load_state_dict(checkpoint["modelState"])
    model.eval()
    return model


def batched_parent_logits(
    model: KataCatNet,
    rows: list[dict[str, Any]],
    batch_size: int,
) -> list[np.ndarray]:
    if batch_size <= 0:
        raise ValueError("--batch-size must be positive")
    outputs: list[np.ndarray] = []
    with torch.no_grad():
        for start in range(0, len(rows), batch_size):
            batch = rows[start : start + batch_size]
            features = torch.from_numpy(
                np.stack([relative_featurize(row) for row in batch]).astype(np.float32)
            )
            logits = model(features)[0].cpu().numpy()
            outputs.extend(np.asarray(row, dtype=np.float64) for row in logits)
    if len(outputs) != len(rows):
        raise RuntimeError("Parent inference row count mismatch")
    return outputs


def legal_parent_distribution(
    logits: np.ndarray,
    legal_actions: list[int],
    negative_actions: set[int],
    temperature: float,
) -> np.ndarray:
    if temperature <= 0:
        raise ValueError("--temperature must be positive")
    legal = sorted({int(action) for action in legal_actions if 0 <= int(action) < POLICY_SIZE})
    usable = [action for action in legal if action not in negative_actions]
    if not usable:
        raise ValueError("All legal policy actions were masked as negative")
    scaled = np.asarray([logits[action] / temperature for action in usable], dtype=np.float64)
    scaled -= float(np.max(scaled))
    probabilities = np.exp(scaled)
    total = float(probabilities.sum())
    if not math.isfinite(total) or total <= 0:
        probabilities = np.full(len(usable), 1.0 / len(usable), dtype=np.float64)
    else:
        probabilities /= total
    target = np.zeros(POLICY_SIZE, dtype=np.float64)
    target[usable] = probabilities
    return target


def blend_target(
    parent: np.ndarray,
    positive_action: int,
    boost: float,
    negative_actions: set[int],
) -> np.ndarray:
    if not 0 <= boost < 1:
        raise ValueError("Policy boost must be in [0, 1)")
    if not 0 <= positive_action < POLICY_SIZE:
        raise ValueError(f"Invalid positive action: {positive_action}")
    if positive_action in negative_actions:
        raise ValueError(f"Positive action {positive_action} is also negative")
    target = (1.0 - boost) * parent
    target[positive_action] += boost
    for action in negative_actions:
        if 0 <= action < POLICY_SIZE:
            target[action] = 0.0
    total = float(target.sum())
    if not math.isfinite(total) or total <= 0:
        raise ValueError("Prepared policy target is empty or non-finite")
    target /= total
    return target


def sparse_policy(target: np.ndarray) -> list[dict[str, float | int]]:
    return [
        {"action": int(index), "visits": float(value)}
        for index, value in enumerate(target)
        if value > 1e-10
    ]


def prepare_row(
    row: dict[str, Any],
    logits: np.ndarray,
    boost: float,
    split: str,
    stage: str,
    temperature: float,
) -> dict[str, Any]:
    prepared = copy.deepcopy(row)
    positive = int(row.get("positiveAction", row.get("executedAction", -1)))
    negatives = {
        int(action)
        for action in row.get("negativeActions", [])
        if 0 <= int(action) < POLICY_SIZE
    }
    parent = legal_parent_distribution(
        logits,
        [int(action) for action in row["legalActions"]],
        negatives,
        temperature,
    )
    target = blend_target(parent, positive, boost, negatives)
    prepared.update(
        {
            "schemaVersion": max(2, int(row.get("schemaVersion", 1))),
            "split": split,
            "trainingStage": stage,
            "positiveAction": positive,
            "negativeActions": sorted(negatives),
            "policyTarget": sparse_policy(target),
            "policyTargetMode": "PARENT_LEGAL_SOFTMAX_PLUS_VERIFIED_ACTION_BOOST",
            "parentPolicyTopAction": int(parent.argmax()),
            "parentExecutedProbability": float(parent[positive]),
            "softTargetExecutedProbability": float(target[positive]),
            "softTargetEntropy": float(-(target[target > 0] * np.log(target[target > 0])).sum()),
        }
    )
    return prepared


def target_is_valid(row: dict[str, Any]) -> bool:
    total = sum(float(item["visits"]) for item in row["policyTarget"])
    legal = {int(action) for action in row["legalActions"]}
    negatives = {int(action) for action in row.get("negativeActions", [])}
    actions = {int(item["action"]) for item in row["policyTarget"] if float(item["visits"]) > 0}
    return (
        math.isclose(total, 1.0, rel_tol=0, abs_tol=1e-6)
        and actions.issubset(legal)
        and actions.isdisjoint(negatives)
        and int(row["positiveAction"]) in actions
    )


def summarize_policy(rows: list[dict[str, Any]]) -> dict[str, float]:
    return {
        "rows": float(len(rows)),
        "parentTopMatchesPositive": float(
            sum(int(row["parentPolicyTopAction"]) == int(row["positiveAction"]) for row in rows)
            / max(1, len(rows))
        ),
        "meanParentPositiveProbability": float(
            sum(float(row["parentExecutedProbability"]) for row in rows) / max(1, len(rows))
        ),
        "meanSoftTargetPositiveProbability": float(
            sum(float(row["softTargetExecutedProbability"]) for row in rows) / max(1, len(rows))
        ),
        "meanSoftTargetEntropy": float(
            sum(float(row["softTargetEntropy"]) for row in rows) / max(1, len(rows))
        ),
    }


def main() -> None:
    args = parse_args()
    output = Path(args.out)
    output.mkdir(parents=True, exist_ok=True)

    league = load_jsonl(Path(args.league_data))
    hard = load_jsonl(Path(args.hard_negative_data))
    model = load_model(Path(args.checkpoint))

    league_logits = batched_parent_logits(model, league, args.batch_size)
    hard_logits = batched_parent_logits(model, hard, args.batch_size)

    prepared_original: list[dict[str, Any]] = []
    for row, logits in zip(league, league_logits, strict=True):
        identifier = pair_id(str(row["gameId"]))
        split = pair_split(identifier, args.pair_validation_modulo)
        boost = (
            args.candidate_executed_boost
            if row.get("agentSource") == "M341_READER_CHECKED_PUCT"
            else args.current_executed_boost
        )
        prepared = prepare_row(
            row, logits, boost, split, "M3.7.1", args.temperature
        )
        prepared["pairId"] = identifier
        prepared_original.append(prepared)

    prepared_league: list[dict[str, Any]] = []
    territory_original = 0
    territory_extra = 0
    for row in prepared_original:
        prepared_league.append(row)
        if row.get("finalWinReason") != "TERRITORY":
            continue
        territory_original += 1
        if row["split"] != "train":
            continue
        for copy_index in range(1, max(1, args.territory_train_copies)):
            duplicate = copy.deepcopy(row)
            duplicate["sampleId"] = f"{row['sampleId']}:territory-copy-{copy_index}"
            duplicate["territoryOversampleCopy"] = copy_index
            prepared_league.append(duplicate)
            territory_extra += 1

    prepared_hard = [
        prepare_row(
            row,
            logits,
            args.hard_positive_boost,
            str(row["split"]),
            "M3.7.1_HARD_NEGATIVE",
            args.temperature,
        )
        for row, logits in zip(hard, hard_logits, strict=True)
    ]

    prepared_league.sort(key=lambda row: str(row["sampleId"]))
    prepared_hard.sort(key=lambda row: str(row["sampleId"]))

    pair_splits: dict[str, set[str]] = {}
    for row in prepared_original:
        pair_splits.setdefault(str(row["pairId"]), set()).add(str(row["split"]))
    train_pairs = {pair for pair, splits in pair_splits.items() if splits == {"train"}}
    validation_pairs = {pair for pair, splits in pair_splits.items() if splits == {"validation"}}
    malformed_pairs = {pair: sorted(splits) for pair, splits in pair_splits.items() if len(splits) != 1}

    original_sample_ids = [str(row["sampleId"]) for row in prepared_original]
    emitted_sample_ids = [str(row["sampleId"]) for row in prepared_league]
    effective_territory = sum(row.get("finalWinReason") == "TERRITORY" for row in prepared_league)
    negative_rows = [row for row in prepared_hard if row.get("negativeActions")]

    acceptance = {
        "leagueRowsPreserved": len(prepared_original) == len(league),
        "uniqueOriginalSampleIds": len(set(original_sample_ids)) == len(original_sample_ids),
        "uniqueEmittedSampleIds": len(set(emitted_sample_ids)) == len(emitted_sample_ids),
        "mirroredPairsShareSplit": not malformed_pairs,
        "pairSplitsDisjoint": train_pairs.isdisjoint(validation_pairs),
        "bothPairSplitsPresent": bool(train_pairs) and bool(validation_pairs),
        "validationNotOversampled": all(
            "territoryOversampleCopy" not in row
            for row in prepared_league
            if row["split"] == "validation"
        ),
        "territoryRowsUpweighted": effective_territory > territory_original,
        "allLeagueTargetsValid": all(target_is_valid(row) for row in prepared_league),
        "allHardTargetsValid": all(target_is_valid(row) for row in prepared_hard),
        "hardNegativeMasksPreserved": bool(negative_rows)
        and len(negative_rows) == len(prepared_hard),
        "parentCheckpointUsed": Path(args.checkpoint).is_file(),
        "passed": False,
    }
    acceptance["passed"] = all(
        bool(value) for key, value in acceptance.items() if key != "passed"
    )

    write_jsonl(output / "katacat-m371-league-samples.jsonl", prepared_league)
    write_jsonl(output / "katacat-m371-hard-negative-samples.jsonl", prepared_hard)

    summary = {
        "schemaVersion": 1,
        "stage": "M3.7.1_PARENT_PRESERVING_TARGET_PREPARATION",
        "options": {
            "temperature": args.temperature,
            "candidateExecutedBoost": args.candidate_executed_boost,
            "currentExecutedBoost": args.current_executed_boost,
            "hardPositiveBoost": args.hard_positive_boost,
            "territoryTrainCopies": args.territory_train_copies,
            "pairValidationModulo": args.pair_validation_modulo,
        },
        "league": {
            "inputRows": len(league),
            "originalPreparedRows": len(prepared_original),
            "emittedTrainingRows": len(prepared_league),
            "trainRows": sum(row["split"] == "train" for row in prepared_league),
            "validationRows": sum(row["split"] == "validation" for row in prepared_league),
            "pairs": len(pair_splits),
            "trainPairs": len(train_pairs),
            "validationPairs": len(validation_pairs),
            "malformedPairs": malformed_pairs,
            "territoryOriginalRows": territory_original,
            "territoryExtraTrainRows": territory_extra,
            "territoryEffectiveRows": effective_territory,
            "captureEffectiveRows": sum(
                row.get("finalWinReason") == "CAPTURE" for row in prepared_league
            ),
            "policy": summarize_policy(prepared_original),
        },
        "hardNegative": {
            "inputRows": len(hard),
            "emittedRows": len(prepared_hard),
            "rowsWithNegativeMasks": len(negative_rows),
            "meanNegativeActions": float(
                sum(len(row.get("negativeActions", [])) for row in prepared_hard)
                / max(1, len(prepared_hard))
            ),
            "policy": summarize_policy(prepared_hard),
        },
        "acceptance": acceptance,
        "note": (
            "M3.7.1 keeps the M3.4.1 legal-action policy distribution as the dominant target, "
            "adds only a bounded boost to the verified executed action, removes proven negative actions, "
            "assigns both mirrored seats of a pair to the same split, and upweights territory-terminal "
            "training rows without duplicating validation rows."
        ),
    }
    (output / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({"acceptance": acceptance, "leagueRows": len(prepared_league)}))
    if not acceptance["passed"]:
        raise SystemExit("M3.7.1 data preparation acceptance failed")


if __name__ == "__main__":
    main()
