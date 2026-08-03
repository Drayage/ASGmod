# KataCat M3.9.1 — recorded proof-order replay

M3.9 run `30823684908` completed successfully with the exact shipped M3.4.1 checkpoint SHA-256 `9e799363d0ade028ab1059aadd1fd7666c574e5c725ef00b46b7a180f143b07b`.

The trace contains 386 M3.4.1 decisions from 32 mirrored games. The raw PUCT action was reader-refuted and replaced by a parent verified-safe action 60 times. The existing M3.4.1 final guard corrected all 60 cases; there were no unverified fallbacks and no safety-lock violations. This is evidence of search/ranking misalignment, but not evidence that shipped gameplay currently executes those refuted actions.

## Corrected pair evidence

`pairType` is an exclusive display label. Because raw-value evidence overwrites the earlier Q/rank label, overlapping predicates must be counted from the numeric fields rather than from `pairType` alone.

- same-root safe-over-refuted pairs: 527
- actionable pairs: 341
- refuted action ranked above the selected safe action: 262
- refuted action with higher backed-up Q: 164
- refuted action with higher sampled child raw value: 267
- raw PUCT selection itself refuted: 60
- both Q and sampled raw value higher for the refuted action: 139

The earlier M3.9 diagnostic summary displayed only 25 higher-Q pairs because it counted the exclusive Q label. The M3.9 summarizer has been corrected independently; M3.9.1 also recomputes predicates directly from the source fields.

## Replay contract

M3.9.1 is retrospective and offline only.

1. The raw PUCT action remains the first reader check.
2. If that action is proved safe, it is retained and cannot be displaced.
3. Only actions actually sent to the parent reader are reordered in this first replay.
4. Consecutive reader depth/budget phases remain in their original order.
5. Unverified actions are never treated as negative examples.
6. No model, checkpoint, gameplay path, Arena gate, or promotion state is changed.

On the recorded proof set, the strongest complete-coverage phase-preserving candidate is `PHASE_PRIOR_ASC`: after the raw PUCT check, lower-prior candidates are checked first within the same recorded reader phase. It reproduces all 304 recorded parent verified-safe choices and reduces the retrospective reader count from 1,327 to 1,265, saving 62 checks. All 62 savings occur among the 60 decisions where the parent corrected raw PUCT.

## Interpretation limit and next gate

The 62-check saving is an optimistic retrospective bound, not a gameplay result. The trace omits proof outcomes for actions the parent never checked. A full candidate phase could contain another action that the replay would move ahead of the parent safe choice.

A favorable M3.9.1 result therefore permits only a second offline replay that reconstructs every candidate in each reader phase and executes the real capture reader. That replay must retain the raw-PUCT safety lock and exactly reproduce every parent `VERIFIED_SAFE` action before any gameplay experiment is considered.

M3.4.1 remains shipped. No Arena, neural correction head, training, interpolation, or promotion is permitted at this stage.
