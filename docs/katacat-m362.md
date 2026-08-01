# KataCat M3.6.2 — targeted repair of the promising residual adapter

## Why this stage exists

M3.6.1 found a small but useful signal in M3.6 epoch 8:

- 12–4 against the M3.4.1 parent in a 16-game diagnostic
- 8–8 against CURRENT VERY_HARD
- 43.75% capture-loss rate against CURRENT

Epoch 8 was still not selectable because the residual adapter repeatedly damaged three frozen tactical positions. In those positions it suppressed the bounded-reader teacher action and/or raised a proved-refuted action to the top policy rank.

M3.6.2 does not promote epoch 8 directly. It starts from that adapter and performs a narrowly constrained repair.

## Targeted fixtures

The three repeated regression positions from the M3.6.1 diagnostic are used as explicit training constraints:

- the teacher action may not fall more than 0.05 logit below the frozen parent
- proved-refuted actions may not rise more than 0.05 logit above the frozen parent
- no proved-refuted action may be top-1
- the teacher-vs-best-negative margin may not be worse than the parent by more than 0.01

These positions are training fixtures, not validation evidence. Every frozen tactical row from the same games is removed from the untouched tactical validation set.

## What remains frozen

- M3.4.1 stem and residual trunk
- original policy head
- value head
- score head
- ownership head

Only the bounded residual policy adapter is trainable.

## Selection

The raw epoch-8 seed is recorded but is never auto-selected. The fallback is always the zero-adapter M3.4.1 behavior.

A repaired epoch must satisfy all of the following:

1. frozen base state unchanged
2. general policy loss/top-1, KL, and residual magnitude within limits
3. zero regressions on untouched tactical validation
4. all three targeted fixtures pass
5. untouched tactical metrics improve over the parent

## Arena

A selected repair runs through the normal staged gate:

- smoke: 32 games against parent and 32 against CURRENT
- development: 128 games against each opponent
- promotion: 400 games against each opponent

Promotion still requires parent win rate at least 52.5% with Wilson lower bound above 50%, CURRENT win rate at least 55%, and no capture-loss regression.

## Scope

This stage does not change the shipped HARD/VERY_HARD agents, browser inference, UI, or model assets. It remains experimental until a later explicit integration stage.
