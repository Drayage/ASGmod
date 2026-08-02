# KataCat M3.8 head ablation

M3.7.2 preserved the M3.4.1 policy exactly and improved offline value, score, and ownership metrics, but its selected epoch 2 lost 56-72 to the parent in the independent 128-game diagnostic. M3.8 isolates the search-relevant non-policy heads before any further training design.

## Fixed checkpoint variants

No optimization or interpolation occurs. Four checkpoints are built from the byte-identical M3.4.1 parent:

- epoch 1 value head only;
- epoch 1 score head only;
- epoch 2 value head only;
- epoch 2 score head only.

The stem, all residual trunk blocks, policy head, ownership head, and every non-selected head remain byte-identical to the parent. Each variant must differ in exactly the seven tensors belonging to its copied head.

Ownership is deliberately excluded because the current PUCT leaf value uses value plus a small score term; ownership logits do not select moves.

## Arena screen

Each variant runs the existing improved-mode arena with 32 games per comparison:

- candidate vs M3.4.1 parent;
- candidate vs CURRENT;
- parent vs CURRENT control.

All four matrix jobs use the same phase name, game count, and opening schedule. The summary requires the parent-vs-CURRENT control to be identical across jobs, making the head comparisons paired rather than four unrelated smoke samples.

## Interpretation

This is a multiple-comparison diagnostic, not a replacement smoke gate. A variant is only marked promising when it reaches at least 50% against both parent and CURRENT, stays within two percentage points of the paired parent-vs-CURRENT control, and does not materially regress capture losses.

A promising 32-game result may only advance to an independent 128-game diagnostic. It cannot be merged, promoted, or used to reinterpret the failed M3.7.2 smoke and diagnostic results.

Shipped HARD, VERY_HARD, model checkpoints, UI, browser inference, and fallback behavior are unchanged.
