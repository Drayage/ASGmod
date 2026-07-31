from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import torch

from katacat_m33_relative import relative_featurize
from katacat_m36_adapter import load_m36_checkpoint


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Serve KataCat M3.6 residual-policy-adapter inference."
    )
    parser.add_argument("--checkpoint", required=True)
    return parser.parse_args()


@torch.no_grad()
def evaluate(model, sample: dict[str, Any]) -> dict[str, Any]:
    features = torch.from_numpy(relative_featurize(sample)).unsqueeze(0)
    policy_logits, value, score, ownership_logits = model(features)
    ownership = torch.softmax(ownership_logits, dim=1)
    return {
        "policyLogits": policy_logits.squeeze(0).tolist(),
        "value": float(value.item()),
        "score": float(score.item()),
        "ownership": ownership.squeeze(0).reshape(-1).tolist(),
        "encodingVersion": "PLAYER_RELATIVE_V1",
        "policyAdapter": "M3.6_RESIDUAL_POLICY_ADAPTER",
    }


def main() -> None:
    args = parse_args()
    torch.set_num_threads(1)
    loaded = load_m36_checkpoint(Path(args.checkpoint), device="cpu")
    model = loaded.model
    print(
        json.dumps(
            {
                "ready": True,
                "encodingVersion": "PLAYER_RELATIVE_V1",
                "policyAdapter": "M3.6_RESIDUAL_POLICY_ADAPTER",
                "selectedEpoch": loaded.checkpoint.get("selectedEpoch"),
            }
        ),
        flush=True,
    )
    for line in sys.stdin:
        text = line.strip()
        if not text:
            continue
        try:
            response = evaluate(model, json.loads(text))
        except Exception as exc:
            response = {"error": f"{type(exc).__name__}: {exc}"}
        print(json.dumps(response, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
