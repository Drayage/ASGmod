# KataCat M3.7.2

M3.7.1 solved the fresh-league policy-target drift, but every trained epoch still created one to three frozen tactical top-1 regressions. The repeated failures showed that even a single trainable trunk block or policy head was enough to reorder borderline tactical actions.

M3.7.2 removes that failure mode structurally.

## Frozen modules

The following modules are never passed to the optimizer and must remain byte-identical to the M3.4.1 parent:

- stem
- all residual trunk blocks
- policy head

The trainer also compares parent and candidate policy logits across fresh-league, stability, and frozen tactical validation rows. The maximum absolute delta must be exactly zero.

## Trainable modules

Only these heads receive gradients:

- value head
- score head
- ownership head

Training reuses the M3.7.1 pair-split, parent-preserving league rows. Territory-only train weighting is retained. Frozen M3.3 replay supplies supervised labels and parent-output distillation for the three trainable heads. Hard-negative rows are validation-only because policy cannot change.

## Selection

Epoch 0 is the byte-identical M3.4.1 parent. A trained epoch is eligible only when all conditions hold:

1. fresh-league total loss improves by at least 0.002 while policy logits remain identical;
2. stability value, score, and ownership metrics remain inside fixed bounds;
3. stem, trunk, and policy-head hashes are unchanged;
4. policy-logit maximum absolute delta is zero;
5. frozen tactical regression failures are zero.

If no epoch is eligible, the output checkpoint is the original M3.4.1 file.

## Arena

The staged arena remains unchanged:

- smoke: 32 games per comparison;
- development: 128 games per comparison;
- promotion: 400 games per comparison.

Because PUCT uses value and score at leaf evaluation, the arena tests whether non-policy head improvements translate into stronger play while the root policy and tactical ranking remain identical.

Shipped HARD, VERY_HARD, UI, browser inference, and fallback behavior are unchanged until an explicit promotion decision.
