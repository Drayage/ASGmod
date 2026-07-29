# KataCat M3.1 — tactical shell and mixed training

M4 smoke showed that the first M3 candidate lost all eight games against CURRENT VERY_HARD by capture. M3.1 keeps the neural-PUCT architecture and corrects the missing tactical and data-mix pieces before another strength gate.

## Root tactical shell

The neural search still owns whole-board move selection, but the root receives the same focused life-and-death reader already used by CURRENT VERY_HARD:

1. take an immediate legal win;
2. search for a proven forced capture;
3. screen the neural-prior-leading root candidates for an opponent forced capture;
4. run PUCT only over the surviving root pool.

The expensive forced-capture reader is root-only. Internal PUCT nodes retain the fast one-ply tactical floor. Unscreened moves are not rejected: a time-boxed reader may remove only moves it actually proves losing.

## Mixed generation

The M3.1 curriculum cycles through:

- latest-candidate PUCT self-play;
- latest candidate against the previous neural champion, with colours mirrored;
- latest candidate against CURRENT VERY_HARD, with colours mirrored.

PUCT turns store full visit-count targets. CURRENT turns store a one-visit teacher target. Every game must terminate naturally and replay exactly before its labels are accepted.

## Gate

M3.1 is still a corrective training stage, not promotion. The workflow finishes by running the M4 smoke arena again. The model remains separate from HARD and VERY_HARD regardless of the smoke score.
