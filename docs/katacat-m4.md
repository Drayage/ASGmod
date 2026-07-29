# KataCat M4 — strength gate

M4 is the first stage that measures playing strength. M0–M3 remain prerequisite pipeline gates; passing them does not promote a model.

## Frozen suites

The workflow runs the existing deterministic capture/defence PUCT tests, the strict M0 replay/territory coverage suite, and a mirrored full-game arena.

Each arena opening is deterministic. The candidate plays the same opening once as A and once as B. Separate matchups are run against the previous neural champion and CURRENT VERY_HARD.

## Smoke versus promotion

Default workflow inputs are a smoke test only: 8 games per opponent, 32 PUCT simulations, and a 50 ms CURRENT budget. Smoke mode checks completion, legal play, mirrored pairing, inference, and report generation. It never promotes a model.

Promotion mode is enabled explicitly with `strict_promotion=true`. The frozen minimums are:

- at least 400 mirrored games per opponent;
- candidate win rate at least 52.5% against the previous champion;
- candidate win rate at least 55% against CURRENT VERY_HARD;
- capture-loss rate and territory-finished margin are reported for regression review.

A candidate that misses a threshold remains an artifact and does not replace HARD or VERY_HARD.

## Outputs

`katacat-m4-output/arena-summary.json` contains individual game records, side-balanced matchup summaries, smoke acceptance, and the strict promotion decision.
