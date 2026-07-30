# KataCat M3.4.2 — pre-collapse value curriculum

M3.4.1 showed two separate results:

- the reader-checked fallback removed blind rank-14/15 choices and improved both models;
- the M3.4.1 checkpoint had a positive 128-game point estimate against its parent, but its Wilson 95% lower bound remained below 50% and it did not earn promotion.

M3.4.2 keeps the reader-checked fallback fixed and changes only the checkpoint.

## Real-loss pre-collapse source

The source is the frozen 128-game M3.4.1 development replay artifact. Only losses from these configurations are eligible:

- `CANDIDATE_IMPROVED_VS_CURRENT`
- `CANDIDATE_IMPROVED_VS_PARENT_IMPROVED`

For each loss, the miner locates the first candidate decision reported as `ALL_ROOT_ACTIONS_REFUTED`. It reconstructs candidate-to-move positions 2, 4, and 6 plies before that decision.

The terminal loss supplies value, score, and ownership labels. The replay action is **not** declared a proved losing action. No new policy negatives are created. Policy supervision is low-weight distillation from the frozen M3.4.1 PUCT distribution so the experiment primarily tests whether earlier value guidance can keep search out of the collapse basin.

## Validation separation

Three frozen validations remain separate:

1. general replay validation;
2. tactical hard-negative validation;
3. pre-collapse validation from game IDs excluded from training.

The M3.4.1 checkpoint is epoch 0. A fine-tuned epoch is selectable only when:

- general validation loss is no worse than the parent;
- tactical top-1 regression failures are zero;
- pre-collapse value-sign regression failures are zero;
- pre-collapse value loss strictly improves.

If no epoch qualifies, the exact parent checkpoint bytes are retained.

## Fallback terminology

The M3.4.1 implementation is unchanged. M3.4.2 reports its bounded reader result as `NOT_REFUTED_EXHAUSTIVE` rather than `VERIFIED_EXHAUSTIVE_FALLBACK`. The reader failing to find a forced capture within its depth and time budget is not a mathematical proof of safety.

## Evaluation

Both relative models use the same reader-checked fallback.

- smoke: 32 paired games per opponent;
- development: 128 paired games per opponent only after smoke passes;
- promotion: 400 paired games per opponent only after development passes.

Opponents:

- frozen M3.4.1 checkpoint;
- CURRENT VERY_HARD.

Development requires the parent head-to-head Wilson 95% lower bound to exceed 50%, CURRENT point estimate at least 55%, and no meaningful capture-loss regression. Formal promotion additionally requires at least 52.5% against the parent and 400 games per opponent.

The shipped HARD/VERY_HARD implementation, UI, and browser inference remain unchanged.
