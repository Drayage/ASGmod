# KataCat M3.2.1 — zero-visit fallback fix

M3.2 showed that final-choice verification was useful, but its ranking helper removed every root edge with zero visits. When all visited candidates were proved losing, the guard could therefore run out of alternatives and select the original proved-losing move even though legal, unvisited root actions still existed.

## Fix

The final guard now ranks the complete root visit distribution.

1. Positive-visit edges remain first, ordered by visits, mean value, prior, and action index.
2. Zero-visit root edges remain in the same deterministic ordering after them.
3. The guard checks at most the configured number of top candidates.
4. A checked candidate is rejected only when the focused capture reader proves a forced loss.
5. When all checked candidates are refuted, the next unchecked root edge is selected.
6. A proved-losing edge is reused only when every root edge was checked and refuted. This is reported as `ALL_ROOT_ACTIONS_REFUTED`, not as an ordinary fallback.

## New report fields

- `selectedActionWasRefuted`
- `chosenVisits`
- `fallbackToZeroVisit`
- `allRootActionsRefuted`
- `provenLosingFallback`
- `uncheckedActionsRemaining`
- `outcome`

The arena also stores the candidate's final decision report before each loss so a capture loss can be separated into:

- verified-safe choice that later lost beyond the reader horizon;
- unverified visited fallback;
- zero-visit fallback;
- unavoidable position where all root actions were proved losing.

## Controlled comparison

M3.2.1 does not change training, model weights, PUCT parameters, or tactical-shell settings. The workflow deterministically rebuilds the same M3.1 candidate recipe and changes only final-choice fallback handling.

The smoke arena uses 16 mirrored games per opponent, with candidate and previous champion receiving the same tactical shell and final guard. This is still not a promotion run; the frozen M4 thresholds and 400-game minimum remain unchanged.
