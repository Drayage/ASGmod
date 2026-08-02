# KataCat M3.7.2.1

M3.7.2 selected epoch 2 while keeping stem, the entire trunk, and the policy head byte-identical to M3.4.1. The 32-game smoke result was 17-15 against the parent and 14-18 against CURRENT, missing the predeclared CURRENT floor by one game.

This stage is diagnostic only. It does not modify the checkpoint, training code, smoke threshold, development gate, or promotion state.

## Fixed evidence

The workflow downloads a successful M3.7.2 prepared artifact and requires:

- a trained epoch selected over epoch 0;
- exact zero policy-logit delta;
- zero frozen tactical regressions;
- the original selected checkpoint and M3.4.1 parent files.

It then runs 128 games per standard improved-mode comparison with the same simulations, reader, fallback, and CURRENT time budget used by the staged arena.

## Interpretation

The diagnostic reports the candidate-parent result, candidate-CURRENT result, parent-CURRENT baseline, capture-loss delta, seat split, and whether the results would numerically satisfy the existing development metrics. Even a favorable result remains post-smoke diagnostic evidence and cannot authorize a merge or promotion. A fresh official pipeline is required before any promotion decision.
