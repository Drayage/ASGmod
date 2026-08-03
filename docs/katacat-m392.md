# KataCat M3.9.2 — full-candidate real-reader replay

M3.9.1 replayed only actions that the parent had already sent to the focused capture reader. That recorded proof set showed that `PHASE_PRIOR_ASC` could save 62 of 1,327 logical reader calls while reproducing all 304 recorded verified-safe parent choices. The result was necessarily optimistic because unchecked candidates had no proof result.

M3.9.2 closes that gap without changing shipped play.

## Replay contract

For each of the 386 M3.9 decisions, the diagnostic reconstructs the exact game state from `games.jsonl`, verifies the recorded state hash, rebuilds the complete PUCT root distribution, and executes the real capture reader over every candidate that the reordered phases reach.

The candidate order is deliberately conservative:

1. The raw PUCT action is always checked first.
2. The remaining primary top-five candidates are ordered by lower prior first.
3. A checked rescue candidate is retained as its own phase.
4. Remaining adaptive candidates are ordered by lower prior first, with the existing limit of eight checks.
5. If M3.4.1 exhaustive fallback is needed, every remaining root candidate is ordered by lower prior first with the existing limit of 82 checks.
6. Reader results remain cached by action, matching M3.4.1 behavior.

## Acceptance and candidate gate

Diagnostic validity is separate from strategy success. The workflow succeeds when it reconstructs every position, verifies the exact M3.4.1 checkpoint trace, checks the raw PUCT action first, and runs the real reader on candidates that were previously unverified.

The strategy itself passes only if all of the following hold:

- every recorded verified-safe parent action remains reader-safe;
- the replay chooses exactly the same action on all 304 verified-safe parent decisions;
- no unverified fallback is introduced;
- total logical reader calls do not increase.

A different reader-safe move is still treated as a failure. This is intentional: M3.9.2 is testing a no-behavior-drift optimization, not searching for alternative acceptable play.

## Interpretation

A passing result permits only deterministic tactical fixture work. It does not permit Arena, checkpoint modification, neural training, merge, or promotion.

A failing result rejects `PHASE_PRIOR_ASC` as a safe ordering change and keeps M3.4.1 unchanged. Safe-over-refuted pairs already corrected by the existing reader are not sufficient evidence for a neural correction head.
