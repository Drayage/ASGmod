# KataCat M3 — self-play and first candidate generation

M3 is the first complete training loop in the fixed KataCat roadmap:

```text
M1 bootstrap checkpoint
→ neural PUCT self-play
→ root visit distributions
→ candidate retraining
→ candidate PUCT inference check
```

M3 is still not a strength-promotion stage. HARD, VERY_HARD, and the browser game remain unchanged. Win-rate gates begin in M4.

## Self-play contract

Each self-play move is produced by the M2 rules-engine PUCT:

- the TypeScript rules engine owns legality, capture, pass, territory, and terminal results;
- immediate wins are taken before neural search;
- actions that allow an immediate loss are excluded by `getSafeActions`;
- no random rollout evaluation is used;
- the four-head checkpoint supplies policy, value, score, and ownership outputs;
- policy priors retain the M2 uniform floor.

Self-play adds exploration only at the root:

- deterministic seeded Dirichlet noise is mixed into the root policy;
- during the first 12 plies, actions are sampled in proportion to PUCT visits;
- after the temperature window, the visit leader is selected;
- evaluation and future M4 matches do not use this noise or temperature sampling.

Every non-tactical policy target is a root visit distribution rather than a single teacher move.

## Replay data

`npm run katacat:m3-selfplay` writes:

```text
katacat-m3-output/
├─ katacat-selfplay-games.jsonl
├─ katacat-selfplay-samples.jsonl
└─ selfplay-summary.json
```

Each game stores all selected actions, legal masks, pre-state hashes, PUCT visit targets, final winner, final reason, adjusted score margin, and final 81-cell ownership. A game is accepted only when replaying the recorded legal actions reproduces the exact final labels.

## First-generation retraining

The smoke candidate is initialized from the M1 checkpoint and trained on a combined set:

- M0 bootstrap positions retain tactical and territory curriculum coverage;
- M3 self-play positions introduce PUCT visit targets;
- train and validation splits remain game-disjoint.

The output is:

```text
katacat-m3-model/
├─ katacat-m3.pt
└─ summary.json
```

## M3 acceptance

The full loop passes only when all of the following are true:

- requested self-play games finish naturally;
- every game replays exactly;
- non-tactical visit totals equal the configured simulation budget;
- no unsafe or illegal action receives a visit;
- at least one policy target contains a repeatedly visited candidate;
- root noise and early temperature selection are exercised;
- train and validation games are disjoint;
- the candidate is initialized from M1 and saved;
- the candidate checkpoint completes another neural PUCT search;
- random rollouts remain unused.

Default CI smoke parameters are four self-play games, 64 simulations per non-tactical move, and four candidate-training epochs. These values test the loop, not model strength. The first meaningful local generation target remains 100 games, 128 simulations, and 20 training epochs before M4 evaluation design is exercised.
