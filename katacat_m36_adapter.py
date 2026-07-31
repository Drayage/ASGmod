"""Repository-root import shim used by GitHub Actions inline validation."""

from pathlib import Path
import sys

_ML_DIR = Path(__file__).resolve().parent / "ml"
if str(_ML_DIR) not in sys.path:
    sys.path.insert(0, str(_ML_DIR))

from ml.katacat_m36_adapter import *  # noqa: F401,F403,E402
