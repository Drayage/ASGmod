# Alley Boss Cats ownership learning POC

This is the first low-risk experiment before adding a neural policy or PUCT search.

The goal is deliberately narrow:

1. Generate territory-rich positions from the existing CURRENT engine.
2. Train a small 9x9 residual network to predict final territory ownership and the final adjusted territory margin.
3. Check whether those signals generalize to held-out games.

The model is **not connected to the actual game AI**. CURRENT remains the shipped HARD / VERY_HARD engine.

## Important label caveat

Normal CURRENT self-play usually ends in capture before useful territory labels appear. The first dataset therefore uses a quiet curriculum:

- CURRENT VERY_HARD supplies the main teacher move.
- Moves that immediately end by capture are skipped.
- Territory planner moves are deliberately oversampled.
- The game is ended by two forced passes after the configured move limit.

This answers only the first question: **can a small model learn a meaningful territory map from this game state?**

It is not optimal-play ground truth and must not be used to claim that the model is stronger than CURRENT.

## 1. Generate a dataset

```bash
npm ci
npm run dataset:ownership -- --games=12 --teacher-ms=300
```

Generated files:

```text
ownership-dataset.jsonl
ownership-dataset.meta.json
```

A larger local run:

```bash
npm run dataset:ownership -- \
  --games=100 \
  --teacher-ms=300 \
  --max-moves=60 \
  --sample-every=2 \
  --output=data/ownership-dataset.jsonl
```

The TypeScript generator is deterministic for the same seed, but the time-boxed CURRENT search can still vary slightly across different machines.

## 2. Train the model

```bash
python -m venv .venv
```

Windows:

```bash
.venv\Scripts\activate
```

macOS / Linux:

```bash
source .venv/bin/activate
```

Install and train:

```bash
python -m pip install -r ml/requirements.txt
python ml/train_ownership.py \
  --data ownership-dataset.jsonl \
  --out ownership-training \
  --epochs 20
```

The script automatically uses CUDA when available. With an RTX 3080, leave `--device=auto` or explicitly pass `--device=cuda`.

Outputs:

```text
ownership-training/ownership-model.pt
ownership-training/summary.json
```

## Metrics

The first experiment reports:

- `ownershipAccuracy`: accuracy across all 81 cells. This is easy to inflate because many cells remain neutral.
- `iouA`, `iouB`: intersection-over-union for each side's final territory.
- `meanTerritoryIou`: the main ownership metric.
- `scoreMaeCells`: average final-margin prediction error measured in board cells.

The validation split is made by whole game, not by random positions, so positions from one game cannot leak into both training and validation.

No fixed pass threshold is declared in advance. First inspect whether validation improves consistently as data grows. A useful signal would look like:

- territory IoU clearly above a neutral-only baseline,
- score MAE decreasing on held-out games,
- similar results across multiple seeds.

## Next gate

Only after ownership and score prediction show a repeatable signal:

1. Add a teacher-policy head.
2. Re-rank CURRENT's tactically safe candidates with the model.
3. Build a fixed territory-position benchmark.
4. Add neural PUCT only if candidate re-ranking improves that benchmark without increasing capture losses.
