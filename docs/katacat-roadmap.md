# KataCat roadmap

KataCat is the long-term Alley Boss Cats AI project. The architecture is fixed before model tuning so a failed smoke run changes an implementation detail, not the whole direction.

## Non-negotiable architecture

1. The existing TypeScript rules engine is the only authority for legality, capture, territory, and final scoring.
2. Training games end through recorded legal actions with the normal `CAPTURE` or `TERRITORY` rule. No post-hoc winner or forced-label shortcut is allowed.
3. The learned model will have policy, win value, score, and ownership heads sharing one trunk.
4. Search will be neural PUCT without random rollouts.
5. Immediate capture and immediate-loss prevention remain hard tactical guards around PUCT.
6. Data is split by whole game, never by individual position.
7. Four-, eight-, or twelve-game runs are smoke tests only. Strength promotion uses fixed suites and hundreds of games.
8. HARD and VERY_HARD remain unchanged until a candidate passes the promotion gate.

## M0 — trustworthy game data

Deliverables:

- naturally terminal game generator;
- complete move replay records;
- rules-engine replay validator;
- exact final winner, score, and 81-cell ownership labels;
- deterministic train/validation split by game;
- balanced extraction across phase, result type, current territory density, and current lead;
- four source curricula in a fixed 40/25/20/15 cycle:
  - CURRENT self-play;
  - noisy CURRENT;
  - safe random midgame prefix followed by CURRENT;
  - territory-oriented curriculum followed by a counting policy.

M0 passes only when every saved game replays exactly, all labels match the replayed final state, no game crosses the train/validation boundary, every terminal result is produced by actual actions, and the report covers both result types plus all phase and territory-density groups.

The M0 policy label is intentionally a one-visit bootstrap target. It is replaced by PUCT visit distributions in M2.

## M1 — multi-head network

One residual network learns together:

- policy over 81 cells plus pass;
- current-player win probability;
- adjusted final territory margin;
- final A/B/neutral ownership for all 81 cells.

Training uses board symmetries and game-level held-out validation. Model quality is compared with frozen trivial and CURRENT-derived baselines, but a weak first model does not change the architecture.

## M2 — neural PUCT

PUCT uses policy priors for expansion and the value/score heads at leaves. Random rollout MCTS is not reintroduced. Search produces visit-count policy targets for later training.

## M3 — iterative self-play

Training data mixes latest-model self-play, past checkpoints, CURRENT, and fixed regression positions. A gatekeeper promotes only models that beat the previous champion without losing tactical-suite accuracy.

## M4 — strength gate

A promotion candidate must pass all of the following:

- fixed capture and defence suite;
- fixed territory-position suite;
- at least 400 mirrored full games;
- at least 52.5% against the previous champion;
- at least 55% against CURRENT VERY_HARD;
- no meaningful regression in capture-loss rate;
- improved territory margin in territory-finished games.

## M5 — web integration

The promoted PyTorch model is exported to ONNX. Node inference is used for generation and validation; browser inference is used only after latency and memory tests pass. The shipped CURRENT engine remains the fallback.
