# KataCat M3.8.1 — e1 score-only 128-game diagnostic

M3.8 isolated the M3.7.2 epoch-1 and epoch-2 value and score heads. Both score-only variants tied M3.4.1 16-16 and scored 17-15 against CURRENT in the 32-game screen, while the value-only aggregate regressed against CURRENT.

M3.8.1 evaluates only the more conservative `e1-score-only` checkpoint with an independent 128-game arena.

## Fixed inputs

- source workflow: successful `KataCat M3.8 head ablation`
- candidate: `katacat-m38-e1-score-only.pt`
- parent: unchanged M3.4.1 checkpoint
- candidate mutation: exactly seven `score_head.*` tensors
- training, interpolation, and checkpoint editing: none

## Arena

The existing improved-fallback arena runs 128 games for each comparison:

- candidate vs M3.4.1
- candidate vs CURRENT
- M3.4.1 vs CURRENT paired control

The summary reports Wilson intervals, seat gaps, capture-loss deltas, and whether the fixed score-only checkpoint justifies a fresh official pipeline.

## Interpretation

This is diagnostic-only. It cannot override previous gates, promote a model, or authorize a merge. A favorable result only permits designing and running a fresh official score-only pipeline. An unfavorable result stops the M3.8 continuation and keeps M3.4.1 shipped.
