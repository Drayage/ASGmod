# KataCat M3.6 — bounded residual policy adapter

M3.5 and M3.5.1 showed that direct fine-tuning is not parent-safe under the current data:

- shared trunk updates improved some policy metrics but degraded score/ownership behavior;
- policy-head-only updates preserved auxiliary outputs exactly but worsened general policy validation and overfit the small tactical set;
- strict selection correctly retained the M3.4.1 parent in both experiments.

M3.6 therefore freezes the complete M3.4.1 network and adds a small zero-initialized correction to policy logits only.

## Model

The adapter reads frozen trunk features and produces an 82-action residual:

```text
corrected policy logits = frozen M3.4.1 policy logits + bounded adapter residual
```

The residual is bounded elementwise by `maxAbsDelta * tanh(raw)`. Its final layer is initialized to zero, so epoch 0 is exactly behavior-equivalent to M3.4.1.

The value, score, ownership, stem, residual trunk, and original policy head are all frozen. The checkpoint is self-contained and records both the frozen base state and adapter state.

## Training objective

M3.6 uses:

- strong KL anchoring from the corrected policy to the frozen parent on ordinary replay states;
- residual-magnitude regularization on ordinary replay states;
- a small replay policy loss;
- pairwise ranking between the bounded-reader teacher action and proved-refuted actions;
- a negative-logit-mass penalty across all proved-refuted actions.

The teacher action is only known to be non-refuted within the configured reader budget. It is not a mathematical proof of safety.

## Larger tactical source

The workflow mines 256 fresh parent-vs-CURRENT games using the M3.4.1 collector rather than reusing the original 64-game source. Splits remain game-disjoint, positions are globally deduplicated, per-game samples are capped, and only naturally terminal games receive final outcome labels.

Training acceptance requires at least 300 deduplicated hard-negative samples. A smaller source fails technically rather than being interpreted as model evidence.

## Parent-safe selection

Epoch 0 is the zero adapter. A trained epoch is eligible only when all of the following hold:

- frozen base parameters remain byte-stable;
- general policy loss and top-1 stay within tight parent tolerances;
- general parent-to-candidate KL stays bounded;
- mean and maximum residual logits stay bounded;
- frozen tactical regression count is zero;
- at least one tactical metric improves.

All epoch checkpoints are preserved. If no epoch is eligible, the selected adapter remains zero and the arena is treated as a sanity run only.

## Evaluation

Both relative agents use the same M3.4.1 bounded-reader fallback.

1. 32 games per opponent smoke
2. 128 games per opponent development when smoke passes
3. 400 games per opponent promotion when development passes

Promotion still requires at least 52.5% against the frozen parent with Wilson 95% lower bound above 50%, at least 55% against CURRENT VERY_HARD, and no meaningful capture-loss regression.

This branch does not modify the shipped HARD/VERY_HARD implementation, UI, or browser inference path.
