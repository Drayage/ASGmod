# KataCat M3.7.1

M3.7 trained successfully on a fresh 256-game league but retained the M3.4.1 parent. Every trained epoch improved fresh-league total loss while violating policy stability and introducing one or more frozen tactical regressions.

The main mismatch was the policy target: the final executed action was represented as a one-hot label even though the parent raw policy selected that action as top-1 only about 1–2% of the time. M3.7.1 changes the target construction rather than weakening any safety gate.

## Data preparation

`ml/prepare_katacat_m371_data.py` consumes the successful M3.7 league, the M3.6 hard-negative source, and the unchanged M3.4.1 checkpoint.

- Both seats from one mirrored opening pair are assigned to the same train or validation split.
- The parent legal-action softmax remains the dominant policy target.
- The trusted executed action receives a bounded boost: 0.15 for M3.4.1 reader-checked actions, 0.08 for CURRENT actions.
- Hard-negative rows receive a 0.15 positive-action boost while every proven negative action is masked out of the soft target.
- Territory-terminal training rows are emitted six times in total; validation rows are never duplicated.
- Every emitted target must be normalized, legal, disjoint from its negative mask, and contain the positive action.

The successful M3.7 source currently produces 4,260 original league rows. With pair-level splitting and territory upweighting, the preparation prototype produced 5,860 effective training/validation rows, with 1,952 territory rows and 3,908 capture rows. These figures are rechecked by the workflow rather than hard-coded as acceptance conditions.

## Conservative retraining

The existing M3.7 selector and safety checks are retained.

- Parent: unchanged M3.4.1 checkpoint.
- Trainable scope: final trunk block plus all four heads.
- Learning rate: 2e-5.
- Policy distillation weight: 4.0.
- Fresh league / stability / hard-negative sampling weights: 2 / 1 / 5.
- Frozen tactical regression requirement: zero.
- No candidate means byte-identical M3.4.1 fallback.

## Evaluation

The workflow runs 32 games per smoke comparison. A passing smoke gate unlocks 128-game development evaluation, followed by 400-game promotion evaluation. The shipped HARD and VERY_HARD implementations, UI, browser inference, and fallback logic remain unchanged until a candidate clears every gate.