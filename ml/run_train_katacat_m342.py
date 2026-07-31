from __future__ import annotations

from pathlib import Path


SOURCE_PATH = Path(__file__).with_name("train_katacat_m342.py")
OLD_CALL = '"baselines": relative_baselines(general_validation),'
NEW_CALL = '"baselines": relative_baselines(train_samples, general_validation),'


def main() -> None:
    source = SOURCE_PATH.read_text(encoding="utf-8")
    occurrences = source.count(OLD_CALL)
    if occurrences != 1:
        raise RuntimeError(
            "Expected exactly one legacy M3.4.2 relative_baselines call, "
            f"found {occurrences}"
        )
    corrected = source.replace(OLD_CALL, NEW_CALL, 1)
    namespace = {
        "__name__": "__main__",
        "__file__": str(SOURCE_PATH),
        "__package__": None,
    }
    exec(compile(corrected, str(SOURCE_PATH), "exec"), namespace)


if __name__ == "__main__":
    main()
