from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import shutil
from pathlib import Path
from typing import Any

import torch
from torch import nn
from torch.utils.data import DataLoader, WeightedRandomSampler

from train_katacat_m1 import KataCatNet, choose_device, ownership_class_weights, seed_everything
from train_katacat_m33 import balance_real_seats, tagged_samples, unique_samples
from train_katacat_m341 import (
    M341Dataset,
    balance_hard_train,
    evaluate_general,
    evaluate_tactical,
    finite_general,
    pairwise_components,
    per_sample_policy_loss,
    sha256_file,
    tactical_regression_failures,
    tactical_rank,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="M3.5.1 policy-head-only fine-tuning with hard-negative oversampling."
    )
    parser.add_argument("--bootstrap-data", required=True)
    parser.add_argument("--selfplay-data", required=True)
    parser.add_argument("--mixed-data", required=True)
    parser.add_argument("--curriculum-data", required=True)
    parser.add_argument("--hard-negative-data", required=True)
    parser.add_argument("--init-checkpoint", required=True)
    parser.add_argument("--out", default="katacat-m351-model")
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--learning-rate", type=float, default=1.5e-4)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--pairwise-weight", type=float, default=1.0)
    parser.add_argument("--pairwise-margin", type=float, default=0.5)
    parser.add_argument("--negative-mass-weight", type=float, default=0.5)
    parser.add_argument("--hard-sampling-multiplier", type=float, default=4.0)
    parser.add_argument("--value-weight", type=float, default=1.0)
    parser.add_argument("--score-weight", type=float, default=0.25)
    parser.add_argument("--ownership-weight", type=float, default=1.0)
    parser.add_argument("--general-policy-loss-tolerance", type=float, default=0.005)
    parser.add_argument("--policy-top1-tolerance", type=float, default=0.01)
    parser.add_argument("--tactical-margin-min-delta", type=float, default=0.005)
    parser.add_argument("--tactical-pairwise-min-delta", type=float, default=0.005)
    parser.add_argument("--seed", type=int, default=20260801)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--augment", choices=("on", "off"), default="on")
    parser.add_argument(
        "--commit-sha",
        default=os.environ.get("KATACAT_M351_COMMIT_SHA", "unknown"),
    )
    return parser.parse_args()


def train_policy_head_only(model: KataCatNet) -> list[str]:
    for parameter in model.parameters():
        parameter.requires_grad = False
    for parameter in model.policy_head.parameters():
        parameter.requires_grad = True
    return [name for name, parameter in model.named_parameters() if parameter.requires_grad]


def nonpolicy_parameter_sha256(model: KataCatNet) -> str:
    digest = hashlib.sha256()
    for name, tensor in sorted(model.state_dict().items()):
        if name.startswith("policy_head."):
            continue
        value = tensor.detach().cpu().contiguous()
        digest.update(name.encode("utf-8"))
        digest.update(str(tuple(value.shape)).encode("utf-8"))
        digest.update(value.numpy().tobytes())
    return digest.hexdigest()


def negative_mass_loss(
    logits: torch.Tensor,
    hard_flags: torch.Tensor,
    positive_actions: torch.Tensor,
    negative_masks: torch.Tensor,
    margin: float,
) -> torch.Tensor:
    valid = torch.logical_and(hard_flags > 0.5, negative_masks.any(dim=1))
    if not bool(valid.any()):
        return logits.sum() * 0.0
    selected = logits[valid]
    positives = selected.gather(1, positive_actions[valid].unsqueeze(1)).squeeze(1)
    negatives = selected.masked_fill(~negative_masks[valid], -1e9)
    negative_log_mass = torch.logsumexp(negatives, dim=1)
    return nn.functional.softplus(float(margin) - (positives - negative_log_mass)).mean()


@torch.no_grad()
def frozen_output_delta(
    parent: KataCatNet,
    candidate: KataCatNet,
    loader: DataLoader,
    device: torch.device,
) -> dict[str, float]:
    parent.eval()
    candidate.eval()
    maxima = {"value": 0.0, "score": 0.0, "ownership": 0.0}
    for batch in loader:
        features = batch[0].to(device)
        parent_output = parent(features)
        candidate_output = candidate(features)
        for key, index in (("value", 1), ("score", 2), ("ownership", 3)):
            delta = float((parent_output[index] - candidate_output[index]).abs().max().item())
            maxima[key] = max(maxima[key], delta)
    return maxima


def policy_safety(
    parent: dict[str, float],
    candidate: dict[str, float],
    args: argparse.Namespace,
) -> tuple[bool, dict[str, bool]]:
    checks = {
        "policyLossSafe": candidate["policyLoss"]
        <= parent["policyLoss"] + args.general_policy_loss_tolerance,
        "policyTop1Safe": candidate["policyTop1"]
        >= parent["policyTop1"] - args.policy_top1_tolerance,
    }
    return all(checks.values()), checks


def main() -> None:
    args = parse_args()
    seed_everything(args.seed)

    replay_sources = {
        "bootstrap": tagged_samples("bootstrap", args.bootstrap_data),
        "selfplay": tagged_samples("selfplay", args.selfplay_data),
        "mixed": tagged_samples("mixed", args.mixed_data),
        "curriculum": tagged_samples("curriculum", args.curriculum_data),
    }
    hard_samples = tagged_samples("hardNegative", args.hard_negative_data)
    replay_originals = unique_samples([row for rows in replay_sources.values() for row in rows])
    replay_balanced, replay_balance = balance_real_seats(replay_originals, args.seed)
    hard_train, hard_validation, hard_balance = balance_hard_train(
        unique_samples(hard_samples), args.seed + 1
    )
    replay_train = [sample for sample in replay_balanced if sample["split"] == "train"]
    general_validation = [sample for sample in replay_balanced if sample["split"] == "validation"]
    train_samples = unique_samples([*replay_train, *hard_train])
    if not train_samples or not general_validation or not hard_validation:
        raise ValueError(
            "M3.5.1 requires train, general validation, and frozen tactical validation rows"
        )

    train_games = {str(sample["gameId"]) for sample in train_samples}
    validation_games = {
        str(sample["gameId"])
        for sample in [*general_validation, *hard_validation]
    }
    if train_games.intersection(validation_games):
        raise ValueError("M3.5.1 train/validation game leakage")

    device = choose_device(args.device)
    checkpoint_path = Path(args.init_checkpoint)
    checkpoint = torch.load(checkpoint_path, map_location="cpu")
    if checkpoint.get("encodingVersion") != "PLAYER_RELATIVE_V1":
        raise ValueError("M3.5.1 requires PLAYER_RELATIVE_V1")

    channels = int(checkpoint["channels"])
    blocks = int(checkpoint["blocks"])
    model = KataCatNet(channels, blocks)
    model.load_state_dict(checkpoint["modelState"])
    model = model.to(device)
    parent_model = copy.deepcopy(model).to(device).eval()
    for parameter in parent_model.parameters():
        parameter.requires_grad = False

    trainable_names = train_policy_head_only(model)
    if not trainable_names or any(
        not name.startswith("policy_head.") for name in trainable_names
    ):
        raise AssertionError(f"Unexpected M3.5.1 trainable scope: {trainable_names}")

    parent_nonpolicy_sha = nonpolicy_parameter_sha256(parent_model)
    train_dataset = M341Dataset(train_samples, augment=args.augment == "on")
    general_dataset = M341Dataset(general_validation, augment=False)
    tactical_dataset = M341Dataset(hard_validation, augment=False)
    general_loader = DataLoader(
        general_dataset,
        batch_size=args.batch_size,
        shuffle=False,
        num_workers=0,
    )
    ownership_loss = nn.CrossEntropyLoss(
        weight=ownership_class_weights(train_dataset, device)
    )

    sample_weights = torch.tensor(
        [
            args.hard_sampling_multiplier
            if sample.get("trainingSource") == "hardNegative"
            else 1.0
            for sample in train_samples
        ],
        dtype=torch.double,
    )
    generator = torch.Generator()
    generator.manual_seed(args.seed)
    sampler = WeightedRandomSampler(
        sample_weights,
        num_samples=max(len(train_samples), 2 * len(replay_train)),
        replacement=True,
        generator=generator,
    )
    train_loader = DataLoader(
        train_dataset,
        batch_size=args.batch_size,
        sampler=sampler,
        num_workers=0,
        pin_memory=device.type == "cuda",
    )

    parent_general = evaluate_general(
        model, general_loader, device, ownership_loss, args
    )
    parent_tactical, parent_tactical_rows = evaluate_tactical(
        model, tactical_dataset, device, args
    )
    parent_sha = sha256_file(checkpoint_path)

    optimizer = torch.optim.AdamW(
        [parameter for parameter in model.parameters() if parameter.requires_grad],
        lr=args.learning_rate,
        weight_decay=args.weight_decay,
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, T_max=max(1, args.epochs)
    )

    selected_epoch = 0
    selected_state: dict[str, torch.Tensor] | None = None
    selected_general = copy.deepcopy(parent_general)
    selected_tactical = copy.deepcopy(parent_tactical)
    selected_failures: list[dict[str, Any]] = []
    selected_rank = tactical_rank(parent_tactical, parent_general["policyLoss"])
    selected_output_delta = {"value": 0.0, "score": 0.0, "ownership": 0.0}
    history: list[dict[str, Any]] = [
        {
            "epoch": 0,
            "source": "parent",
            "generalValidation": parent_general,
            "frozenTacticalValidation": {
                **parent_tactical,
                "regressionFailuresVsParent": 0,
            },
            "frozenOutputMaxAbsDelta": selected_output_delta,
            "eligible": True,
            "selected": True,
        }
    ]

    for epoch in range(1, args.epochs + 1):
        model.train()
        totals = {
            "loss": 0.0,
            "policy": 0.0,
            "pairwise": 0.0,
            "negativeMass": 0.0,
        }
        seen = 0
        for (
            features,
            policy,
            _value,
            _score,
            _ownership,
            hard_flags,
            positive_actions,
            negative_masks,
        ) in train_loader:
            features = features.to(device)
            policy = policy.to(device)
            hard_flags = hard_flags.to(device)
            positive_actions = positive_actions.to(device)
            negative_masks = negative_masks.to(device)
            optimizer.zero_grad(set_to_none=True)
            policy_logits = model(features)[0]
            p_loss = per_sample_policy_loss(policy_logits, policy).mean()
            pair_loss, _margins, _positive, _negative = pairwise_components(
                policy_logits,
                hard_flags,
                positive_actions,
                negative_masks,
                args.pairwise_margin,
            )
            mass_loss = negative_mass_loss(
                policy_logits,
                hard_flags,
                positive_actions,
                negative_masks,
                args.pairwise_margin,
            )
            loss = (
                p_loss
                + args.pairwise_weight * pair_loss
                + args.negative_mass_weight * mass_loss
            )
            loss.backward()
            nn.utils.clip_grad_norm_(
                [parameter for parameter in model.parameters() if parameter.requires_grad],
                max_norm=5.0,
            )
            optimizer.step()
            batch = features.shape[0]
            seen += batch
            totals["loss"] += float(loss.item()) * batch
            totals["policy"] += float(p_loss.item()) * batch
            totals["pairwise"] += float(pair_loss.item()) * batch
            totals["negativeMass"] += float(mass_loss.item()) * batch
        scheduler.step()

        general = evaluate_general(
            model, general_loader, device, ownership_loss, args
        )
        tactical, tactical_rows = evaluate_tactical(
            model, tactical_dataset, device, args
        )
        failure_count, failure_details = tactical_regression_failures(
            parent_tactical_rows, tactical_rows
        )
        safe, safety_checks = policy_safety(parent_general, general, args)
        output_delta = frozen_output_delta(
            parent_model, model, general_loader, device
        )
        nonpolicy_unchanged = nonpolicy_parameter_sha256(model) == parent_nonpolicy_sha
        outputs_unchanged = max(output_delta.values()) <= 1e-8
        tactical_improved = (
            tactical["negativeTop1Rate"]
            < parent_tactical["negativeTop1Rate"] - 1e-12
            or tactical["meanMargin"]
            > parent_tactical["meanMargin"] + args.tactical_margin_min_delta
            or tactical["pairwiseLoss"]
            < parent_tactical["pairwiseLoss"] - args.tactical_pairwise_min_delta
        )
        eligible = (
            safe
            and finite_general(general)
            and failure_count == 0
            and tactical_improved
            and nonpolicy_unchanged
            and outputs_unchanged
        )
        rank = tactical_rank(tactical, general["policyLoss"])
        selected_now = eligible and (selected_epoch == 0 or rank < selected_rank)
        if selected_now:
            selected_epoch = epoch
            selected_state = {
                key: value.detach().cpu().clone()
                for key, value in model.state_dict().items()
            }
            selected_general = copy.deepcopy(general)
            selected_tactical = copy.deepcopy(tactical)
            selected_failures = copy.deepcopy(failure_details)
            selected_rank = rank
            selected_output_delta = copy.deepcopy(output_delta)
            for row in history:
                row["selected"] = False

        history.append(
            {
                "epoch": epoch,
                "train": {
                    key: value / max(1, seen) for key, value in totals.items()
                },
                "generalValidation": general,
                "frozenTacticalValidation": {
                    **tactical,
                    "regressionFailuresVsParent": failure_count,
                    "regressionFailureDetails": failure_details,
                },
                "frozenOutputMaxAbsDelta": output_delta,
                "safetyChecks": safety_checks,
                "nonPolicyParametersUnchanged": nonpolicy_unchanged,
                "frozenOutputsUnchanged": outputs_unchanged,
                "tacticalImproved": tactical_improved,
                "eligible": eligible,
                "selected": selected_now,
            }
        )
        print(
            f"epoch {epoch:03d} policy={general['policyLoss']:.6f} "
            f"top1={general['policyTop1']:.3f} "
            f"negative_top1={tactical['negativeTop1Rate']:.3f} "
            f"margin={tactical['meanMargin']:.4f} regressions={failure_count} "
            f"eligible={eligible} selected={selected_now}"
        )

    output_dir = Path(args.out)
    output_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_out = output_dir / "katacat-m351.pt"
    if selected_epoch == 0:
        shutil.copy2(checkpoint_path, checkpoint_out)
    elif selected_state is None:
        raise AssertionError("Selected M3.5.1 epoch has no state")
    else:
        torch.save(
            {
                "modelState": selected_state,
                "inputChannels": int(checkpoint["inputChannels"]),
                "policySize": int(checkpoint["policySize"]),
                "channels": channels,
                "blocks": blocks,
                "boardSize": int(checkpoint["boardSize"]),
                "maxMargin": int(checkpoint["maxMargin"]),
                "epoch": selected_epoch,
                "stage": "M3.5.1",
                "encodingVersion": "PLAYER_RELATIVE_V1",
                "parentCheckpoint": str(checkpoint_path),
                "parentCheckpointSha256": parent_sha,
                "generalValidation": selected_general,
                "frozenTacticalValidation": selected_tactical,
                "trainableScope": "POLICY_HEAD_ONLY",
                "commitSha": args.commit_sha,
            },
            checkpoint_out,
        )

    selected_sha = sha256_file(checkpoint_out)
    improved = selected_epoch > 0
    selected_nonpolicy_sha = (
        parent_nonpolicy_sha
        if selected_epoch == 0
        else nonpolicy_parameter_sha256(model)
    )
    acceptance = {
        "initializedFromM341": checkpoint.get("encodingVersion")
        == "PLAYER_RELATIVE_V1",
        "parentIncludedAsEpoch0": history[0]["epoch"] == 0,
        "policyHeadOnlyTrainable": all(
            name.startswith("policy_head.") for name in trainable_names
        ),
        "nonPolicyParameterHashUnchanged": selected_nonpolicy_sha
        == parent_nonpolicy_sha,
        "frozenOutputsUnchanged": max(selected_output_delta.values()) <= 1e-8,
        "generalValidationFinite": finite_general(selected_general),
        "tacticalRegressionFailuresZero": len(selected_failures) == 0,
        "trainValidationGamesDisjoint": train_games.isdisjoint(validation_games),
        "candidateCheckpointSaved": checkpoint_out.is_file(),
        "checkpointSha256Recorded": len(selected_sha) == 64,
        "noRandomRollouts": True,
        "passed": False,
    }
    acceptance["passed"] = all(
        value for key, value in acceptance.items() if key != "passed"
    )

    summary = {
        "schemaVersion": 1,
        "stage": "M3.5.1_POLICY_HEAD_ONLY_TRAIN",
        "commit_sha": args.commit_sha,
        "device": str(device),
        "encodingVersion": "PLAYER_RELATIVE_V1",
        "parentCheckpoint": str(checkpoint_path),
        "parent_checkpoint_sha256": parent_sha,
        "selected_checkpoint_sha256": selected_sha,
        "parent_nonpolicy_parameter_sha256": parent_nonpolicy_sha,
        "selected_nonpolicy_parameter_sha256": selected_nonpolicy_sha,
        "selected_epoch": selected_epoch,
        "improved_over_parent": improved,
        "trainableScope": "POLICY_HEAD_ONLY",
        "trainableParameterNames": trainable_names,
        "trainableParameters": sum(
            parameter.numel()
            for parameter in model.parameters()
            if parameter.requires_grad
        ),
        "sourceSamples": {
            **{name: len(rows) for name, rows in replay_sources.items()},
            "hardNegative": len(hard_samples),
        },
        "trainSamples": len(train_samples),
        "generalValidationSamples": len(general_validation),
        "frozenTacticalValidationSamples": len(hard_validation),
        "balance": {
            "replay": replay_balance,
            "hardNegative": hard_balance,
            "hardSamplingMultiplier": args.hard_sampling_multiplier,
        },
        "parent": {
            "generalValidation": parent_general,
            "frozenTacticalValidation": parent_tactical,
        },
        "selected": {
            "generalValidation": selected_general,
            "frozenTacticalValidation": {
                **selected_tactical,
                "regressionFailuresVsParent": len(selected_failures),
                "regressionFailureDetails": selected_failures,
            },
        },
        "frozenOutputMaxAbsDelta": selected_output_delta,
        "selectionPolicy": {
            "parentIsEpoch0": True,
            "requiresPolicyLossAndTop1Safety": True,
            "requiresTacticalRegressionFailuresZero": True,
            "requiresTacticalImprovement": True,
            "requiresNonPolicyParametersByteStable": True,
            "requiresAuxiliaryOutputsExactlyStable": True,
        },
        "lossWeights": {
            "policy": 1.0,
            "hardNegativePairwise": args.pairwise_weight,
            "hardNegativeMass": args.negative_mass_weight,
        },
        "acceptance": acceptance,
        "epochHistory": history,
        "note": (
            "M3.5.1 changes only the policy head. The stem, trunk, value, score, and "
            "ownership heads remain byte-stable, so auxiliary outputs are required to be "
            "exactly unchanged. Hard-negative rows are oversampled and no random rollouts are used."
        ),
    }
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary))
    if not acceptance["passed"]:
        raise SystemExit("M3.5.1 training acceptance failed")


if __name__ == "__main__":
    main()
