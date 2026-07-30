# KataCat M3.2 — final root verification and fair shell arena

The first M3.1 smoke improved CURRENT results from 0/8 to 1/8 and reduced capture-loss rate from 100% to 87.5%, but it also gave the candidate a root tactical shell that the previous champion did not receive. M3.2 closes both measurement gaps without changing the fixed neural-PUCT architecture.

## Final root verification

PUCT still performs the ordinary search and produces a visit distribution. Before playing the visit leader, M3.2 checks only the moves most likely to be selected:

1. rank positive-visit root actions by visits, mean value, prior, and action index;
2. give each candidate its own focused forced-capture budget;
3. reject a candidate only when the existing life-and-death reader proves the opponent can force a capture;
4. continue to the next visit-ranked candidate;
5. after the configured verification limit, prefer the next unverified visited move over a move already proven losing;
6. if every visited candidate was checked and refuted, retain the original result and report the fallback rather than fabricating certainty.

Immediate wins and proven forced captures bypass this final check. Internal PUCT nodes continue using the fast one-ply safety floor. Random rollout is not introduced.

Default smoke settings:

- verification depth: 7;
- 75 ms per candidate;
- at most 5 visit-ranked candidates.

## Fair previous-champion comparison

Both the candidate and the previous neural champion receive identical:

- root forced-capture attack reader;
- root defence screening;
- final visit-ranked action verification;
- PUCT simulations and neural-prior settings.

CURRENT VERY_HARD remains unchanged. The report separates candidate results as A and B and records decision time for candidate, champion, and CURRENT.

## Reported diagnostics

For each neural agent the arena records:

- forced-capture choices;
- root actions screened and refuted;
- final-verification checks and refutations;
- number of original PUCT leaders rejected;
- unverified fallbacks after the configured limit;
- all-checked-refuted fallbacks;
- total and mean decision time.

The smoke run only validates the guard and fair arena wiring. It does not promote a model. The frozen M4 requirements remain at least 400 mirrored games per opponent, 52.5% against the previous champion, and 55% against CURRENT VERY_HARD.
