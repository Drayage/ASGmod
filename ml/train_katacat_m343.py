from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import random
import shutil
from pathlib import Path
from typing import Any

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset

from katacat_m33_relative import relative_featurize
from train_katacat_m1 import KataCatNet, choose_device, load_jsonl, seed_everything, transform_plane, value_target
from train_katacat_m33 import balance_real_seats, tagged_samples, unique_samples


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="M3.4.3 value-head-only training on balanced terminal and bounded-reader contrasts."
    )
    parser.add_argument("--bootstrap-data", required=True)
    parser.add_argument("--selfplay-data", required=True)
    parser.add_argument("--mixed-data", required=True)
    parser.add_argument("--curriculum-data", required=True)
    parser.add_argument("--hard-negative-data", required=True)
    parser.add_argument("--balanced-data", required=True)
    parser.add_argument("--reader-pairs", required=True)
    parser.add_argument("--init-checkpoint", required=True)
    parser.add_argument("--out", default="katacat-m343-model")
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--learning-rate", type=float, default=2.5e-5)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--replay-weight", type=float, default=0.5)
    parser.add_argument("--contrast-weight", type=float, default=1.0)
    parser.add_argument("--pairwise-weight", type=float, default=0.5)
    parser.add_argument("--pairwise-margin", type=float, default=0.25)
    parser.add_argument("--general-loss-tolerance", type=float, default=1e-9)
    parser.add_argument("--contrast-improvement-min-delta", type=float, default=1e-6)
    parser.add_argument("--pair-margin-min-delta", type=float, default=1e-4)
    parser.add_argument("--class-accuracy-tolerance", type=float, default=0.02)
    parser.add_argument("--seed", type=int, default=20260731)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--augment", choices=("on", "off"), default="on")
    parser.add_argument("--commit-sha", default=os.environ.get("KATACAT_M343_COMMIT_SHA", "unknown"))
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def state_dict_hash(state: dict[str, torch.Tensor], include_value: bool) -> str:
    digest = hashlib.sha256()
    for key in sorted(state):
        if not include_value and key.startswith("value_head."):
            continue
        tensor = state[key].detach().cpu().contiguous()
        digest.update(key.encode("utf-8"))
        digest.update(str(tensor.dtype).encode("utf-8"))
        digest.update(np.asarray(tensor.shape, dtype=np.int64).tobytes())
        digest.update(tensor.numpy().tobytes())
    return digest.hexdigest()


def read_plain_jsonl(path: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with Path(path).open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                rows.append(json.loads(stripped))
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSON line {line_number} in {path}") from exc
    if not rows:
        raise ValueError(f"No rows found in {path}")
    return rows


def augment_feature_planes(features: np.ndarray, symmetry: int) -> np.ndarray:
    return np.stack([transform_plane(features[index], symmetry) for index in range(features.shape[0])])


class WeightedValueDataset(Dataset[tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]]):
    def __init__(self, rows: list[dict[str, Any]], augment: bool) -> None:
        self.rows = rows
        self.augment = augment
        self.features = [relative_featurize(row) for row in rows]
        self.targets = [float(value_target(row)) for row in rows]
        self.weights = [float(row.get("m343ValueWeight", 1.0)) for row in rows]
        self.labels = [str(row.get("contrastLabel", "REPLAY")) for row in rows]

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int):
        features = self.features[index]
        if self.augment:
            features = augment_feature_planes(features, random.randrange(8))
        label = 1 if self.labels[index] == "WIN" else -1 if self.labels[index] == "LOSS" else 0
        return (
            torch.from_numpy(features.copy()),
            torch.tensor(self.targets[index], dtype=torch.float32),
            torch.tensor(self.weights[index], dtype=torch.float32),
            torch.tensor(label, dtype=torch.int64),
        )


class ReaderPairDataset(Dataset[tuple[torch.Tensor, torch.Tensor]]):
    def __init__(self, rows: list[dict[str, Any]], augment: bool) -> None:
        self.rows = rows
        self.augment = augment
        self.dangerous = [relative_featurize(row["dangerous"]) for row in rows]
        self.safer = [relative_featurize(row["safer"]) for row in rows]

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int):
        dangerous = self.dangerous[index]
        safer = self.safer[index]
        if self.augment:
            symmetry = random.randrange(8)
            dangerous = augment_feature_planes(dangerous, symmetry)
            safer = augment_feature_planes(safer, symmetry)
        return torch.from_numpy(dangerous.copy()), torch.from_numpy(safer.copy())


def freeze_value_head_only(model: KataCatNet) -> list[str]:
    for parameter in model.parameters():
        parameter.requires_grad = False
    for parameter in model.value_head.parameters():
        parameter.requires_grad = True
    return [name for name, parameter in model.named_parameters() if parameter.requires_grad]


@torch.no_grad()
def evaluate_value(model: KataCatNet, dataset: WeightedValueDataset, device: torch.device) -> dict[str, float]:
    loader = DataLoader(dataset, batch_size=128, shuffle=False, num_workers=0)
    model.eval()
    errors: list[torch.Tensor] = []
    predictions: list[torch.Tensor] = []
    targets: list[torch.Tensor] = []
    labels: list[torch.Tensor] = []
    for features, target, _weight, label in loader:
        prediction = model(features.to(device))[1]
        errors.append((prediction - target.to(device)).pow(2).cpu())
        predictions.append(prediction.cpu())
        targets.append(target.cpu())
        labels.append(label.cpu())
    if not errors:
        raise ValueError("Cannot evaluate an empty value dataset")
    prediction = torch.cat(predictions)
    target = torch.cat(targets)
    label = torch.cat(labels)
    sign_correct = ((prediction >= 0) == (target >= 0)).float()
    result: dict[str, float] = {
        "examples": float(target.numel()),
        "valueLoss": float(torch.cat(errors).mean().item()),
        "valueAccuracy": float(sign_correct.mean().item()),
        "predictionMean": float(prediction.mean().item()),
        "targetMean": float(target.mean().item()),
    }
    for label_value, name in ((1, "win"), (-1, "loss")):
        mask = label == label_value
        if bool(mask.any()):
            result[f"{name}Examples"] = float(mask.sum().item())
            result[f"{name}ValueLoss"] = float((prediction[mask] - target[mask]).pow(2).mean().item())
            result[f"{name}Accuracy"] = float(sign_correct[mask].mean().item())
            result[f"{name}PredictionMean"] = float(prediction[mask].mean().item())
    if "winAccuracy" in result and "lossAccuracy" in result:
        result["balancedAccuracy"] = (result["winAccuracy"] + result["lossAccuracy"]) / 2.0
    return result


@torch.no_grad()
def evaluate_pairs(
    model: KataCatNet,
    dataset: ReaderPairDataset,
    device: torch.device,
    margin: float,
) -> tuple[dict[str, float], list[dict[str, Any]]]:
    loader = DataLoader(dataset, batch_size=128, shuffle=False, num_workers=0)
    model.eval()
    margins: list[torch.Tensor] = []
    losses: list[torch.Tensor] = []
    rows: list[dict[str, Any]] = []
    cursor = 0
    for dangerous, safer in loader:
        dangerous_value = model(dangerous.to(device))[1]
        safer_value = model(safer.to(device))[1]
        pair_margin = dangerous_value - safer_value
        pair_loss = nn.functional.softplus(float(margin) - pair_margin)
        margins.append(pair_margin.cpu())
        losses.append(pair_loss.cpu())
        for offset in range(pair_margin.shape[0]):
            source = dataset.rows[cursor + offset]
            rows.append({
                "pairId": str(source["pairId"]),
                "gameId": str(source["gameId"]),
                "margin": float(pair_margin[offset].item()),
                "rankCorrect": bool(pair_margin[offset].item() > 0),
            })
        cursor += pair_margin.shape[0]
    if not rows:
        raise ValueError("Cannot evaluate an empty reader-pair dataset")
    all_margins = torch.cat(margins)
    return {
        "examples": float(len(rows)),
        "pairwiseLoss": float(torch.cat(losses).mean().item()),
        "rankingAccuracy": float((all_margins > 0).float().mean().item()),
        "meanMargin": float(all_margins.mean().item()),
        "minimumMargin": float(all_margins.min().item()),
    }, rows


def pair_regression_failures(parent_rows: list[dict[str, Any]], candidate_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    parent = {row["pairId"]: row for row in parent_rows}
    failures: list[dict[str, Any]] = []
    for row in candidate_rows:
        before = parent[row["pairId"]]
        if before["rankCorrect"] and not row["rankCorrect"]:
            failures.append({"pairId": row["pairId"], "gameId": row["gameId"], "parent": before, "candidate": row})
    return failures


def validation_logits(model: KataCatNet, rows: list[dict[str, Any]], device: torch.device) -> dict[str, torch.Tensor]:
    features = torch.from_numpy(np.stack([relative_featurize(row) for row in rows[:64]])).to(device)
    model.eval()
    with torch.no_grad():
        policy, _value, score, ownership = model(features)
    return {"policy": policy.cpu(), "score": score.cpu(), "ownership": ownership.cpu()}


def max_output_delta(before: dict[str, torch.Tensor], after: dict[str, torch.Tensor]) -> dict[str, float]:
    return {key: float((before[key] - after[key]).abs().max().item()) for key in before}


def main() -> None:
    args = parse_args()
    seed_everything(args.seed)
    replay_sources = {
        "bootstrap": tagged_samples("bootstrap", args.bootstrap_data),
        "selfplay": tagged_samples("selfplay", args.selfplay_data),
        "mixed": tagged_samples("mixed", args.mixed_data),
        "curriculum": tagged_samples("curriculum", args.curriculum_data),
    }
    replay_originals = unique_samples([row for rows in replay_sources.values() for row in rows])
    replay_balanced, replay_balance = balance_real_seats(replay_originals, args.seed)
    replay_train = [dict(row, m343ValueWeight=args.replay_weight) for row in replay_balanced if row["split"] == "train"]
    general_validation = [row for row in replay_balanced if row["split"] == "validation"]

    contrast_rows = read_plain_jsonl(args.balanced_data)
    contrast_train = [dict(row, m343ValueWeight=args.contrast_weight) for row in contrast_rows if row["split"] == "train"]
    contrast_validation = [row for row in contrast_rows if row["split"] == "validation"]
    pair_rows = read_plain_jsonl(args.reader_pairs)
    pair_train = [row for row in pair_rows if row["split"] == "train"]
    pair_validation = [row for row in pair_rows if row["split"] == "validation"]
    hard_negative_rows = [row for row in load_jsonl(Path(args.hard_negative_data)) if row["split"] == "validation"]

    if not replay_train or not general_validation or not contrast_train or not contrast_validation or not pair_train or not pair_validation:
        raise ValueError("M3.4.3 requires non-empty replay, balanced terminal, and reader-pair train/validation sets")

    train_games = {str(row["gameId"]) for row in [*replay_train, *contrast_train]}
    validation_games = {str(row["gameId"]) for row in [*general_validation, *contrast_validation, *pair_validation]}
    if train_games.intersection(validation_games):
        raise ValueError("M3.4.3 game leakage between training and validation")

    device = choose_device(args.device)
    checkpoint_path = Path(args.init_checkpoint)
    checkpoint = torch.load(checkpoint_path, map_location="cpu")
    if checkpoint.get("encodingVersion") != "PLAYER_RELATIVE_V1":
        raise ValueError("M3.4.3 requires a PLAYER_RELATIVE_V1 checkpoint")
    model = KataCatNet(int(checkpoint["channels"]), int(checkpoint["blocks"]))
    model.load_state_dict(checkpoint["modelState"])
    model = model.to(device)
    trainable_names = freeze_value_head_only(model)
    if not trainable_names or any(not name.startswith("value_head.") for name in trainable_names):
        raise AssertionError(f"Unexpected M3.4.3 trainable parameters: {trainable_names}")

    parent_state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}
    parent_nonvalue_hash = state_dict_hash(parent_state, include_value=False)
    parent_checkpoint_sha256 = sha256_file(checkpoint_path)

    train_value_dataset = WeightedValueDataset([*replay_train, *contrast_train], args.augment == "on")
    general_validation_dataset = WeightedValueDataset(general_validation, False)
    contrast_validation_dataset = WeightedValueDataset(contrast_validation, False)
    pair_train_dataset = ReaderPairDataset(pair_train, args.augment == "on")
    pair_validation_dataset = ReaderPairDataset(pair_validation, False)
    value_loader = DataLoader(train_value_dataset, batch_size=args.batch_size, shuffle=True, num_workers=0)
    pair_loader = DataLoader(pair_train_dataset, batch_size=args.batch_size, shuffle=True, num_workers=0)

    parent_general = evaluate_value(model, general_validation_dataset, device)
    parent_contrast = evaluate_value(model, contrast_validation_dataset, device)
    parent_pairs, parent_pair_rows = evaluate_pairs(model, pair_validation_dataset, device, args.pairwise_margin)
    frozen_outputs = validation_logits(model, hard_negative_rows, device)

    optimizer = torch.optim.AdamW(
        [parameter for parameter in model.parameters() if parameter.requires_grad],
        lr=args.learning_rate,
        weight_decay=args.weight_decay,
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=max(1, args.epochs))

    selected_epoch = 0
    selected_state: dict[str, torch.Tensor] | None = None
    selected_general = copy.deepcopy(parent_general)
    selected_contrast = copy.deepcopy(parent_contrast)
    selected_pairs = copy.deepcopy(parent_pairs)
    selected_pair_failures: list[dict[str, Any]] = []
    selected_rank = (parent_contrast["valueLoss"], -parent_pairs["meanMargin"], parent_general["valueLoss"])
    history: list[dict[str, Any]] = [{
        "epoch": 0,
        "source": "parent",
        "generalValidation": parent_general,
        "balancedTerminalValidation": parent_contrast,
        "readerPairValidation": {**parent_pairs, "rankingRegressionsVsParent": 0},
        "eligible": True,
        "selected": True,
    }]

    for epoch in range(1, args.epochs + 1):
        model.train()
        value_loss_total = 0.0
        value_examples = 0
        for features, target, weight, _label in value_loader:
            features = features.to(device)
            target = target.to(device)
            weight = weight.to(device)
            optimizer.zero_grad(set_to_none=True)
            prediction = model(features)[1]
            per_row = (prediction - target).pow(2)
            loss = (per_row * weight).sum() / weight.sum().clamp_min(1e-6)
            loss.backward()
            nn.utils.clip_grad_norm_(model.value_head.parameters(), max_norm=5.0)
            optimizer.step()
            value_loss_total += float(loss.item()) * features.shape[0]
            value_examples += features.shape[0]

        pair_loss_total = 0.0
        pair_examples = 0
        for dangerous, safer in pair_loader:
            dangerous = dangerous.to(device)
            safer = safer.to(device)
            optimizer.zero_grad(set_to_none=True)
            dangerous_value = model(dangerous)[1]
            safer_value = model(safer)[1]
            pair_margin = dangerous_value - safer_value
            loss = args.pairwise_weight * nn.functional.softplus(args.pairwise_margin - pair_margin).mean()
            loss.backward()
            nn.utils.clip_grad_norm_(model.value_head.parameters(), max_norm=5.0)
            optimizer.step()
            pair_loss_total += float(loss.item()) * dangerous.shape[0]
            pair_examples += dangerous.shape[0]
        scheduler.step()

        general = evaluate_value(model, general_validation_dataset, device)
        contrast = evaluate_value(model, contrast_validation_dataset, device)
        pairs, pair_rows_eval = evaluate_pairs(model, pair_validation_dataset, device, args.pairwise_margin)
        pair_failures = pair_regression_failures(parent_pair_rows, pair_rows_eval)
        current_nonvalue_hash = state_dict_hash(model.state_dict(), include_value=False)
        general_not_worse = general["valueLoss"] <= parent_general["valueLoss"] + args.general_loss_tolerance
        contrast_improved = contrast["valueLoss"] < parent_contrast["valueLoss"] - args.contrast_improvement_min_delta
        class_accuracy_safe = (
            contrast.get("winAccuracy", 0.0) >= parent_contrast.get("winAccuracy", 0.0) - args.class_accuracy_tolerance
            and contrast.get("lossAccuracy", 0.0) >= parent_contrast.get("lossAccuracy", 0.0) - args.class_accuracy_tolerance
        )
        pair_safe = (
            len(pair_failures) == 0
            and pairs["rankingAccuracy"] >= parent_pairs["rankingAccuracy"]
            and pairs["meanMargin"] > parent_pairs["meanMargin"] + args.pair_margin_min_delta
        )
        eligible = general_not_worse and contrast_improved and class_accuracy_safe and pair_safe and current_nonvalue_hash == parent_nonvalue_hash
        rank = (contrast["valueLoss"], -pairs["meanMargin"], general["valueLoss"])
        selected_now = eligible and (selected_epoch == 0 or rank < selected_rank)
        if selected_now:
            selected_epoch = epoch
            selected_state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}
            selected_general = copy.deepcopy(general)
            selected_contrast = copy.deepcopy(contrast)
            selected_pairs = copy.deepcopy(pairs)
            selected_pair_failures = pair_failures
            selected_rank = rank
            for row in history:
                row["selected"] = False
        history.append({
            "epoch": epoch,
            "trainValueLoss": value_loss_total / max(1, value_examples),
            "trainReaderPairLoss": pair_loss_total / max(1, pair_examples),
            "generalValidation": general,
            "balancedTerminalValidation": contrast,
            "readerPairValidation": {
                **pairs,
                "rankingRegressionsVsParent": len(pair_failures),
                "regressionDetails": pair_failures,
            },
            "generalNotWorseThanParent": general_not_worse,
            "balancedTerminalImproved": contrast_improved,
            "classAccuracySafe": class_accuracy_safe,
            "readerPairSafe": pair_safe,
            "nonValueParametersUnchanged": current_nonvalue_hash == parent_nonvalue_hash,
            "eligible": eligible,
            "selected": selected_now,
        })
        print(
            f"epoch {epoch:03d} general_value={general['valueLoss']:.6f} "
            f"balanced_value={contrast['valueLoss']:.6f} pair_margin={pairs['meanMargin']:.4f} "
            f"pair_acc={pairs['rankingAccuracy']:.3f} eligible={eligible} selected={selected_now}"
        )

    output_dir = Path(args.out)
    output_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_out = output_dir / "katacat-m343.pt"
    improved_over_parent = selected_epoch > 0
    if selected_epoch == 0:
        shutil.copy2(checkpoint_path, checkpoint_out)
        selected_model_state = parent_state
    else:
        if selected_state is None:
            raise AssertionError("Selected M3.4.3 epoch has no retained state")
        selected_model_state = selected_state
        torch.save({
            "modelState": selected_state,
            "inputChannels": int(checkpoint["inputChannels"]),
            "policySize": int(checkpoint["policySize"]),
            "channels": int(checkpoint["channels"]),
            "blocks": int(checkpoint["blocks"]),
            "boardSize": int(checkpoint["boardSize"]),
            "maxMargin": int(checkpoint["maxMargin"]),
            "epoch": selected_epoch,
            "stage": "M3.4.3",
            "encodingVersion": "PLAYER_RELATIVE_V1",
            "parentCheckpoint": str(checkpoint_path),
            "parentCheckpointSha256": parent_checkpoint_sha256,
            "generalValidation": selected_general,
            "balancedTerminalValidation": selected_contrast,
            "readerPairValidation": selected_pairs,
            "trainableScope": "VALUE_HEAD_ONLY",
            "commitSha": args.commit_sha,
        }, checkpoint_out)

    selected_checkpoint_sha256 = sha256_file(checkpoint_out)
    selected_nonvalue_hash = state_dict_hash(selected_model_state, include_value=False)
    verification_model = KataCatNet(int(checkpoint["channels"]), int(checkpoint["blocks"]))
    verification_model.load_state_dict(selected_model_state)
    verification_model = verification_model.to(device)
    selected_outputs = validation_logits(verification_model, hard_negative_rows, device)
    output_deltas = max_output_delta(frozen_outputs, selected_outputs)
    parent_bytes_preserved = selected_epoch != 0 or selected_checkpoint_sha256 == parent_checkpoint_sha256

    acceptance = {
        "initializedFromM341": checkpoint_path.is_file() and checkpoint.get("encodingVersion") == "PLAYER_RELATIVE_V1",
        "parentIncludedAsEpoch0": history[0]["epoch"] == 0,
        "parentBytesPreservedWhenSelected": parent_bytes_preserved,
        "valueHeadOnlyTrainable": len(trainable_names) > 0 and all(name.startswith("value_head.") for name in trainable_names),
        "nonValueParameterHashUnchanged": selected_nonvalue_hash == parent_nonvalue_hash,
        "policyScoreOwnershipOutputsUnchanged": all(delta == 0.0 for delta in output_deltas.values()),
        "generalValueNotWorseThanParent": selected_general["valueLoss"] <= parent_general["valueLoss"] + args.general_loss_tolerance,
        "balancedWinLossValidationPresent": selected_contrast.get("winExamples", 0) > 0 and selected_contrast.get("lossExamples", 0) > 0,
        "readerPairValidationPresent": selected_pairs["examples"] > 0,
        "selectedReaderPairRegressionsZero": len(selected_pair_failures) == 0,
        "trainValidationGamesDisjoint": train_games.isdisjoint(validation_games),
        "candidateCheckpointSaved": checkpoint_out.is_file(),
        "checkpointSha256Recorded": len(selected_checkpoint_sha256) == 64,
        "allMetricsFinite": all(math.isfinite(float(value)) for metrics in (selected_general, selected_contrast, selected_pairs) for value in metrics.values()),
        "noRandomRollouts": True,
        "passed": False,
    }
    acceptance["passed"] = all(value for key, value in acceptance.items() if key != "passed")

    summary = {
        "schemaVersion": 1,
        "stage": "M3.4.3_VALUE_HEAD_ONLY_TRAIN",
        "device": str(device),
        "commit_sha": args.commit_sha,
        "encodingVersion": "PLAYER_RELATIVE_V1",
        "parentCheckpoint": str(checkpoint_path),
        "parent_checkpoint_sha256": parent_checkpoint_sha256,
        "selected_checkpoint_sha256": selected_checkpoint_sha256,
        "parent_nonvalue_parameter_sha256": parent_nonvalue_hash,
        "selected_nonvalue_parameter_sha256": selected_nonvalue_hash,
        "selected_epoch": selected_epoch,
        "improved_over_parent": improved_over_parent,
        "trainableScope": "VALUE_HEAD_ONLY",
        "trainableParameterNames": trainable_names,
        "trainableParameters": sum(parameter.numel() for parameter in model.parameters() if parameter.requires_grad),
        "sourceSamples": {
            **{name: len(rows) for name, rows in replay_sources.items()},
            "hardNegativeValidation": len(hard_negative_rows),
            "balancedTerminal": len(contrast_rows),
            "readerPairs": len(pair_rows),
        },
        "trainSamples": len(train_value_dataset),
        "generalValidationSamples": len(general_validation),
        "balancedTerminalValidationSamples": len(contrast_validation),
        "readerPairValidationSamples": len(pair_validation),
        "balance": replay_balance,
        "parent": {
            "generalValidation": parent_general,
            "balancedTerminalValidation": parent_contrast,
            "readerPairValidation": parent_pairs,
        },
        "selected": {
            "generalValidation": selected_general,
            "balancedTerminalValidation": selected_contrast,
            "readerPairValidation": {
                **selected_pairs,
                "rankingRegressionsVsParent": len(selected_pair_failures),
                "regressionDetails": selected_pair_failures,
            },
        },
        "frozenOutputMaxAbsDelta": output_deltas,
        "selectionPolicy": {
            "parentIsEpoch0": True,
            "requiresGeneralValueLossNotWorse": True,
            "requiresBalancedTerminalValueLossImprovement": True,
            "requiresWinAndLossAccuracyNoMaterialRegression": True,
            "requiresReaderPairMarginImprovement": True,
            "requiresReaderPairRankingRegressionsZero": True,
            "requiresNonValueParametersByteStable": True,
        },
        "lossWeights": {
            "replayValue": args.replay_weight,
            "balancedTerminalValue": args.contrast_weight,
            "readerPairwise": args.pairwise_weight,
            "readerMargin": args.pairwise_margin,
        },
        "augmentation": args.augment == "on",
        "acceptance": acceptance,
        "epochHistory": history,
        "note": (
            "M3.4.3 freezes the trunk and policy/score/ownership heads. Natural win and collapse-loss controls "
            "are balanced by split and seat. Reader pairs rank a proved-refuted successor above a bounded-reader-"
            "not-refuted successor from the opponent-to-move perspective; non-refutation is not a safety proof."
        ),
    }
    (output_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary))
    if not acceptance["passed"]:
        raise SystemExit("M3.4.3 training acceptance failed")


if __name__ == "__main__":
    main()
