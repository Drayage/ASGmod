from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path
from typing import Any, Iterable

import torch
from torch.utils.data import DataLoader

import train_katacat_m37 as m37
from train_katacat_m1 import KataCatNet, load_jsonl
from train_katacat_m341 import M341Dataset


FROZEN_MODULES = ("stem", "trunk", "policy_head")
TRAINABLE_HEADS = ("value_head", "score_head", "ownership_head")


def wrapper_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--league-data", required=True)
    parser.add_argument("--bootstrap-data", required=True)
    parser.add_argument("--selfplay-data", required=True)
    parser.add_argument("--mixed-data", required=True)
    parser.add_argument("--curriculum-data", required=True)
    parser.add_argument("--hard-negative-data", required=True)
    parser.add_argument("--init-checkpoint", required=True)
    parser.add_argument("--out", default="katacat-m372-model")
    parser.add_argument("--batch-size", type=int, default=64)
    args, _unknown = parser.parse_known_args()
    return args


def clone_state(module: torch.nn.Module) -> dict[str, torch.Tensor]:
    return {
        name: tensor.detach().cpu().clone()
        for name, tensor in module.state_dict().items()
    }


def module_group_sha(model: KataCatNet, names: Iterable[str]) -> str:
    digest = hashlib.sha256()
    for module_name in names:
        module = getattr(model, module_name)
        for name, tensor in sorted(module.state_dict().items()):
            value = tensor.detach().cpu().contiguous()
            digest.update(f"{module_name}.{name}".encode("utf-8"))
            digest.update(str(tuple(value.shape)).encode("utf-8"))
            digest.update(value.numpy().tobytes())
    return digest.hexdigest()


def configure_head_only(model: KataCatNet, _trainable_blocks: int) -> list[str]:
    for parameter in model.parameters():
        parameter.requires_grad = False
    names: list[str] = []
    for head_name in TRAINABLE_HEADS:
        for name, parameter in getattr(model, head_name).named_parameters():
            parameter.requires_grad = True
            names.append(f"{head_name}.{name}")
    return names


def frozen_sha(model: KataCatNet, _trainable_blocks: int) -> str:
    return module_group_sha(model, FROZEN_MODULES)


def save_head_only_checkpoint(
    path: Path,
    model: KataCatNet,
    base_checkpoint: dict[str, Any],
    epoch: int,
    commit_sha: str,
    _trainable_blocks: int,
) -> None:
    torch.save(
        {
            "modelState": clone_state(model),
            "inputChannels": int(base_checkpoint.get("inputChannels", 16)),
            "policySize": int(base_checkpoint.get("policySize", 82)),
            "channels": int(base_checkpoint["channels"]),
            "blocks": int(base_checkpoint["blocks"]),
            "boardSize": int(base_checkpoint.get("boardSize", 9)),
            "maxMargin": int(base_checkpoint.get("maxMargin", 84)),
            "epoch": int(epoch),
            "stage": "M3.7.2_VALUE_SCORE_OWNERSHIP_HEADS_ONLY",
            "encodingVersion": "PLAYER_RELATIVE_V1",
            "trainableScope": "VALUE_SCORE_OWNERSHIP_HEADS_ONLY",
            "commitSha": commit_sha,
        },
        path,
    )


def load_model(path: Path) -> KataCatNet:
    checkpoint = torch.load(path, map_location="cpu")
    model = KataCatNet(int(checkpoint["channels"]), int(checkpoint["blocks"]))
    model.load_state_dict(checkpoint["modelState"])
    model.eval()
    return model


def validation_rows(path: str, source: str) -> list[dict[str, Any]]:
    return [
        {**row, "trainingSource": source}
        for row in load_jsonl(Path(path))
        if row.get("split") == "validation"
    ]


@torch.no_grad()
def max_policy_delta(
    parent_path: Path,
    candidate_path: Path,
    data_paths: list[tuple[str, str]],
    batch_size: int,
) -> tuple[float, dict[str, Any]]:
    parent = load_model(parent_path)
    candidate = load_model(candidate_path)
    maximum = 0.0
    audit: dict[str, Any] = {
        "totalValidationRows": 0,
        "sources": [],
    }
    for path, source in data_paths:
        rows = validation_rows(path, source)
        audit["sources"].append(
            {
                "source": source,
                "path": path,
                "validationRows": len(rows),
                "audited": bool(rows),
            }
        )
        if not rows:
            continue
        audit["totalValidationRows"] += len(rows)
        dataset = M341Dataset(rows, augment=False)
        loader = DataLoader(dataset, batch_size=batch_size, shuffle=False, num_workers=0)
        for batch in loader:
            features = batch[0]
            delta = (candidate(features)[0] - parent(features)[0]).abs().max().item()
            maximum = max(maximum, float(delta))
    if audit["totalValidationRows"] <= 0:
        raise ValueError("M3.7.2 policy audit found no validation rows across all sources")
    return maximum, audit


def rewrite_summary(args: argparse.Namespace) -> None:
    out = Path(args.out)
    old_checkpoint = out / "katacat-m37.pt"
    new_checkpoint = out / "katacat-m372.pt"
    if not old_checkpoint.is_file():
        raise FileNotFoundError(old_checkpoint)
    shutil.move(old_checkpoint, new_checkpoint)

    summary_path = out / "summary.json"
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    parent_path = Path(args.init_checkpoint)
    parent = load_model(parent_path)
    candidate = load_model(new_checkpoint)
    parent_frozen_sha = module_group_sha(parent, FROZEN_MODULES)
    candidate_frozen_sha = module_group_sha(candidate, FROZEN_MODULES)
    policy_delta, policy_audit = max_policy_delta(
        parent_path,
        new_checkpoint,
        [
            (args.league_data, "league"),
            (args.bootstrap_data, "stabilityBootstrap"),
            (args.selfplay_data, "stabilitySelfplay"),
            (args.mixed_data, "stabilityMixed"),
            (args.curriculum_data, "stabilityCurriculum"),
            (args.hard_negative_data, "hardNegative"),
        ],
        args.batch_size,
    )

    trainable_names = list(summary.get("trainableParameterNames", []))
    only_non_policy_heads = all(
        name.startswith(tuple(f"{head}." for head in TRAINABLE_HEADS))
        for name in trainable_names
    )
    policy_exact = policy_delta == 0.0
    frozen_exact = parent_frozen_sha == candidate_frozen_sha
    if not only_non_policy_heads or not policy_exact or not frozen_exact:
        raise ValueError(
            "M3.7.2 structural contract failed: "
            f"head_only={only_non_policy_heads}, policy_delta={policy_delta}, "
            f"frozen_equal={frozen_exact}"
        )

    summary["schemaVersion"] = 1
    summary["stage"] = "M3.7.2_VALUE_SCORE_OWNERSHIP_HEADS_ONLY"
    summary["trainableScope"] = "VALUE_SCORE_OWNERSHIP_HEADS_ONLY"
    summary["frozenModuleNames"] = list(FROZEN_MODULES)
    summary["frozenModuleSha256"] = {
        "parent": parent_frozen_sha,
        "selected": candidate_frozen_sha,
    }
    summary["maxPolicyLogitDelta"] = policy_delta
    summary["policyAudit"] = policy_audit
    summary["selected"]["maxPolicyLogitDelta"] = policy_delta
    summary["selectionPolicy"].update(
        {
            "requiresStemTrunkPolicyHeadByteStability": True,
            "requiresExactPolicyLogits": True,
            "hardNegativeRowsAreValidationOnly": True,
        }
    )
    summary["lossWeights"].update(
        {
            "policy": 0.0,
            "hardPairwise": 0.0,
            "policyDistill": 0.0,
        }
    )
    summary["acceptance"].update(
        {
            "stemTrunkPolicyHeadByteStable": frozen_exact,
            "policyLogitsExactAcrossAllValidationSources": policy_exact,
            "policyAuditHasValidationRows": policy_audit["totalValidationRows"] > 0,
            "onlyValueScoreOwnershipHeadsTrainable": only_non_policy_heads,
        }
    )
    summary["acceptance"]["passed"] = all(
        bool(value)
        for key, value in summary["acceptance"].items()
        if key != "passed"
    )
    summary["note"] = (
        "M3.7.2 reuses the strict M3.7 selector with a patched optimizer scope. "
        "Stem, every trunk block, and the policy head are byte-identical to M3.4.1; "
        "only value, score, and ownership heads receive gradients. Policy logits are "
        "audited on every source that has validation rows and must have exactly zero "
        "delta; intentionally train-only sources are recorded as not audited."
    )
    summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    args = wrapper_args()
    m37.configure_trainable_scope = configure_head_only
    m37.selected_parameter_sha = frozen_sha
    m37.save_checkpoint = save_head_only_checkpoint
    m37.main()
    rewrite_summary(args)


if __name__ == "__main__":
    main()
