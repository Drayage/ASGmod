# KataCat M3.5.1 — policy-head-only hard-negative retraining

M3.5 improved some policy metrics but changing the shared trunk damaged score and ownership outputs. M3.5.1 isolates the remaining hypothesis: can the policy head alone learn to rank reader-rejected moves lower without changing the representation or auxiliary heads?

## Training scope

Trainable:

- policy head only

Frozen byte-for-byte:

- input stem
- residual trunk
- value head
- score head
- ownership head

The workflow records a SHA-256 digest of every non-policy parameter and verifies that value, score, and ownership outputs have exactly zero change on the frozen general validation set.

## Data and losses

The training set combines the real M3.3 replay mixture with the frozen M3.4.1 hard-negative set.

- Real replay policy cross-entropy preserves broad move quality.
- Hard-negative rows are sampled at four times the replay weight.
- Pairwise loss ranks the reader-accepted action above the strongest proved-refuted action.
- Negative-mass loss pushes down the complete set of proved-refuted actions.

No random rollouts and no invented policy negatives are used.

## Parent-safe selection

M3.4.1 is epoch 0. A trained epoch is selectable only when:

- general policy loss and top-1 remain within tolerance,
- frozen tactical regression count is zero,
- at least one frozen tactical metric improves,
- all non-policy parameter bytes remain unchanged,
- value, score, and ownership outputs remain exactly unchanged.

If no epoch qualifies, the M3.4.1 checkpoint is copied byte-for-byte.

## Arena and gates

Both candidate and parent use exactly the M3.4.1 bounded-reader fallback.

- smoke: 32 games versus M3.4.1 and 32 versus CURRENT VERY_HARD
- development: 128 games per opponent
- promotion: 400 games per opponent

If the selector retains epoch 0, the identical-checkpoint arena is treated only as a sanity run. Its point estimates and capture-loss rate are not reported as model regressions.

This experiment does not change the shipped HARD/VERY_HARD agents, UI, or browser model integration. Do not merge before the workflow results are reviewed.
