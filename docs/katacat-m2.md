# KataCat M2 — neural PUCT

M2 connects the shared M1 policy/value/score/ownership network to the existing TypeScript rules engine through deterministic PUCT. It does not change HARD or VERY_HARD and it is not a strength-promotion stage.

## Fixed search contract

- The TypeScript rules engine remains the only authority for legal moves, capture, pass, territory, and terminal results.
- Random rollouts are not used.
- Every non-terminal leaf is evaluated by the M1 network.
- Policy logits are masked to tactically safe legal actions and blended with a uniform floor.
- Value is the main leaf signal; normalised score contributes only a small auxiliary term.
- Ownership output is retained for diagnostics and later analysis.

## Tactical shell

The learned model cannot override proven tactics.

1. An immediate capture win is returned before neural inference.
2. `getSafeActions` removes moves that hand the opponent an immediate capture or pass-out win.
3. Internal nodes use the same tactical floor.
4. When every action loses, the rules engine's legal fallback is searched rather than inventing an action.

## M1 bridge

`ml/katacat_m1_infer.py` loads the M1 checkpoint once and serves newline-delimited JSON over a persistent stdin/stdout pipe. The PUCT integration test sends rules-engine states to that process and receives all four neural heads. This is an integration bridge for M2 validation; ONNX/browser deployment remains M5 work.

## M2 acceptance

The smoke gate requires:

- exact root visit accounting;
- zero visits to actions outside the tactical legal mask;
- immediate-win guard coverage;
- immediate-loss guard coverage;
- deterministic output for repeated identical searches;
- real M1 neural inference during search;
- no random rollout code path;
- persisted `katacat-m2-output/summary.json`.

These checks establish a correct search/inference loop. They do not claim that the 20-game bootstrap model is strong.

## Next stage

M3 uses PUCT root visit distributions as policy targets in iterative self-play. It mixes current and past checkpoints, CURRENT, and fixed regression states before any 400-game strength gate is attempted.
