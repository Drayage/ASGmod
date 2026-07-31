# KataCat M3.4.3.1 — deterministic diagnostics

M3.4.3 selected epoch 0, so its candidate checkpoint was byte-identical to the M3.4.1 parent. M3.4.3.1 separates deterministic core verification from live wall-clock tactical-reader behavior and preserves rejected value-head epochs for diagnostic comparison.

## Scope

- Preserve parent and every value-head-only epoch checkpoint.
- Select unique diagnostic roles: parent, best general validation, best balanced validation, best reader margin, and final epoch.
- Verify two evaluator processes loaded from the same checkpoint produce identical neural outputs, fixed-simulation PUCT actions, and visit distributions on fixed states.
- Run each unique checkpoint against the parent and CURRENT VERY_HARD with the existing M3.4.1 fallback.
- Treat 16-game arenas as diagnostics only, never promotion evidence.
- Keep actual HARD/VERY_HARD, UI, browser inference, and shipped gameplay unchanged.

## Result

The GitHub Actions diagnostic completed successfully.

- all static and regression Vitest suites passed
- deterministic core passed on 8 fixed positions
- neural maximum absolute delta: `0`
- action mismatches: `0`
- visit-distribution mismatches: `0`
- fallback regression: `7/7` passed
- strict selector retained epoch `0`
- no rejected epoch met the diagnostic signal gate
- recommendation: `STOP_VALUE_HEAD_ONLY_AND_RETURN_TO_POLICY_TRUNK_TRAINING`

The displayed GitHub job-summary table initially showed `null` for nested arena fields because the `jq` projection read `games`, `wins`, and related fields from the candidate object instead of `.vsParent` / `.vsCurrent`. The underlying diagnostic summary and recommendation used the real arena objects; only the compact display was wrong. The workflow display projection has been corrected.

## Interpretation

The evaluation core is reproducible when wall-clock tactical readers are excluded from the exact paired-state audit. The experiment therefore does not support continuing isolated value-head-only fine-tuning. Future model work should return to policy/trunk training with balanced tactical data and preserve the M3.4.1 reader-checked fallback as an independent search safeguard.

Do not merge this stacked diagnostic PR into the shipped game branch.