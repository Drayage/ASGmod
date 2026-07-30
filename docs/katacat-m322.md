# KataCat M3.2.2 — adaptive tactical rescue

M3.2.1 proved that keeping zero-visit root moves fixed the fallback invariant, but controlled losses still followed one repeated pattern: the first five visit-ranked choices were all refuted and the sixth unchecked move was played immediately. M3.2.2 changes only that emergency path.

## Decision order

1. Run the existing rules-authoritative neural PUCT.
2. Verify the first five visit-ranked root moves with the focused forced-capture reader.
3. Only when all five are refuted, ask CURRENT VERY_HARD for one rescue suggestion.
4. Accept the suggestion only when it belongs to the screened PUCT root and an independent forced-capture check does not refute it.
5. If the suggestion is absent, outside the root, or refuted, scan additional visit-ranked root moves under a separate total rescue budget.
6. Choose an unchecked move only after the rescue budget is exhausted. A proved losing move is reused only when every root action was explicitly refuted.

The rescue provider does not replace PUCT and is never called during normal decisions. Random rollouts remain absent.

## Controlled arena

Candidate and previous champion receive identical tactical-shell, final-guard, rescue-provider, and adaptive-tail settings. CURRENT VERY_HARD remains unchanged. The candidate checkpoint and all training inputs are rebuilt with the same deterministic M3.2.1 recipe.

Default smoke:

- 16 mirrored games per opponent
- 32 PUCT simulations
- primary verification: 5 candidates × 75 ms
- CURRENT rescue suggestion: 50 ms requested budget
- adaptive verification: up to 8 candidates × 50 ms
- rescue phase wall-clock limit: 450 ms

The report separates `VERIFIED_RESCUE`, `VERIFIED_ADAPTIVE`, unverified fallbacks, rescue-provider timing, adaptive checks/refutations, seat results, and loss contexts. Smoke completion is not model promotion.
