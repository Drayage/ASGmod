from __future__ import annotations

import argparse
import copy
import json
import math
import os
import shutil
from pathlib import Path
from typing import Any

import torch
from torch import nn
from torch.utils.data import DataLoader

from train_katacat_m1 import KataCatNet, choose_device, load_jsonl, seed_everything
from train_katacat_m33 import balance_real_seats, tagged_samples, unique_samples
from train_katacat_m343 import (
    ReaderPairDataset,
    WeightedValueDataset,
    evaluate_pairs,
    evaluate_value,
    freeze_value_head_only,
    max_output_delta,
    pair_regression_failures,
    read_plain_jsonl,
    sha256_file,
    state_dict_hash,
    validation_logits,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="M3.4.3.1 diagnostic value-head training with rejected epoch preservation."
    )
    parser.add_argument("--bootstrap-data", required=True)
    parser.add_argument("--selfplay-data", required=True)
    parser.add_argument("--mixed-data", required=True)
    parser.add_argument("--curriculum-data", required=True)
    parser.add_argument("--hard-negative-data", required=True)
    parser.add_argument("--balanced-data", required=True)
    parser.add_argument("--reader-pairs", required=True)
    parser.add_argument("--init-checkpoint", required=True)
    parser.add_argument("--out", default="katacat-m3431-model")
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
    parser.add_argument("--commit-sha", default=os.environ.get("KATACAT_M3431_COMMIT_SHA", "unknown"))
    return parser.parse_args()


def checkpoint_payload(
    checkpoint: dict[str, Any],
    state: dict[str, torch.Tensor],
    epoch: int,
    commit_sha: str,
    parent_path: Path,
    parent_sha: str,
    general: dict[str, float],
    contrast: dict[str, float],
    pairs: dict[str, float],
) -> dict[str, Any]:
    return {
        "modelState": state,
        "inputChannels": int(checkpoint["inputChannels"]),
        "policySize": int(checkpoint["policySize"]),
        "channels": int(checkpoint["channels"]),
        "blocks": int(checkpoint["blocks"]),
        "boardSize": int(checkpoint["boardSize"]),
        "maxMargin": int(checkpoint["maxMargin"]),
        "epoch": epoch,
        "stage": "M3.4.3.1",
        "encodingVersion": "PLAYER_RELATIVE_V1",
        "parentCheckpoint": str(parent_path),
        "parentCheckpointSha256": parent_sha,
        "generalValidation": general,
        "balancedTerminalValidation": contrast,
        "readerPairValidation": pairs,
        "trainableScope": "VALUE_HEAD_ONLY",
        "commitSha": commit_sha,
    }


def main() -> None:
    args = parse_args()
    seed_everything(args.seed)
    output_dir = Path(args.out)
    epoch_dir = output_dir / "epochs"
    output_dir.mkdir(parents=True, exist_ok=True)
    epoch_dir.mkdir(parents=True, exist_ok=True)

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

    if not replay_train or not general_validation or not contrast_train or not contrast_validation:
        raise ValueError("M3.4.3.1 requires non-empty replay and balanced terminal train/validation sets")
    if not pair_train or not pair_validation or not hard_negative_rows:
        raise ValueError("M3.4.3.1 requires reader-pair and hard-negative validation rows")

    train_games = {str(row["gameId"]) for row in [*replay_train, *contrast_train]}
    validation_games = {str(row["gameId"]) for row in [*general_validation, *contrast_validation, *pair_validation]}
    if train_games.intersection(validation_games):
        raise ValueError("M3.4.3.1 game leakage between training and validation")

    device = choose_device(args.device)
    checkpoint_path = Path(args.init_checkpoint)
    checkpoint = torch.load(checkpoint_path, map_location="cpu")
    if checkpoint.get("encodingVersion") != "PLAYER_RELATIVE_V1":
        raise ValueError("M3.4.3.1 requires a PLAYER_RELATIVE_V1 checkpoint")

    model = KataCatNet(int(checkpoint["channels"]), int(checkpoint["blocks"]))
    model.load_state_dict(checkpoint["modelState"])
    model = model.to(device)
    trainable_names = freeze_value_head_only(model)
    if not trainable_names or any(not name.startswith("value_head.") for name in trainable_names):
        raise AssertionError(f"Unexpected trainable parameters: {trainable_names}")

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

    parent_epoch_path = epoch_dir / "epoch-000-parent.pt"
    shutil.copy2(checkpoint_path, parent_epoch_path)
    saved_epochs: list[dict[str, Any]] = [{
        "epoch": 0,
        "path": str(parent_epoch_path),
        "sha256": sha256_file(parent_epoch_path),
        "generalValueLoss": parent_general["valueLoss"],
        "balancedValueLoss": parent_contrast["valueLoss"],
        "readerPairMargin": parent_pairs["meanMargin"],
        "eligible": True,
    }]

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
        state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}
        epoch_path = epoch_dir / f"epoch-{epoch:03d}.pt"
        torch.save(
            checkpoint_payload(
                checkpoint,
                state,
                epoch,
                args.commit_sha,
                checkpoint_path,
                parent_checkpoint_sha256,
                general,
                contrast,
                pairs,
            ),
            epoch_path,
        )
        saved_epochs.append({
            "epoch": epoch,
            "path": str(epoch_path),
            "sha256": sha256_file(epoch_path),
            "generalValueLoss": general["valueLoss"],
            "balancedValueLoss": contrast["valueLoss"],
            "readerPairMargin": pairs["meanMargin"],
            "readerPairAccuracy": pairs["rankingAccuracy"],
            "eligible": eligible,
        })
        if selected_now:
            selected_epoch = epoch
            selected_state = state
            selected_general = copy.deepcopy(general)
            selected_contrast = copy.deepcopy(contrast)
            selected_pairs = copy.deepcopy(pairs)
            selected_pair_failures = pair_failures
            selected_rank = rank
            for row in history:
                row["selected"] = False

        history.append({
            "epoch": epoch,
            "checkpointPath": str(epoch_path),
            "checkpointSha256": saved_epochs[-1]["sha256"],
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

    non_parent = [row for row in saved_epochs if row["epoch"] > 0]
    if not non_parent:
        raise ValueError("No trained epochs were produced")
    best_general = min(non_parent, key=lambda row: (row["generalValueLoss"], row["epoch"]))
    best_balanced = min(non_parent, key=lambda row: (row["balancedValueLoss"], row["epoch"]))
    best_reader = max(non_parent, key=lambda row: (row["readerPairMargin"], -row["epoch"]))
    final_epoch = non_parent[-1]

    checkpoint_out = output_dir / "katacat-m3431.pt"
    improved_over_parent = selected_epoch > 0
    if selected_epoch == 0:
        shutil.copy2(checkpoint_path, checkpoint_out)
        selected_model_state = parent_state
    else:
        if selected_state is None:
            raise AssertionError("Selected epoch has no retained state")
        selected_model_state = selected_state
        shutil.copy2(epoch_dir / f"epoch-{selected_epoch:03d}.pt", checkpoint_out)

    selected_checkpoint_sha256 = sha256_file(checkpoint_out)
    selected_nonvalue_hash = state_dict_hash(selected_model_state, include_value=False)
    verification_model = KataCatNet(int(checkpoint["channels"]), int(checkpoint["blocks"]))
    verification_model.load_state_dict(selected_model_state)
    verification_model = verification_model.to(device)
    selected_outputs = validation_logits(verification_model, hard_negative_rows, device)
    output_deltas = max_output_delta(frozen_outputs, selected_outputs)
    parent_bytes_preserved = selected_epoch != 0 or selected_checkpoint_sha256 == parent_checkpoint_sha256

    diagnostic_epochs = sorted({
        0,
        int(best_general["epoch"]),
        int(best_balanced["epoch"]),
        int(best_reader["epoch"]),
        int(final_epoch["epoch"]),
    })
    epoch_lookup = {int(row["epoch"]): row for row in saved_epochs}
    diagnostic_candidates = [
        {
            "id": "parent" if epoch == 0 else f"epoch-{epoch:03d}",
            **epoch_lookup[epoch],
            "roles": [
                role
                for role, row in (
                    ("selected", {"epoch": selected_epoch}),
                    ("best-general", best_general),
                    ("best-balanced", best_balanced),
                    ("best-reader", best_reader),
                    ("final", final_epoch),
                )
                if int(row["epoch"]) == epoch
            ],
        }
        for epoch in diagnostic_epochs
    ]

    acceptance = {
        "initializedFromM341": checkpoint_path.is_file() and checkpoint.get("encodingVersion") == "PLAYER_RELATIVE_V1",
        "parentIncludedAsEpoch0": history[0]["epoch"] == 0,
        "parentBytesPreservedWhenSelected": parent_bytes_preserved,
        "valueHeadOnlyTrainable": len(trainable_names) > 0 and all(name.startswith("value_head.") for name in trainable_names),
        "nonValueParameterHashUnchanged": selected_nonvalue_hash == parent_nonvalue_hash,
        "policyScoreOwnershipOutputsUnchanged": all(delta == 0.0 for delta in output_deltas.values()),
        "allEpochCheckpointsSaved": len(saved_epochs) == args.epochs + 1 and all(Path(row["path"]).is_file() for row in saved_epochs),
        "diagnosticCandidatesPresent": len(diagnostic_candidates) >= 2,
        "trainValidationGamesDisjoint": train_games.isdisjoint(validation_games),
        "candidateCheckpointSaved": checkpoint_out.is_file(),
        "checkpointSha256Recorded": len(selected_checkpoint_sha256) == 64,
        "allMetricsFinite": all(
            math.isfinite(float(value))
            for metrics in (selected_general, selected_contrast, selected_pairs)
            for value in metrics.values()
        ),
        "noRandomRollouts": True,
        "passed": False,
    }
    acceptance["passed"] = all(value for key, value in acceptance.items() if key != "passed")

    summary = {
        "schemaVersion": 1,
        "stage": "M3.4.3.1_REJECTED_EPOCH_DIAGNOSTIC_TRAIN",
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
        "best_general_epoch": int(best_general["epoch"]),
        "best_balanced_epoch": int(best_balanced["epoch"]),
        "best_reader_epoch": int(best_reader["epoch"]),
        "final_epoch": int(final_epoch["epoch"]),
        "saved_epoch_checkpoints": saved_epochs,
        "diagnostic_candidates": diagnostic_candidates,
        "rejected_epochs": [int(row["epoch"]) for row in saved_epochs if int(row["epoch"]) != selected_epoch],
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
            "strictM343EligibilityRetained": True,
            "rejectedEpochsSavedForDiagnosis": True,
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
            "M3.4.3.1 keeps M3.4.3 selection rules unchanged, but preserves every trained "
            "value-head checkpoint so rejected epochs can be evaluated. No rejected checkpoint "
            "is promoted by validation metrics alone."
        ),
    }
    (output_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    (output_dir / "diagnostic-candidates.json").write_text(
        json.dumps({
            "schemaVersion": 1,
            "stage": "M3.4.3.1_DIAGNOSTIC_CANDIDATES",
            "candidates": diagnostic_candidates,
        }, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(summary))
    if not acceptance["passed"]:
        raise SystemExit("M3.4.3.1 training acceptance failed")


if __name__ == "__main__":
    main()
