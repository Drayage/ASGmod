"""Export a trained ownership net in a form the browser can run.

Two things happen here, both to keep the TypeScript side small enough to trust.

Batch norm is folded into the convolution before it. At inference a batch norm
is just an affine map, so

    w' = w * gamma / sqrt(var + eps)
    b' = beta - gamma * mean / sqrt(var + eps)

leaves an ordinary convolution with a bias and removes the layer entirely. The
engine then needs only convolution, addition and ReLU — no running statistics
to carry across a language boundary and get subtly wrong.

And a handful of reference inputs and outputs go in the file. The port has to
be checked numerically, not by reading it: a transposed weight or an off-by-one
in padding produces a net that still runs and still returns plausible numbers,
and would be found only as a mysteriously weaker engine several steps later.

    python3 ml/export_ownership.py --model ml-out/ownership.pt --out public/ownership-net.json
"""

from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path

import torch

from train_ownership import BOARD_SIZE, INPUT_PLANES, OwnershipNet


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--reference-cases", type=int, default=4)
    parser.add_argument("--seed", type=int, default=20260806)
    return parser.parse_args()


def fold(conv: torch.nn.Conv2d, norm: torch.nn.BatchNorm2d):
    """Convolution and the batch norm after it, as one convolution with bias."""
    scale = norm.weight / torch.sqrt(norm.running_var + norm.eps)
    weight = conv.weight * scale.reshape(-1, 1, 1, 1)
    bias = norm.bias - norm.running_mean * scale
    if conv.bias is not None:
        bias = bias + conv.bias * scale
    return weight.detach(), bias.detach()


def pack(tensor: torch.Tensor) -> str:
    """Float32, little-endian, base64 — one blob per tensor, shapes kept apart."""
    return base64.b64encode(
        tensor.detach().to(torch.float32).contiguous().cpu().numpy().tobytes()
    ).decode("ascii")


def tensor_entry(tensor: torch.Tensor) -> dict:
    return {"shape": list(tensor.shape), "data": pack(tensor)}


def main() -> None:
    args = parse_args()
    checkpoint = torch.load(args.model, map_location="cpu", weights_only=False)
    channels = checkpoint["channels"]
    blocks = checkpoint["blocks"]

    model = OwnershipNet(channels, blocks)
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()

    layers: dict[str, dict] = {}

    stem_w, stem_b = fold(model.stem[0], model.stem[1])
    layers["stem"] = {"weight": tensor_entry(stem_w), "bias": tensor_entry(stem_b)}

    block_entries = []
    for block in model.blocks:
        w1, b1 = fold(block.c1, block.b1)
        w2, b2 = fold(block.c2, block.b2)
        block_entries.append(
            {
                "conv1": {"weight": tensor_entry(w1), "bias": tensor_entry(b1)},
                "conv2": {"weight": tensor_entry(w2), "bias": tensor_entry(b2)},
            }
        )

    layers["ownHead"] = {
        "weight": tensor_entry(model.own_head.weight),
        "bias": tensor_entry(model.own_head.bias),
    }

    margin_w, margin_b = fold(model.margin_head[0], model.margin_head[1])
    layers["marginConv"] = {"weight": tensor_entry(margin_w), "bias": tensor_entry(margin_b)}
    # Found by type rather than position: indexing into the Sequential silently
    # picks up whatever happens to sit there if the head is ever reordered, and
    # a ReLU has no weights to notice it with until export crashes — or worse,
    # does not.
    linears = [layer for layer in model.margin_head if isinstance(layer, torch.nn.Linear)]
    if len(linears) != 2:
        raise ValueError(f"expected two linear layers in the margin head, found {len(linears)}")
    layers["marginLinear1"] = {
        "weight": tensor_entry(linears[0].weight),
        "bias": tensor_entry(linears[0].bias),
    }
    layers["marginLinear2"] = {
        "weight": tensor_entry(linears[1].weight),
        "bias": tensor_entry(linears[1].bias),
    }

    # Reference cases: random but reproducible boards, with the outputs this
    # model gives for them. The port is checked against these rather than read.
    torch.manual_seed(args.seed)
    cases = []
    with torch.no_grad():
        for _ in range(args.reference_cases):
            x = torch.zeros(1, INPUT_PLANES, BOARD_SIZE, BOARD_SIZE)
            # Plausible occupancy rather than uniform noise: a net fed inputs it
            # would never see can agree on those and still disagree on real ones.
            occupancy = torch.randint(0, 3, (BOARD_SIZE, BOARD_SIZE))
            for row in range(BOARD_SIZE):
                for col in range(BOARD_SIZE):
                    x[0, int(occupancy[row, col]), row, col] = 1.0
            x[0, 6].fill_(float(torch.randint(0, 2, (1,)).item()))
            own, margin = model(x)
            cases.append(
                {
                    "input": tensor_entry(x[0]),
                    "ownLogits": tensor_entry(own[0]),
                    "margin": float(margin[0]),
                }
            )

    payload = {
        "schemaVersion": 1,
        "architecture": {
            "boardSize": BOARD_SIZE,
            "inputPlanes": INPUT_PLANES,
            "channels": channels,
            "blocks": blocks,
        },
        "batchNormFolded": True,
        "dtype": "float32",
        "layers": layers,
        "blockLayers": block_entries,
        "referenceCases": cases,
        "sourceEpoch": checkpoint.get("epoch"),
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload) + "\n")

    parameters = sum(p.numel() for p in model.parameters())
    print(
        f"exported {channels}x{blocks} ({parameters:,} parameters) to {out_path} "
        f"— {out_path.stat().st_size / 1024:.0f} KB, {len(cases)} reference cases"
    )


if __name__ == "__main__":
    main()
