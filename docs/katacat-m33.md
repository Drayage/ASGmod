# KataCat M3.3 — player-relative encoding and B-seat curriculum

M3.2.2 improved the smoke win rate against CURRENT VERY_HARD, but the result remained strongly seat-dependent. The candidate scored well as A and poorly as B. M3.3 changes the learned representation and training data while preserving the rules engine, PUCT, tactical shell, adaptive rescue, and browser AI.

## Player-relative input

The 16 input planes are interpreted from `state.currentPlayer`'s perspective:

1. self stones
2. opponent stones
3. neutral cells
4. empty cells
5. self confirmed territory
6. opponent confirmed territory
7. legal placements
8. mover is first player A
9. mover is second player B
10. last action
11. self cats remaining
12. opponent cats remaining
13. consecutive passes
14. ply
15. signed first-player margin
16. PASS legal

Ownership labels are likewise `neutral / self / opponent`. Value and score were already mover-relative.

Absolute A/B checkpoints are not input-compatible with these meanings, so M3.3 trains a fresh 96-channel, 8-block network rather than pretending an old first convolution is transferable.

## Exact seat balancing

M3.3 uses only positions recorded from legal, naturally completed games. Within train and validation separately, it deterministically downsamples whichever mover seat has more samples until A-turn and B-turn counts are exactly equal. Dedicated curriculum samples are kept ahead of ordinary samples when a training-seat reduction is needed.

A color-swap routine remains only as a feature-encoder unit test. It verifies that mover-relative board and ownership meanings are preserved and that A's fixed three-cell margin is recalculated rather than treated as a simple sign flip. Synthetic color-swapped positions are not added to training.

## Tactical curriculum

The expanded M3.1 mixed run supplies CURRENT teacher turns. The M3.3 curriculum builder:

- prioritises B-seat late-capture and early-survival positions;
- chooses an equal-sized A-seat control set;
- uses only train-split `CURRENT_TEACHER` actions;
- relabels them as `CURRENT_TACTICAL_TEACHER`;
- keeps all curriculum clones in training so an upweighted mixed-train state cannot leak into validation;
- never copies a PUCT unverified fallback or proven-losing action as a teacher target.

The curriculum deliberately upweights trusted teacher positions already present in the mixed training games. It does not fabricate terminal labels or force territory outcomes.

## Controlled arena

The M3.3 relative candidate is compared with the frozen absolute M3.1 candidate and CURRENT VERY_HARD.

Both neural agents receive identical:

- PUCT simulations and parameters;
- root forced-capture shell;
- final verification;
- CURRENT rescue provider;
- adaptive tail scan;
- deterministic mirrored openings.

The report separates A/B win rates and mirrored pair sweeps, splits, and swept pairs. The 16-game smoke validates wiring only. Promotion still requires the fixed M4 minimum of 400 mirrored games per opponent, at least 52.5% against the prior best, and at least 55% against CURRENT.

No actual HARD/VERY_HARD or web-game integration is changed in M3.3.
