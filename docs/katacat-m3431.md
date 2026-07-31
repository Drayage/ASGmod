# KataCat M3.4.3.1 — deterministic-core and rejected-epoch diagnosis

M3.4.3 selected epoch 0, so the candidate checkpoint was byte-identical to the M3.4.1 parent. The old smoke gate nevertheless compared live `ALL_ROOT_ACTIONS_REFUTED` rates from candidate and parent turns. Those turns occur on different state distributions, so that comparison is not a paired regression test and must not be treated as proof of nondeterminism.

M3.4.3.1 is a diagnostic stage, not a promotion stage.

## Changes

- Retains the strict M3.4.3 checkpoint selector.
- Saves parent and every trained value-head epoch with SHA-256 and validation metrics.
- Selects unique diagnostic checkpoints for best general loss, best balanced loss, best reader margin, and final epoch.
- Runs an exact deterministic-core audit on identical checkpoint bytes:
  - identical neural outputs on eight fixed positions;
  - identical actions and visit distributions under fixed-simulation neural PUCT;
  - tactical shell disabled because its capture reader is wall-clock bounded.
- Re-runs the existing seven real-loss fallback regressions separately.
- Runs 16-game-per-opponent diagnostic arenas for each unique checkpoint.
- Treats same-SHA head-to-head results as sanity information only.
- Does not use unmatched live collapse-rate differences as regression evidence.

## Interpretation

The diagnostic summary recommends continuing value-head-only work only when a rejected epoch has a positive point-estimate signal against both the parent and CURRENT. Sixteen-game results are exploratory and cannot promote a checkpoint. If no rejected epoch has such a signal, the output explicitly recommends stopping value-head-only tuning and returning to policy/trunk training.

The shipped HARD/VERY_HARD agents, UI, and browser inference remain unchanged.
