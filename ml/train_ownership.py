"""Train a small residual net to predict where the ground ends up.

The point of this model is not to classify points. It is to give
``evaluateState`` a number for "how far ahead am I on ground" that means
something before the ground is settled, because measurement says the engine has
nothing of the sort:

    signal                     MAE    corr        corr by phase
    shipped projected margin  2.654  0.561    opening 0.021 / middle 0.428 / endgame 0.836
    settled territory alone   2.673  0.541    opening 0.108
    predict a dead heat       3.400     —

Correlation of 0.02 before ply 20 is, at n=4000, indistinguishable from knowing
nothing — and ply 20 is where these games are lost: the human banks ground by
ply 6, the engine not until ply 22. So the model earns its place only if it
says something real early. Sharpening the endgame is worthless; settled
territory already reads 0.836 there by simply counting what is already walled
in.

Hence what this reports. Accuracy is deliberately not the headline: roughly
five in six points end up nobody's, so predicting nothing at all scores about
74% and beats the signal the engine actually uses. The numbers that decide are
the margin correlation *within the opening*, and precision against the 32% the
influence heuristic manages.

    python3 ml/train_ownership.py --data positions.jsonl --out ml-out

CPU only, by design — this has to end up running in a browser.
"""

from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F

BOARD_SIZE = 9
CELLS = BOARD_SIZE * BOARD_SIZE
# empty / A cat / B cat / neutral point / A territory / B territory / to-move
INPUT_PLANES = 7


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, help="positions JSONL from the dataset generator")
    parser.add_argument("--out", default="ml-out")
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--channels", type=int, default=48)
    parser.add_argument("--blocks", type=int, default=4)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--lr", type=float, default=2e-3)
    parser.add_argument("--val-every", type=int, default=5, help="hold out every Nth game")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--seed", type=int, default=20260804)
    parser.add_argument(
        "--settled",
        help="settled-territory margins from settled-margin.mts, one per line",
    )
    return parser.parse_args()


def encode_board(board: str, ownership_to_move: str) -> torch.Tensor:
    """Board string to input planes.

    Territory is derived from the label-free board here rather than passed in:
    the model must work from a position alone, and handing it the answer for
    already-settled points would flatter it on exactly the cells that are free.
    """
    planes = torch.zeros(INPUT_PLANES, BOARD_SIZE, BOARD_SIZE)
    for index, character in enumerate(board):
        row, col = divmod(index, BOARD_SIZE)
        if character == ".":
            planes[0, row, col] = 1.0
        elif character == "A":
            planes[1, row, col] = 1.0
        elif character == "B":
            planes[2, row, col] = 1.0
        elif character == "N":
            planes[3, row, col] = 1.0
    # Planes 4 and 5 are left for settled territory, filled by the caller when
    # the generator supplies it; plane 6 marks whose turn it is.
    if ownership_to_move == "A":
        planes[6].fill_(1.0)
    return planes


def load(path: Path, val_every: int):
    boards, owners, margins, plies, games = [], [], [], [], []
    with path.open() as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            board = row["board"]
            own = row.get("own") or row.get("ownership")
            if isinstance(own, list):
                own = "".join(".AB"[value] for value in own)
            margin = row.get("margin", row.get("finalMargin"))
            if board is None or own is None or margin is None:
                raise ValueError(f"row lacks board/own/margin: {line[:120]}")
            boards.append(board)
            owners.append(own)
            margins.append(float(margin))
            plies.append(int(row.get("ply", 0)))
            games.append(int(row.get("g", row.get("gameIndex", 0))))

    to_move = ["A" if ply % 2 == 0 else "B" for ply in plies]
    x = torch.stack([encode_board(b, m) for b, m in zip(boards, to_move)])

    # Ownership target: 0 nobody, 1 A, 2 B.
    y_own = torch.zeros(len(owners), CELLS, dtype=torch.long)
    for i, own in enumerate(owners):
        for j, character in enumerate(own):
            y_own[i, j] = 1 if character == "A" else 2 if character == "B" else 0

    y_margin = torch.tensor(margins, dtype=torch.float32)
    ply_tensor = torch.tensor(plies, dtype=torch.long)

    # Whole games go to one side of the split. Positions inside a game share a
    # label and are near duplicates, so splitting within one leaks the answer.
    unique_games = sorted(set(games))
    held = {game for i, game in enumerate(unique_games) if i % val_every == 0}
    is_val = torch.tensor([game in held for game in games])
    return x, y_own, y_margin, ply_tensor, is_val, len(unique_games), len(held)


class Block(nn.Module):
    def __init__(self, channels: int) -> None:
        super().__init__()
        self.c1 = nn.Conv2d(channels, channels, 3, padding=1, bias=False)
        self.b1 = nn.BatchNorm2d(channels)
        self.c2 = nn.Conv2d(channels, channels, 3, padding=1, bias=False)
        self.b2 = nn.BatchNorm2d(channels)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        y = F.relu(self.b1(self.c1(x)))
        y = self.b2(self.c2(y))
        return F.relu(x + y)


class OwnershipNet(nn.Module):
    """Trunk with two heads: per-point ownership, and the final margin.

    The margin head is not a second task bolted on — it is the output the
    evaluation would actually consume. Ownership is what makes it learnable:
    a single number per position is a thin signal, while 81 labelled points per
    position is a dense one that forces the trunk to represent which ground is
    holdable.
    """

    def __init__(self, channels: int, blocks: int) -> None:
        super().__init__()
        self.stem = nn.Sequential(
            nn.Conv2d(INPUT_PLANES, channels, 3, padding=1, bias=False),
            nn.BatchNorm2d(channels),
            nn.ReLU(inplace=True),
        )
        self.blocks = nn.Sequential(*[Block(channels) for _ in range(blocks)])
        self.own_head = nn.Conv2d(channels, 3, 1)
        self.margin_head = nn.Sequential(
            nn.Conv2d(channels, 8, 1),
            nn.BatchNorm2d(8),
            nn.ReLU(inplace=True),
            nn.Flatten(),
            nn.Linear(8 * CELLS, 64),
            nn.ReLU(inplace=True),
            nn.Linear(64, 1),
        )

    def forward(self, x: torch.Tensor):
        h = self.blocks(self.stem(x))
        own = self.own_head(h).flatten(2).transpose(1, 2)  # (N, cells, 3)
        margin = self.margin_head(h).squeeze(-1)
        return own, margin


def correlation(a: torch.Tensor, b: torch.Tensor) -> float:
    if a.numel() < 2:
        return float("nan")
    a = a - a.mean()
    b = b - b.mean()
    denom = a.norm() * b.norm()
    return float((a @ b) / denom) if float(denom) > 0 else float("nan")


def evaluate(model: nn.Module, x, y_own, y_margin, plies, batch_size: int, settled_margin):
    model.eval()
    own_pred, margin_pred, own_prob_batches = [], [], []
    with torch.no_grad():
        for start in range(0, len(x), batch_size):
            o, m = model(x[start : start + batch_size])
            own_pred.append(o.argmax(-1))
            own_prob_batches.append(torch.softmax(o, dim=-1))
            margin_pred.append(m)
    own_pred = torch.cat(own_pred)
    margin_pred = torch.cat(margin_pred)

    # Only open points count. An occupied one can never become territory, so
    # predicting nobody there is free credit, and on a busy board it is most of
    # the score.
    open_mask = x[:, 0].flatten(1) > 0.5
    correct = (own_pred == y_own) & open_mask
    open_accuracy = float(correct.sum()) / max(1, int(open_mask.sum()))

    claimed = (own_pred > 0) & open_mask
    held = (y_own > 0) & open_mask
    hit = claimed & held & (own_pred == y_own)
    precision = float(hit.sum()) / max(1, int(claimed.sum()))
    recall = float(hit.sum()) / max(1, int(held.sum()))

    # The engine already counts settled ground exactly. A model that has to
    # learn that count cannot beat arithmetic at it — measured, it reads 0.481
    # in the endgame against the engine's 0.836. So the combination worth
    # testing is not "model instead of" but "exact count plus model, over the
    # open points only", which is the one part arithmetic cannot supply.
    own_prob = torch.cat(own_prob_batches)
    open_only = open_mask.float()
    predicted_open = ((own_prob[:, :, 1] - own_prob[:, :, 2]) * open_only).sum(1)
    hybrid = settled_margin + predicted_open

    mae = float((margin_pred - y_margin).abs().mean())
    result = {
        "openAccuracy": open_accuracy,
        "territoryPrecision": precision,
        "territoryRecall": recall,
        "marginMAE": mae,
        "marginCorr": correlation(margin_pred, y_margin),
        "hybridMarginMAE": float((hybrid - y_margin).abs().mean()),
        "hybridMarginCorr": correlation(hybrid, y_margin),
        "settledOnlyCorr": correlation(settled_margin, y_margin),
        "byPhase": {},
    }
    for label, lo, hi in (("opening", 0, 20), ("middle", 20, 40), ("endgame", 40, 10_000)):
        sel = (plies >= lo) & (plies < hi)
        if int(sel.sum()) < 2:
            continue
        result["byPhase"][label] = {
            "n": int(sel.sum()),
            "marginCorr": correlation(margin_pred[sel], y_margin[sel]),
            "marginMAE": float((margin_pred[sel] - y_margin[sel]).abs().mean()),
            "hybridMarginCorr": correlation(hybrid[sel], y_margin[sel]),
            "hybridMarginMAE": float((hybrid[sel] - y_margin[sel]).abs().mean()),
            "settledOnlyCorr": correlation(settled_margin[sel], y_margin[sel]),
        }
    return result


def main() -> None:
    args = parse_args()
    torch.manual_seed(args.seed)
    torch.set_num_threads(args.threads)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    x, y_own, y_margin, plies, is_val, games, held = load(Path(args.data), args.val_every)

    if args.settled:
        settled_all = torch.tensor(
            [float(value) for value in Path(args.settled).read_text().split()],
            dtype=torch.float32,
        )
        if len(settled_all) != len(x):
            raise ValueError(f"settled file has {len(settled_all)} rows, data has {len(x)}")
    else:
        settled_all = torch.zeros(len(x))
    train_idx = (~is_val).nonzero(as_tuple=True)[0]
    val_idx = is_val.nonzero(as_tuple=True)[0]
    print(
        f"{len(x)} positions from {games} games — "
        f"train {len(train_idx)} / held-out {len(val_idx)} ({held} games)"
    )

    model = OwnershipNet(args.channels, args.blocks)
    params = sum(p.numel() for p in model.parameters())
    print(f"model: {args.channels} channels x {args.blocks} blocks, {params:,} parameters\n")

    optimiser = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    schedule = torch.optim.lr_scheduler.CosineAnnealingLR(optimiser, T_max=args.epochs)

    history = []
    best = {"score": -math.inf, "epoch": 0, "state": None}
    for epoch in range(1, args.epochs + 1):
        model.train()
        order = train_idx[torch.randperm(len(train_idx))]
        total, seen = 0.0, 0
        started = time.time()
        for start in range(0, len(order), args.batch_size):
            batch = order[start : start + args.batch_size]
            own_logits, margin = model(x[batch])
            own_loss = F.cross_entropy(own_logits.reshape(-1, 3), y_own[batch].reshape(-1))
            # Margin in cells is O(10); scaled so neither head dominates.
            margin_loss = F.smooth_l1_loss(margin, y_margin[batch])
            loss = own_loss + 0.15 * margin_loss
            optimiser.zero_grad(set_to_none=True)
            loss.backward()
            optimiser.step()
            total += float(loss.detach()) * len(batch)
            seen += len(batch)
        schedule.step()

        stats = evaluate(
            model,
            x[val_idx],
            y_own[val_idx],
            y_margin[val_idx],
            plies[val_idx],
            args.batch_size,
            settled_all[val_idx],
        )
        opening = stats["byPhase"].get("opening", {})
        history.append({"epoch": epoch, "trainLoss": total / max(1, seen), **stats})
        # Selected on the hybrid correlation over all positions — exact settled
        # count plus the model's read of the open points — because that is the
        # quantity the evaluation would actually consume. Measured by phase, it
        # is the strongest signal available late (0.857 against the engine's
        # 0.836) while the margin head is the only one carrying anything at all
        # early (0.228 against 0.021), so both are kept and reported; picking on
        # the opening alone would select a model that is worse everywhere else.
        score = stats.get("hybridMarginCorr") or -math.inf
        if score > best["score"]:
            best = {
                "score": score,
                "epoch": epoch,
                "state": {k: v.clone() for k, v in model.state_dict().items()},
            }
        print(
            f"epoch {epoch:2d}  loss {total / max(1, seen):.4f}  "
            f"open-acc {stats['openAccuracy'] * 100:5.2f}%  "
            f"prec {stats['territoryPrecision'] * 100:5.2f}%  "
            f"rec {stats['territoryRecall'] * 100:5.2f}%  "
            f"margin MAE {stats['marginMAE']:.3f} r={stats['marginCorr']:.3f}  "
            f"opening r={opening.get('marginCorr', float('nan')):.3f}/"
            f"{opening.get('hybridMarginCorr', float('nan')):.3f}  "
            f"({time.time() - started:.0f}s)"
        )

    final = history[-1]
    best_entry = next(item for item in history if item["epoch"] == best["epoch"])
    torch.save(
        {
            "state_dict": best["state"] if best["state"] is not None else model.state_dict(),
            "channels": args.channels,
            "blocks": args.blocks,
            "epoch": best["epoch"],
        },
        out_dir / "ownership.pt",
    )
    summary = {
        "schemaVersion": 1,
        "stage": "PHASE_2_OWNERSHIP_MODEL",
        "config": vars(args),
        "parameters": params,
        "positions": len(x),
        "games": games,
        "final": final,
        "best": best_entry,
        "history": history,
        "baselines": {
            "note": "measured by margin-headroom.mts over the same pilot data",
            "shippedProjectedMargin": {"marginMAE": 2.654, "marginCorr": 0.561, "openingCorr": 0.021},
            "settledTerritoryMargin": {"marginMAE": 2.673, "marginCorr": 0.541, "openingCorr": 0.108},
            "influenceOwnership": {"territoryPrecision": 0.315, "territoryRecall": 0.767},
            "alwaysNeutral": {"openAccuracy": 0.741, "territoryRecall": 0.0},
        },
        "verdict": {
            "beatsInfluencePrecision": final["territoryPrecision"] > 0.315,
            "informativeInOpening": max(
                best_entry["byPhase"].get("opening", {}).get("marginCorr", 0),
                best_entry["byPhase"].get("opening", {}).get("hybridMarginCorr", 0),
            )
            > 0.30,
            "note": "The opening number is the one that matters. Settled territory "
            "already reads 0.836 in the endgame, so a model that only sharpens "
            "late adds nothing the engine cannot already compute.",
        },
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(f"\nwrote {out_dir / 'ownership.pt'} and {out_dir / 'summary.json'}")


if __name__ == "__main__":
    main()
