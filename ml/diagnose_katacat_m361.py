from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path
from typing import Any

import torch

from katacat_m33_relative import relative_featurize
from katacat_m36_adapter import load_m36_checkpoint


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Diagnose repeated M3.6 residual-adapter regressions.")
    parser.add_argument("--training-summary", required=True)
    parser.add_argument("--hard-negative-data", required=True)
    parser.add_argument("--checkpoint", action="append", required=True, help="id=path; repeatable")
    parser.add_argument("--epochs", default="8,13,16")
    parser.add_argument("--top-regressions", type=int, default=3)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_checkpoint(value: str) -> tuple[str, Path]:
    if "=" not in value:
        raise ValueError(f"checkpoint must be id=path, got {value!r}")
    name, path = value.split("=", 1)
    if not name or not path:
        raise ValueError(f"checkpoint must be id=path, got {value!r}")
    return name, Path(path)


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in path.read_text().splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def epoch_row(summary: dict[str, Any], epoch: int) -> dict[str, Any]:
    for row in summary.get("epochHistory", []):
        if int(row.get("epoch", -1)) == epoch:
            return row
    raise ValueError(f"epoch {epoch} missing from training summary")


def regression_details(row: dict[str, Any]) -> list[dict[str, Any]]:
    return list(row.get("frozenTacticalValidation", {}).get("regressionFailureDetails", []))


def legal_rank(logits: torch.Tensor, legal: list[int], action: int) -> int | None:
    if action not in legal:
        return None
    ordered = sorted(legal, key=lambda index: (-float(logits[index]), index))
    return ordered.index(action) + 1


def inspect_checkpoint(name: str, path: Path, sample: dict[str, Any]) -> dict[str, Any]:
    loaded = load_m36_checkpoint(path)
    model = loaded.model
    features = torch.from_numpy(relative_featurize(sample)).unsqueeze(0)
    with torch.no_grad():
        corrected, _base, delta = model.policy_outputs(features)
        probabilities = torch.softmax(corrected, dim=1)[0]
    logits = corrected[0]
    residual = delta[0]
    legal = [int(value) for value in sample["legalActions"]]
    positive = int(sample["positiveAction"])
    negatives = sorted({int(value) for value in sample.get("negativeActions", []) if int(value) in legal})
    best_negative = max(negatives, key=lambda index: (float(logits[index]), -index)) if negatives else None
    top_action = max(legal, key=lambda index: (float(logits[index]), -index))
    positive_logit = float(logits[positive])
    best_negative_logit = float(logits[best_negative]) if best_negative is not None else None
    return {
        "id": name,
        "checkpoint": str(path),
        "sha256": sha256_file(path),
        "epoch": int(loaded.checkpoint.get("epoch", -1)),
        "topLegalAction": top_action,
        "topLegalActionIsNegative": top_action in negatives,
        "positiveAction": positive,
        "positiveRank": legal_rank(logits, legal, positive),
        "positiveLogit": positive_logit,
        "positiveProbability": float(probabilities[positive]),
        "positiveResidual": float(residual[positive]),
        "bestNegativeAction": best_negative,
        "bestNegativeRank": legal_rank(logits, legal, best_negative) if best_negative is not None else None,
        "bestNegativeLogit": best_negative_logit,
        "bestNegativeProbability": float(probabilities[best_negative]) if best_negative is not None else None,
        "bestNegativeResidual": float(residual[best_negative]) if best_negative is not None else None,
        "positiveMinusBestNegative": (
            positive_logit - best_negative_logit if best_negative_logit is not None else None
        ),
        "meanAbsLegalResidual": sum(abs(float(residual[index])) for index in legal) / max(1, len(legal)),
        "maxAbsLegalResidual": max((abs(float(residual[index])) for index in legal), default=0.0),
    }


def main() -> None:
    args = parse_args()
    training = json.loads(Path(args.training_summary).read_text())
    epochs = [int(value) for value in args.epochs.split(",") if value.strip()]
    rows = {int(row["epoch"]): row for row in training.get("epochHistory", [])}
    missing = [epoch for epoch in epochs if epoch not in rows]
    if missing:
        raise ValueError(f"missing epochs: {missing}")

    counts: Counter[str] = Counter()
    detail_by_hash: dict[str, dict[str, Any]] = {}
    epoch_regressions: dict[str, list[str]] = {}
    for epoch in epochs:
        hashes: list[str] = []
        for detail in regression_details(rows[epoch]):
            position_hash = str(detail["positionHash"])
            counts[position_hash] += 1
            detail_by_hash[position_hash] = detail
            hashes.append(position_hash)
        epoch_regressions[str(epoch)] = sorted(hashes)

    ranked_hashes = sorted(counts, key=lambda value: (-counts[value], value))[: args.top_regressions]
    source_rows = load_jsonl(Path(args.hard_negative_data))
    source_by_hash = {str(row["positionHash"]): row for row in source_rows}
    missing_rows = [value for value in ranked_hashes if value not in source_by_hash]
    if missing_rows:
        raise ValueError(f"repeated regression positions missing from hard-negative data: {missing_rows}")

    checkpoints = [parse_checkpoint(value) for value in args.checkpoint]
    checkpoint_ids = [name for name, _ in checkpoints]
    if len(set(checkpoint_ids)) != len(checkpoint_ids):
        raise ValueError("checkpoint ids must be unique")

    positions: list[dict[str, Any]] = []
    for position_hash in ranked_hashes:
        sample = source_by_hash[position_hash]
        detail = detail_by_hash[position_hash]
        positions.append(
            {
                "positionHash": position_hash,
                "occurrencesAcrossSelectedEpochs": counts[position_hash],
                "sampleId": sample.get("sampleId"),
                "gameId": sample.get("gameId"),
                "currentPlayer": sample.get("currentPlayer"),
                "ply": sample.get("ply"),
                "positiveAction": sample.get("positiveAction"),
                "negativeActions": sample.get("negativeActions", []),
                "parentTrainingDiagnostic": detail.get("parent"),
                "models": [inspect_checkpoint(name, path, sample) for name, path in checkpoints],
            }
        )

    epoch_validation: list[dict[str, Any]] = []
    for epoch in epochs:
        row = epoch_row(training, epoch)
        general = row.get("generalValidation", {})
        tactical = row.get("frozenTacticalValidation", {})
        adapter = row.get("adapterValidation", {})
        epoch_validation.append(
            {
                "epoch": epoch,
                "generalPolicyLoss": general.get("policyLoss"),
                "generalPolicyTop1": general.get("policyTop1"),
                "baseToCandidateKl": adapter.get("baseToCandidateKl"),
                "meanAbsResidualLogit": adapter.get("meanAbsResidualLogit"),
                "negativeTop1Rate": tactical.get("negativeTop1Rate"),
                "pairwiseLoss": tactical.get("pairwiseLoss"),
                "meanMargin": tactical.get("meanMargin"),
                "regressionFailuresVsParent": tactical.get("regressionFailuresVsParent"),
                "eligible": row.get("eligible"),
            }
        )

    acceptance = {
        "requestedEpochsPresent": not missing,
        "repeatedRegressionPositionsPresent": len(positions) == args.top_regressions,
        "sourceRowsResolved": not missing_rows,
        "checkpointSetComplete": len(checkpoints) >= 4,
        "allCheckpointFilesPresent": all(path.is_file() for _, path in checkpoints),
        "noRandomRollouts": True,
    }
    acceptance["passed"] = all(acceptance.values())

    summary = {
        "schemaVersion": 1,
        "stage": "M3.6.1_REJECTED_EPOCH_DIAGNOSTIC",
        "sourceTrainingSummary": args.training_summary,
        "selectedEpochs": epochs,
        "checkpointIds": checkpoint_ids,
        "epochValidation": epoch_validation,
        "regressionFrequency": dict(sorted(counts.items(), key=lambda item: (-item[1], item[0]))),
        "epochRegressionPositionHashes": epoch_regressions,
        "repeatedRegressionPositions": positions,
        "acceptance": acceptance,
        "note": (
            "Positive actions come from the bounded-reader teacher target. A negative action is proved refuted "
            "under the configured tactical reader; teacher non-refutation is not a mathematical proof of safety."
        ),
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({"passed": acceptance["passed"], "positions": len(positions)}))
    if not acceptance["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
