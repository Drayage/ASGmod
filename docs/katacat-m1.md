# KataCat M1 — multi-head network

M1 consumes the replay-verified M0 samples and trains one shared residual trunk with four outputs:

- policy over 81 cells plus pass;
- win value from the current player's perspective;
- adjusted final territory margin from the current player's perspective;
- absolute A/B/neutral ownership for all 81 cells.

## Fixed model contract

- board size: 9×9;
- input channels: 16;
- default trunk: 96 channels, 8 residual blocks;
- policy size: 82;
- train/validation split inherited from whole M0 games;
- eight board symmetries used only for training augmentation;
- no random rollout MCTS;
- no HARD or VERY_HARD integration.

M0 policy labels contain one visit for the recorded bootstrap action. They are sufficient to validate the M1 data/model/loss pipeline, but they are not treated as final policy ground truth. M2 replaces them with PUCT visit distributions.

## M1 smoke acceptance

M1 passes its pipeline gate when:

- train and validation games remain disjoint;
- all four head losses and metrics are produced;
- every reported metric is finite;
- a checkpoint and summary are saved.

This is not a strength gate. Baselines are reported for diagnosis, but a 20-game smoke dataset is not used to approve gameplay integration or change the fixed architecture.

## Command

```bash
python ml/train_katacat_m1.py \
  --data=katacat-m0-output/katacat-samples.jsonl \
  --out=katacat-m1-output \
  --epochs=8 \
  --channels=96 \
  --blocks=8
```

The manual GitHub Actions workflow is `KataCat M1`.
