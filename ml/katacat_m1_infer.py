from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import torch

from train_katacat_m1 import KataCatNet, featurize


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Serve KataCat M1 inference as newline-delimited JSON over stdin/stdout."
    )
    parser.add_argument("--checkpoint", required=True)
    return parser.parse_args()


def load_model(path: Path) -> KataCatNet:
    checkpoint = torch.load(path, map_location="cpu")
    model = KataCatNet(int(checkpoint["channels"]), int(checkpoint["blocks"]))
    model.load_state_dict(checkpoint["modelState"])
    model.eval()
    return model


@torch.no_grad()
def evaluate(model: KataCatNet, sample: dict[str, Any]) -> dict[str, Any]:
    features = torch.from_numpy(featurize(sample)).unsqueeze(0)
    policy_logits, value, score, ownership_logits = model(features)
    ownership = torch.softmax(ownership_logits, dim=1)
    return {
        "policyLogits": policy_logits.squeeze(0).tolist(),
        "value": float(value.item()),
        "score": float(score.item()),
        "ownership": ownership.squeeze(0).reshape(-1).tolist(),
    }


def main() -> None:
    args = parse_args()
    torch.set_num_threads(1)
    model = load_model(Path(args.checkpoint))
    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        stripped = line.strip()
        if not stripped:
            continue
        try:
            request = json.loads(stripped)
            response = evaluate(model, request)
        except Exception as exc:  # The caller needs a structured failure, not a hung pipe.
            response = {"error": f"{type(exc).__name__}: {exc}"}
        print(json.dumps(response, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
