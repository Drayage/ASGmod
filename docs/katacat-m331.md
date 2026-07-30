# KataCat M3.3.1 — Frozen Extended Arena

M3.3.1 measures the already-trained M3.3 player-relative candidate with a larger controlled arena. It does not regenerate data, retrain either network, alter PUCT, or change the shipped browser AI.

## Frozen inputs

The workflow downloads the artifact from the latest successful `KataCat M3.3` run, unless a specific source run ID is supplied.

- Candidate: `katacat-m33-model/katacat-m33.pt`
- Previous control: `katacat-m31-model/katacat-m3.pt`
- Candidate and previous control use identical PUCT, tactical shell, final guard, CURRENT rescue, adaptive scan, simulations, and deterministic mirrored openings.
- CURRENT VERY_HARD remains unchanged.

## Arena size

- 64 games against the previous control
- 64 games against CURRENT VERY_HARD
- 32 mirrored opening pairs per opponent
- Candidate plays both A and B for every pair

This is an extended diagnostic run. Formal M4 promotion still requires at least 400 mirrored games per opponent and all other roadmap gates.

## Reported evidence

`katacat-m331-output/summary.json` reports:

- overall win rate and Wilson 95% interval
- A-seat and B-seat win rates and intervals
- mirrored pair sweeps, splits, and swept pairs
- capture-loss rate
- losses following an unverified fallback
- losses where every root action was proved losing
- average decision time and final-guard outcomes
- point-estimate threshold result separately from formal promotion eligibility

The raw M3.3 arena report is preserved in `katacat-m331-raw/arena-summary.json`.
