# KataCat M3.7 — fresh league data and limited representation retraining

## Why this stage exists

M3.4.2 through M3.6.2 repeatedly reused the same small tactical source while changing progressively narrower parts of the M3.4.1 network. Value-only, policy-only, full trunk plus policy, residual policy adapters, and targeted adapter repair all retained epoch zero. M3.6.1 showed a small positive arena signal for one rejected adapter epoch, but M3.6.2 could not preserve that signal while satisfying untouched tactical and general-policy guards.

M3.7 therefore changes the data source before changing the model again.

## Fresh league source

The workflow generates 256 new mirrored games from a new opening seed.

- one side uses the frozen M3.4.1 checkpoint with the reader-checked M3.4.1 fallback
- the other side uses CURRENT VERY_HARD
- the M3.4.1 side is alternated between A and B for every opening pair
- openings use deterministic safe prefixes of several lengths
- only naturally terminal games are accepted
- every game is replayed and checked against its final hash, winner, reason, and ownership

Every trusted executed decision becomes a supervised sample.

- CURRENT decisions are direct teacher labels
- M3.4.1 decisions are included only when the fallback did not report an unverified selection
- policy targets are the executed action, not a rejected adapter or an unverified fallback
- final value, score, and ownership labels come from the actual terminal game
- train and validation splits are assigned once per game ID
- position hashes are globally deduplicated
- each game is capped while retaining early, middle, and late positions

The new league set is separate from the M3.6 hard-negative validation set.

## Trainable scope

M3.7 starts from the selected M3.4.1 checkpoint.

Frozen:

- input stem
- first six residual trunk blocks

Trainable:

- final two residual trunk blocks
- policy head
- value head
- score head
- ownership head

This is wider than policy-only training but avoids the full-trunk drift observed in M3.5.

## Training mixture

Three sources are sampled independently.

1. fresh M3.7 league data, weight 3
2. frozen M3.3 replay and curriculum data, weight 1
3. independent M3.6 hard-negative training rows, weight 4

The frozen M3.3 replay rows also apply parent-output distillation for policy, value, score, and ownership. This limits forgetting while allowing the last two trunk blocks to learn representations supported by the new games.

## Selection

The exact M3.4.1 checkpoint is epoch zero. A trained epoch is eligible only when all of the following hold.

- the stem and first six trunk blocks remain byte-stable
- fresh league validation loss improves by at least 0.002
- frozen replay policy, value, score, and ownership metrics stay within explicit tolerances
- independent tactical validation has zero new parent-relative regressions
- all required metrics are finite

If no epoch is eligible, the output checkpoint is the original M3.4.1 file byte-for-byte.

## Arena gates

The selected checkpoint is evaluated with the existing M3.4.1 reader-checked fallback.

- smoke: 32 games per comparison
- development: 128 games per comparison
- promotion: 400 games per comparison

Promotion still requires a 52.5% point estimate against M3.4.1, Wilson lower bound above 50%, 55% against CURRENT, and capture-loss non-regression.

## Non-goals

M3.7 does not change the shipped HARD or VERY_HARD agent, UI, browser inference, or fallback implementation. The branch and pull request remain diagnostic until every required gate passes and merge is explicitly approved.
