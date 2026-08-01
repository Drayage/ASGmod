# KataCat M3.6.1 — rejected residual-adapter diagnostics

M3.6 learned a useful average tactical correction but retained epoch 0 because every trained adapter introduced frozen tactical regressions. M3.6.1 does not train another model. It diagnoses whether the strongest rejected adapters contain enough real-game signal to justify a targeted M3.6.2.

## Frozen inputs

- successful M3.6 prepared artifact
- M3.4.1 parent checkpoint and fallback
- M3.6 epoch checkpoints 0, 8, 13, and 16
- M3.6 256-game hard-negative source
- original M3.4.1 development result for capture-loss reference

## Position diagnostics

The diagnostic identifies the three regression positions appearing most often across epochs 8, 13, and 16. For each position and checkpoint it records:

- positive bounded-reader teacher action rank and probability
- strongest proved-negative action rank and probability
- positive-minus-negative logit margin
- adapter residual on the relevant actions
- whether the top legal action is proved negative

A teacher action being non-refuted under the configured reader is diagnostic evidence only, not a mathematical proof of safety.

## Small arenas

Each rejected checkpoint plays deterministic mirrored openings against:

- frozen M3.4.1 parent: 16 games
- CURRENT VERY_HARD: 16 games

The same M3.4.1 reader-checked fallback is used for both relative models. These 16-game comparisons are diagnostic only and cannot support promotion.

A rejected epoch is considered to have a positive small-arena signal only when it:

- scores at least 50% against the parent,
- scores at least 45% against CURRENT,
- and stays within 5 percentage points of the M3.4.1 CURRENT capture-loss reference.

If a candidate meets those conditions, the recommendation is to target the repeated regression positions before an M3.6.2 retrain. Otherwise the recommendation is to stop the residual-adapter line and return to fresh self-play/training data.

No shipped HARD/VERY_HARD, UI, browser inference, or promotion checkpoint is changed by this stage.
