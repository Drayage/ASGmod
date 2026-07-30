# KataCat M3.4 — tactical hard-negative policy correction

M3.3.1 showed that the player-relative checkpoint still lost most often after PUCT's preferred move had already been proved losing. Increasing the final-guard scan budget again would make the browser agent slower without fixing the policy ordering. M3.4 therefore changes training, not the shipped game or tactical budgets.

## Source checkpoint

M3.4 starts from the exact successful M3.3 `PLAYER_RELATIVE_V1` checkpoint. The architecture and input planes remain unchanged, so this is compatible fine-tuning rather than a fresh model.

## Hard-negative collection

The collector plays deterministic mirrored candidate-versus-CURRENT games. On candidate turns it:

1. runs the existing neural PUCT and root tactical shell;
2. checks the highest visit-ranked actions with the focused forced-capture reader;
3. records only actions for which a forced loss is positively proved;
4. asks CURRENT VERY_HARD for a teacher action and independently checks that it is not refuted;
5. removes proved losing actions from the PUCT target and inserts the verified teacher action;
6. plays the real game through the unchanged final guard and keeps samples only when the game ends naturally.

`UNVERIFIED_VISITED`, `UNVERIFIED_ZERO_VISIT`, and `ALL_ROOT_ACTIONS_REFUTED` moves are never used as positive policy teachers.

## Training objective

M3.4 mixes the original balanced M3.3 replay set with a separately seat-balanced hard-negative set.

- normal soft policy loss remains active;
- masked PUCT targets assign zero probability to proved losing actions;
- an auxiliary pairwise loss pushes the verified positive action above every proved negative action;
- value, score, and ownership heads continue to train on the same naturally terminal labels;
- the learning rate is reduced for checkpoint-compatible fine-tuning.

Reported policy diagnostics include hard-negative top-1 accuracy, the rate at which a proved negative is still ranked first, and the positive-minus-worst-negative logit margin.

## Controlled arena

The M3.4 candidate is compared against:

- the frozen M3.3 player-relative checkpoint;
- CURRENT VERY_HARD.

Candidate and frozen M3.3 use identical PUCT, tactical shell, final verification, CURRENT rescue, and adaptive scan settings. The smoke arena reports overall and A/B-seat win rates, mirrored-pair results, capture losses, original-selection refutation rate, unverified fallback rate, and decision time.

No M3.4 result is a promotion unless the separate formal M4 gate reaches its required game count and thresholds.
