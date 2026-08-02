from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path
from typing import Any

import torch

VARIANTS = (
    ("e1-value-only", 1, ("value_head.",)),
    ("e1-score-only", 1, ("score_head.",)),
    ("e2-value-only", 2, ("value_head.",)),
    ("e2-score-only", 2, ("score_head.",)),
)
FROZEN_PREFIXES = ("stem.", "trunk.", "policy_head.", "ownership_head.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build M3.8 fixed-checkpoint value/score head ablation variants."
    )
    parser.add_argument("--parent", required=True)
    parser.add_argument("--epoch1", required=True)
    parser.add_argument("--epoch2", required=True)
    parser.add_argument("--out", default="katacat-m38-checkpoints")
    parser.add_argument("--commit-sha", default="unknown")
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tensor_sha(state: dict[str, torch.Tensor], prefixes: tuple[str, ...]) -> str:
    digest = hashlib.sha256()
    selected = [name for name in state if name.startswith(prefixes)]
    for name in sorted(selected):
        tensor = state[name].detach().cpu().contiguous()
        digest.update(name.encode("utf-8"))
        digest.update(str(tuple(tensor.shape)).encode("utf-8"))
        digest.update(str(tensor.dtype).encode("utf-8"))
        digest.update(tensor.numpy().tobytes())
    return digest.hexdigest()


def same_architecture(left: dict[str, Any], right: dict[str, Any]) -> bool:
    fields = (
        "inputChannels",
        "policySize",
        "channels",
        "blocks",
        "boardSize",
        "maxMargin",
        "encodingVersion",
    )
    return all(left.get(field) == right.get(field) for field in fields)


def differing_keys(
    left: dict[str, torch.Tensor], right: dict[str, torch.Tensor]
) -> list[str]:
    if set(left) != set(right):
        missing = sorted(set(left).symmetric_difference(right))
        raise ValueError(f"Checkpoint modelState key mismatch: {missing[:8]}")
    return [name for name in sorted(left) if not torch.equal(left[name], right[name])]


def build_variant(
    parent: dict[str, Any],
    source: dict[str, Any],
    name: str,
    epoch: int,
    copied_prefixes: tuple[str, ...],
    commit_sha: str,
    output_path: Path,
) -> dict[str, Any]:
    if not same_architecture(parent, source):
        raise ValueError(f"{name}: source checkpoint architecture differs from parent")
    if int(source.get("epoch", -1)) != epoch:
        raise ValueError(f"{name}: expected epoch {epoch}, got {source.get('epoch')}")

    parent_state = parent["modelState"]
    source_state = source["modelState"]
    source_differences = differing_keys(parent_state, source_state)
    if not source_differences:
        raise ValueError(f"{name}: source epoch is byte-identical to parent")

    variant = copy.deepcopy(parent)
    variant_state = variant["modelState"]
    copied_keys = [key for key in sorted(variant_state) if key.startswith(copied_prefixes)]
    if not copied_keys:
        raise ValueError(f"{name}: no keys matched {copied_prefixes}")
    for key in copied_keys:
        variant_state[key] = source_state[key].detach().cpu().clone()

    changed_keys = differing_keys(parent_state, variant_state)
    if changed_keys != copied_keys:
        unexpected = sorted(set(changed_keys).symmetric_difference(copied_keys))
        raise ValueError(f"{name}: changed-key contract mismatch: {unexpected[:8]}")
    if not any(key in source_differences for key in copied_keys):
        raise ValueError(f"{name}: copied head does not differ from parent")

    frozen_unchanged = all(
        torch.equal(parent_state[key], variant_state[key])
        for key in parent_state
        if key.startswith(FROZEN_PREFIXES)
    )
    if not frozen_unchanged:
        raise ValueError(f"{name}: frozen module changed")

    variant.update(
        {
            "epoch": epoch,
            "stage": "M3.8_HEAD_ABLATION_DIAGNOSTIC",
            "encodingVersion": parent.get("encodingVersion", "PLAYER_RELATIVE_V1"),
            "sourceStage": source.get("stage"),
            "sourceEpoch": epoch,
            "copiedHeads": [prefix.removesuffix(".") for prefix in copied_prefixes],
            "trainableScope": "NONE_FIXED_CHECKPOINT_ABLATION",
            "commitSha": commit_sha,
        }
    )
    torch.save(variant, output_path)

    return {
        "name": name,
        "path": str(output_path),
        "sourceEpoch": epoch,
        "copiedHeads": variant["copiedHeads"],
        "changedKeyCount": len(changed_keys),
        "changedKeys": changed_keys,
        "checkpointSha256": sha256_file(output_path),
        "frozenStateSha256": tensor_sha(variant_state, FROZEN_PREFIXES),
        "copiedStateSha256": tensor_sha(variant_state, copied_prefixes),
        "acceptance": {
            "architectureMatchesParent": True,
            "sourceEpochMatches": True,
            "onlyRequestedHeadChanged": True,
            "frozenModulesByteIdentical": True,
            "copiedHeadDiffersFromParent": True,
            "passed": True,
        },
    }


def main() -> None:
    args = parse_args()
    parent_path = Path(args.parent)
    epoch_paths = {1: Path(args.epoch1), 2: Path(args.epoch2)}
    output_dir = Path(args.out)
    output_dir.mkdir(parents=True, exist_ok=True)

    parent = torch.load(parent_path, map_location="cpu")
    epochs = {epoch: torch.load(path, map_location="cpu") for epoch, path in epoch_paths.items()}
    if parent.get("encodingVersion") != "PLAYER_RELATIVE_V1":
        raise ValueError("M3.8 requires PLAYER_RELATIVE_V1 parent")

    parent_state = parent["modelState"]
    parent_frozen_sha = tensor_sha(parent_state, FROZEN_PREFIXES)
    rows = []
    for name, epoch, prefixes in VARIANTS:
        rows.append(
            build_variant(
                parent,
                epochs[epoch],
                name,
                epoch,
                prefixes,
                args.commit_sha,
                output_dir / f"katacat-m38-{name}.pt",
            )
        )

    frozen_hashes = {row["frozenStateSha256"] for row in rows}
    acceptance = {
        "variantCountFour": len(rows) == 4,
        "allVariantsPassed": all(row["acceptance"]["passed"] for row in rows),
        "allFrozenHashesMatchParent": frozen_hashes == {parent_frozen_sha},
        "parentCheckpointPresent": parent_path.is_file(),
        "passed": False,
    }
    acceptance["passed"] = all(
        value for key, value in acceptance.items() if key != "passed"
    )
    summary = {
        "schemaVersion": 1,
        "stage": "M3.8_HEAD_ABLATION_BUILD",
        "commitSha": args.commit_sha,
        "parent": {
            "path": str(parent_path),
            "checkpointSha256": sha256_file(parent_path),
            "frozenStateSha256": parent_frozen_sha,
        },
        "sources": {
            str(epoch): {
                "path": str(path),
                "checkpointSha256": sha256_file(path),
                "stage": epochs[epoch].get("stage"),
                "epoch": epochs[epoch].get("epoch"),
            }
            for epoch, path in epoch_paths.items()
        },
        "variants": rows,
        "acceptance": acceptance,
        "note": (
            "M3.8 does not train or interpolate parameters. Each fixed checkpoint copies exactly one "
            "value or score head from M3.7.2 epoch 1 or 2 into the byte-identical M3.4.1 parent."
        ),
    }
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    if not acceptance["passed"]:
        raise ValueError(f"M3.8 build acceptance failed: {acceptance}")
    print(json.dumps({"acceptance": acceptance, "variants": [row["name"] for row in rows]}))


if __name__ == "__main__":
    main()
