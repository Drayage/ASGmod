# KataCat M3.9 — search-aligned decision trace

M3.7 through M3.8.1 showed that lower supervised validation loss does not reliably improve M3.4.1 PUCT play. M3.9 therefore starts with search diagnosis rather than another policy, value, score, or ownership update.

## Current decision path

The checked M3.4.1 code uses the network outputs as follows.

- **Policy**: orders the focused root tactical screen, supplies the mixed PUCT prior, contributes to the PUCT exploration term, and breaks root ties after visits and mean value.
- **Value**: evaluates every non-terminal leaf. The result is signed during backup, changes edge Q, changes later PUCT selection, and ultimately changes root visits and final root rank.
- **Score**: enters the same path through `clamp(value + 0.05 * score)`. A score-only change is smaller than a value change but can still redirect visits near close Q values.
- **Ownership**: inference returns it for analysis, but the current TypeScript PUCT does not use ownership in selection, expansion, leaf evaluation, backup, root ranking, tactical verification, rescue, adaptive selection, exhaustive fallback, or final execution.

This explains why a value-only checkpoint can preserve policy logits and tactical fixtures yet lose strength: value changes are repeatedly backed up through the tree and can redirect the finite 32-simulation search before the final reader sees the candidates. The final guard only checks candidates in the resulting visit/Q/prior order; it cannot recover every action within its bounded verification budget.

## Existing logging gap

The existing artifacts are not enough for a general search-aligned pairwise dataset.

- M3.4.1 Arena stores game replays and a compact final-guard report, not every root action's visits, Q, prior, raw child estimate, or proof status.
- M3.7 league data stores the executed action and fallback outcome, not the root distribution or why alternatives were rejected.
- M3.4.1 hard-negative data stores richer PUCT and reader evidence only for selected hard-negative and regression cases, not every decision.

## M3.9 first diagnostic

The new opt-in trace collector runs the unchanged M3.4.1 checkpoint against CURRENT on mirrored deterministic openings. For every M3.4.1 decision it records:

- full legal tactical root pool;
- raw policy logit and policy rank;
- PUCT inclusion, visit count, mixed prior, and mean Q when available;
- root tactical-shell removal when the identity is recoverable;
- final-guard and exhaustive-reader proof results;
- verified safe, refuted, or unverified status;
- parent PUCT choice and final executed choice;
- selection and elimination reasons;
- bounded raw child value and score samples for the selected action and high-priority alternatives;
- final game result for the executed action;
- same-root safe-over-refuted ranking pairs.

No checkpoint is trained, edited, interpolated, promoted, or loaded into shipped play.

## Deterministic correction contract

The first correction is deliberately conservative and offline only.

1. A parent action already proved safe is locked and cannot be displaced.
2. A proved-refuted action cannot be promoted over an unrefuted action.
3. Unverified actions are never labelled negative merely because they lost the parent ranking.
4. If every root action is proved losing, the parent choice is retained.

This audit determines whether deterministic reader evidence already captures the useful correction. A neural correction head is not justified until the trace shows enough repeated same-root pairs that cannot be handled safely by deterministic rules.

## Interpretation limits

- This is a data and search diagnostic, not smoke, development, promotion, or model selection.
- Thirty-two games are used only to collect and inspect trace density.
- A favorable trace result permits an offline replay design only.
- A future gameplay correction must still preserve every parent verified-safe choice and pass tactical fixtures before any Arena screen.
- The workflow is manual and does not run automatically.
- M3.4.1 remains the shipped model.
