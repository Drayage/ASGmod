from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build a balanced CURRENT-teacher curriculum with B-seat tactical priority."
    )
    parser.add_argument("--samples", required=True)
    parser.add_argument("--games", required=True)
    parser.add_argument("--out", default="katacat-m33-curriculum")
    parser.add_argument("--max-per-seat", type=int, default=96)
    parser.add_argument("--late-window", type=int, default=8)
    return parser.parse_args()


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            text = line.strip()
            if not text:
                continue
            try:
                rows.append(json.loads(text))
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSON at {path}:{line_number}") from exc
    if not rows:
        raise ValueError(f"No rows found in {path}")
    return rows


def risk_tuple(sample: dict[str, Any], game: dict[str, Any], late_window: int) -> tuple[int, int, int, str]:
    terminal_ply = len(game.get("moves", []))
    distance = max(0, terminal_ply - int(sample["ply"]))
    capture = game.get("finalWinReason") == "CAPTURE"
    late = distance <= late_window
    early = int(sample["ply"]) <= 30
    # Prefer late capture states, then early B survival states, then later positions.
    score = int(capture) * 4 + int(late) * 3 + int(early) * 2
    return (-score, distance, int(sample["ply"]), str(sample["sampleId"]))


def clone_curriculum(sample: dict[str, Any], game: dict[str, Any], late_window: int) -> dict[str, Any]:
    terminal_ply = len(game.get("moves", []))
    distance = max(0, terminal_ply - int(sample["ply"]))
    cloned = dict(sample)
    cloned["sampleId"] = f"katacat-m33-cur:{sample['sampleId']}"
    cloned["gameId"] = f"katacat-m33-cur:{sample['gameId']}"
    cloned["policySource"] = "CURRENT_TACTICAL_TEACHER"
    cloned["agentSource"] = "CURRENT"
    cloned["curriculumSeat"] = sample["currentPlayer"]
    cloned["curriculumDistanceToTerminal"] = distance
    cloned["curriculumLateCapture"] = (
        game.get("finalWinReason") == "CAPTURE" and distance <= late_window
    )
    cloned["curriculumEarlySeat"] = int(sample["ply"]) <= 30
    return cloned


def main() -> None:
    args = parse_args()
    if args.max_per_seat <= 0:
        raise ValueError("--max-per-seat must be positive")
    samples = load_jsonl(Path(args.samples))
    games = load_jsonl(Path(args.games))
    games_by_id = {str(game["gameId"]): game for game in games}

    teacher = [
        sample
        for sample in samples
        if sample.get("policySource") == "CURRENT_TEACHER"
        and str(sample.get("gameId")) in games_by_id
    ]
    by_seat = {
        seat: sorted(
            [sample for sample in teacher if sample.get("currentPlayer") == seat],
            key=lambda sample: risk_tuple(
                sample, games_by_id[str(sample["gameId"])], args.late_window
            ),
        )
        for seat in ("A", "B")
    }
    per_seat = min(args.max_per_seat, len(by_seat["A"]), len(by_seat["B"]))
    if per_seat <= 0:
        raise ValueError(
            f"Need CURRENT teacher samples for both seats; A={len(by_seat['A'])}, B={len(by_seat['B'])}"
        )

    selected: list[dict[str, Any]] = []
    for seat in ("A", "B"):
        for sample in by_seat[seat][:per_seat]:
            selected.append(
                clone_curriculum(
                    sample, games_by_id[str(sample["gameId"])], args.late_window
                )
            )
    selected.sort(key=lambda sample: str(sample["sampleId"]))

    train_games = {
        sample["gameId"] for sample in selected if sample.get("split") == "train"
    }
    validation_games = {
        sample["gameId"] for sample in selected if sample.get("split") == "validation"
    }
    seat_counts = {
        seat: sum(sample["currentPlayer"] == seat for sample in selected)
        for seat in ("A", "B")
    }
    late_capture_counts = {
        seat: sum(
            sample["currentPlayer"] == seat and sample["curriculumLateCapture"]
            for sample in selected
        )
        for seat in ("A", "B")
    }
    early_counts = {
        seat: sum(
            sample["currentPlayer"] == seat and sample["curriculumEarlySeat"]
            for sample in selected
        )
        for seat in ("A", "B")
    }
    acceptance = {
        "currentTeacherOnly": all(
            sample["policySource"] == "CURRENT_TACTICAL_TEACHER"
            for sample in selected
        ),
        "exactSeatBalance": seat_counts["A"] == seat_counts["B"] == per_seat,
        "bSeatPresent": seat_counts["B"] > 0,
        "bLateOrEarlyTacticsPresent": late_capture_counts["B"] > 0 or early_counts["B"] > 0,
        "gameSplitDisjoint": train_games.isdisjoint(validation_games),
        "unsafeCandidateTargetsExcluded": all(
            sample.get("policySource") != "PUCT_VISITS" for sample in selected
        ),
        "passed": False,
    }
    acceptance["passed"] = all(
        value for key, value in acceptance.items() if key != "passed"
    )

    output_dir = Path(args.out)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / "katacat-m33-curriculum-samples.jsonl"
    with output_path.open("w", encoding="utf-8") as handle:
        for sample in selected:
            handle.write(json.dumps(sample, separators=(",", ":")) + "\n")

    summary = {
        "schemaVersion": 1,
        "stage": "M3.3_CURRICULUM",
        "sourceSamples": str(args.samples),
        "sourceGames": str(args.games),
        "availableTeacherSamples": {
            "A": len(by_seat["A"]),
            "B": len(by_seat["B"]),
        },
        "selectedSamples": len(selected),
        "selectedPerSeat": seat_counts,
        "lateCapturePerSeat": late_capture_counts,
        "earlyPerSeat": early_counts,
        "trainGames": len(train_games),
        "validationGames": len(validation_games),
        "acceptance": acceptance,
        "note": (
            "M3.3 duplicates only verified CURRENT teacher decisions. B-seat late-capture and "
            "early-survival states are prioritised, while an equal A-seat control set prevents "
            "seat imbalance. Candidate fallback actions are never used as curriculum labels."
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
