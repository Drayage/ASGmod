from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create an M3.3-specific game-level split from replayable M3.1 mixed data."
    )
    parser.add_argument("--samples", required=True)
    parser.add_argument("--games", required=True)
    parser.add_argument("--out", default="katacat-m33-mixed")
    parser.add_argument("--validation-modulo", type=int, default=6)
    parser.add_argument("--validation-offset", type=int, default=0)
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


def main() -> None:
    args = parse_args()
    if args.validation_modulo < 2:
        raise ValueError("--validation-modulo must be at least 2")
    offset = args.validation_offset % args.validation_modulo
    games = load_jsonl(Path(args.games))
    samples = load_jsonl(Path(args.samples))

    split_by_game: dict[str, str] = {}
    resplit_games: list[dict[str, Any]] = []
    for game in games:
        game_index = int(game["gameIndex"])
        split = "validation" if game_index % args.validation_modulo == offset else "train"
        split_by_game[str(game["gameId"])] = split
        resplit_games.append({**game, "sourceSplit": game.get("split"), "split": split})

    resplit_samples: list[dict[str, Any]] = []
    for sample in samples:
        game_id = str(sample["gameId"])
        if game_id not in split_by_game:
            raise ValueError(f"Sample references unknown game {game_id}")
        resplit_samples.append(
            {**sample, "sourceSplit": sample.get("split"), "split": split_by_game[game_id]}
        )

    train_games = {game["gameId"] for game in resplit_games if game["split"] == "train"}
    validation_games = {
        game["gameId"] for game in resplit_games if game["split"] == "validation"
    }
    train_teacher = [
        sample
        for sample in resplit_samples
        if sample["split"] == "train" and sample.get("policySource") == "CURRENT_TEACHER"
    ]
    validation_teacher = [
        sample
        for sample in resplit_samples
        if sample["split"] == "validation" and sample.get("policySource") == "CURRENT_TEACHER"
    ]
    teacher_seats = {
        seat: sum(sample.get("currentPlayer") == seat for sample in train_teacher)
        for seat in ("A", "B")
    }
    acceptance = {
        "trainAndValidationPresent": bool(train_games) and bool(validation_games),
        "gameSplitDisjoint": train_games.isdisjoint(validation_games),
        "allSamplesFollowGameSplit": all(
            sample["split"] == split_by_game[str(sample["gameId"])]
            for sample in resplit_samples
        ),
        "bothCurrentTeacherSeatsInTrain": teacher_seats["A"] > 0 and teacher_seats["B"] > 0,
        "currentTeacherExcludedFromValidation": len(validation_teacher) == 0,
        "sampleCountPreserved": len(resplit_samples) == len(samples),
        "gameCountPreserved": len(resplit_games) == len(games),
        "passed": False,
    }
    acceptance["passed"] = all(
        value for key, value in acceptance.items() if key != "passed"
    )

    output_dir = Path(args.out)
    output_dir.mkdir(parents=True, exist_ok=True)
    games_path = output_dir / "katacat-m33-mixed-games.jsonl"
    samples_path = output_dir / "katacat-m33-mixed-samples.jsonl"
    games_path.write_text(
        "".join(json.dumps(game, separators=(",", ":")) + "\n" for game in resplit_games),
        encoding="utf-8",
    )
    samples_path.write_text(
        "".join(json.dumps(sample, separators=(",", ":")) + "\n" for sample in resplit_samples),
        encoding="utf-8",
    )
    summary = {
        "schemaVersion": 1,
        "stage": "M3.3_RESPLIT",
        "validationModulo": args.validation_modulo,
        "validationOffset": offset,
        "games": {"train": len(train_games), "validation": len(validation_games)},
        "samples": {
            "train": sum(sample["split"] == "train" for sample in resplit_samples),
            "validation": sum(sample["split"] == "validation" for sample in resplit_samples),
        },
        "trainCurrentTeacherSeats": teacher_seats,
        "validationCurrentTeacherSamples": len(validation_teacher),
        "acceptance": acceptance,
        "note": (
            "M3.3 changes only split metadata at whole-game granularity. With modulo 6, "
            "validation uses non-CURRENT modes, so CURRENT teacher states from both seats remain "
            "train-only and can be safely upweighted by the tactical curriculum."
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
