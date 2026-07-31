# M3.4.2 baseline-call compatibility fix

The first M3.4.2 training run completed all six epochs and selected eligible epoch 5, but failed while writing `summary.json` because `relative_baselines` was called with only the validation samples. The M3.3 helper requires both the training and validation sample lists.

`ml/run_train_katacat_m342.py` now executes the committed M3.4.2 trainer with the single corrected call:

```python
relative_baselines(train_samples, general_validation)
```

The wrapper asserts that exactly one legacy call exists before executing the corrected source. The GitHub Actions workflow compiles the wrapper and uses it for M3.4.2 training. No model, fallback, arena, or promotion thresholds were changed.
