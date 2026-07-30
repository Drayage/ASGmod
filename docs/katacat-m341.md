# KataCat M3.4.1 — parent-safe hard-negative development gate

M3.4 improved some tactical ranking metrics but saved a checkpoint whose combined general validation loss was worse than the untouched M3.3 parent. M3.4.1 repairs checkpoint selection, expands the independent tactical source, separates fallback changes from model changes, and prevents a 400-game gate from starting without strong development evidence.

## Parent checkpoint as epoch 0

The exact frozen M3.3 `PLAYER_RELATIVE_V1` checkpoint is epoch 0. General validation is measured before any update. A fine-tuned epoch is selectable only when:

- its general validation loss strictly improves over epoch 0;
- it does not introduce a frozen tactical top-1 regression;
- it is the best eligible epoch under tactical ranking metrics.

When no epoch qualifies, the parent checkpoint bytes are copied unchanged. `summary.json` records:

- `parent_validation_loss`
- `best_validation_loss`
- `selected_epoch`
- `improved_over_parent`
- parent and selected checkpoint SHA-256 values
- the checked-out commit SHA

## Independent 64-game hard-negative source

The source is regenerated from 64 deterministic parent-versus-CURRENT games and does not reuse the M3.4 hard-negative rows. Each sample inherits a split assigned once from `gameId`. The collector reports and enforces:

- disjoint train and validation game IDs;
- SHA-256 position hashes;
- global position-hash deduplication;
- raw and cross-split duplicate audits;
- a per-game sample cap and per-game count distribution;
- both seats in train and frozen tactical validation;
- natural terminal labels only;
- no unverified fallback action as a policy teacher.

General replay validation and frozen tactical validation are evaluated separately. Tactical validation is not mixed into general checkpoint loss.

## Improved fallback experiment

The shipped fallback remains unchanged. The M3.4.1 experimental fallback activates only when the existing guard would choose an unchecked root. It continues the same focused reader across the remaining roots and selects a reader-checked, non-refuted action before any unchecked rank-14/15 action. If every root is checked and refuted, it reports `ALL_ROOT_ACTIONS_REFUTED`.

The hard-negative collector records real loss positions where the old guard selected an unchecked rank-14-or-later root and the improved guard found a checked alternative. Those positions become generated regression fixtures. Promotion requires zero regression failures.

## Four controlled configurations

Smoke and development phases separately report:

1. frozen M3.3 + existing fallback;
2. M3.4.1 checkpoint + existing fallback;
3. frozen M3.3 + improved fallback;
4. M3.4.1 checkpoint + improved fallback.

All four are measured against CURRENT on the same paired openings. Candidate-versus-parent head-to-heads are also run with matched fallback strategies. Reports include overall and seat-specific results, Wilson 95% intervals, mirrored-pair sweeps/splits, capture losses, fallback counts, fallback-last-decision losses, timing, commit SHA, checkpoint SHA-256, and full loss replays.

## Staged evaluation

- **Smoke:** 32 games per comparison. Development runs only if technical checks pass, the candidate+improved configuration is not below the parent+improved point estimate, and improved fallback does not increase the unchecked-fallback rate.
- **Development:** 128 games per comparison using the same paired-opening sequence. Promotion starts only if candidate+improved versus parent+improved has a Wilson 95% lower bound above 50%.
- **Promotion:** 400 games versus parent+improved and 400 versus CURRENT. Final promotion also requires zero tactical regression failures, selected general validation loss no worse than the parent, at least 52.5% versus the parent, at least 55% versus CURRENT, and no meaningful capture-loss regression.

No M3.4.1 code changes the shipped HARD/VERY_HARD agent, browser inference, or UI. The PR remains Draft until the staged workflow provides evidence.
