# KataCat M3.4.3 — balanced contrast, value head only

M3.4.2 reduced frozen pre-collapse validation loss but regressed in the 32-game smoke arena: 43.75% against M3.4.1 and 34.375% against CURRENT VERY_HARD. Its loss-only curriculum made the model more pessimistic without teaching a safer route. M3.4.3 isolates that diagnosis.

## Fixed scope

- Parent checkpoint: frozen M3.4.1 `PLAYER_RELATIVE_V1` checkpoint.
- Trainable parameters: `value_head.*` only.
- Frozen byte-for-byte: stem, residual trunk, policy head, score head, ownership head.
- Search, PUCT, tactical reader, rescue, and M3.4.1 fallback are unchanged.
- Shipped HARD/VERY_HARD, UI, and browser inference remain unchanged.

## Balanced terminal contrast

The successful M3.4.1 128-game development replay is the only arena source.

For each real candidate loss that reaches `ALL_ROOT_ACTIONS_REFUTED`, the miner reconstructs candidate-to-move states 2/4/6 plies before the first collapse. Each loss state is matched with a naturally won candidate game from the same comparison, candidate seat, and split, using the nearest candidate ply. Rows are then deduplicated by SHA-256 position hash and balanced exactly by split, seat, and WIN/LOSS label.

No replay action is declared a policy negative. Natural terminal winner labels provide the value target.

## Bounded-reader successor pairs

Near each collapse, the frozen M3.4.1 PUCT result is checked with the same tactical reader and fallback. A pair is retained only when:

1. the original PUCT action is actually refuted by the configured reader; and
2. the replacement action is not refuted within the configured bounded reader budget.

Both successor states are encoded from the opponent-to-move perspective. The value head is trained so the refuted successor has a higher opponent value than the bounded-reader-not-refuted successor.

`NOT_REFUTED` is not a mathematical proof of safety. The artifact and summary preserve that caveat.

## Parent-safe checkpoint selection

The parent is epoch 0. A fine-tuned epoch is selectable only when all of the following hold:

- general replay value loss is no worse than the parent;
- balanced terminal value loss strictly improves;
- WIN and LOSS sign accuracy do not materially regress;
- frozen reader-pair ranking introduces zero parent-correct-to-candidate-wrong regressions;
- reader-pair mean margin improves;
- every non-value parameter hash remains identical.

If no epoch qualifies, the exact parent checkpoint bytes are copied.

## Evaluation

Both relative agents use identical M3.4.1 reader-checked fallback settings.

- smoke: 32 games against M3.4.1 and 32 against CURRENT;
- development: 128 per opponent only after smoke passes;
- promotion: 400 per opponent only after development passes.

Smoke requires at least 50% against the parent, 45% against CURRENT, and no material increase in `ALL_ROOT_ACTIONS_REFUTED` decision rate. Development requires the parent head-to-head Wilson 95% lower bound above 50%, CURRENT at least 55%, and capture-loss non-regression. Promotion retains the fixed M4 400-game thresholds.

Artifacts are retained for 14 days. No PR is merged before the staged evaluation is complete.
