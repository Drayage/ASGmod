# KataCat M3.5 — trunk + policy hard-negative retraining

M3.4.3.1 showed that the fixed-simulation neural/PUCT core is deterministic and that value-head-only fine-tuning did not produce a viable checkpoint. M3.5 returns to the policy path while retaining the M3.4.1 bounded-reader fallback unchanged.

## Training scope

Trainable:

- input stem
- residual trunk
- policy head

Frozen parameters:

- value head
- score head
- ownership head

Changing the trunk can still change the frozen heads' outputs. The frozen M3.4.1 checkpoint therefore acts as a teacher for value, score, and ownership output distillation on every training batch.

## Data and losses

The training set combines the real M3.3 replay mixture with the frozen M3.4.1 hard-negative set.

- Real replay policy cross-entropy preserves broad move quality.
- Hard-negative rows are oversampled.
- Pairwise loss ranks the reader-accepted action above the strongest proved-refuted action.
- Negative-mass loss pushes down the complete set of proved-refuted actions, not only the worst one.
- Auxiliary distillation constrains value/score/ownership drift caused by trunk updates.

No random rollouts are used.

## Parent-safe selection

M3.4.1 is epoch 0. A trained epoch is selectable only when:

- general policy loss and top-1 remain within tolerance,
- value accuracy, score MAE, and ownership IoU remain within tolerance,
- frozen tactical regression count is zero,
- at least one tactical metric improves.

If no epoch qualifies, the M3.4.1 checkpoint is copied byte-for-byte.

## Arena and gates

Both candidate and parent use exactly the M3.4.1 bounded-reader fallback.

- smoke: 32 games versus M3.4.1 and 32 versus CURRENT VERY_HARD
- development: 128 games per opponent
- promotion: 400 games per opponent

Promotion still requires at least 52.5% versus the parent, at least 55% versus CURRENT, a Wilson lower bound above 50% versus the parent, and no meaningful capture-loss regression.

This experiment does not change the shipped HARD/VERY_HARD agents, UI, or browser model integration. Do not merge before the workflow results are reviewed.
