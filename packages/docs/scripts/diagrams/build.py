"""Regenerate every diagram. Run from anywhere: `python3 scripts/diagrams/build.py`."""

from __future__ import annotations

import runpy
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def main() -> None:
    scripts = sorted(
        path
        for path in HERE.glob("*.py")
        if not path.name.startswith("_") and path.name != "build.py"
    )
    for script in scripts:
        print(script.stem)
        runpy.run_path(str(script), run_name="__main__")


if __name__ == "__main__":
    main()
