#!/usr/bin/env python3
"""Compatibility shim — the Omega agent moved to the unified product root.

The real, single-file agent core now lives at `<repo>/omega/buddy.py`, which is
the file the `buddy` launcher executes. This shim exists so that every older
path, script, CI check and muscle-memory command that still points at
`studdy-buddy/omega/buddy.py` keeps working instead of breaking silently.

It performs no logic of its own: it execs the real entrypoint with the original
argv, in the original process, so exit codes, stdio and signals are unchanged.

    python studdy-buddy/omega/buddy.py --doctor   # still works, same behaviour
"""
from __future__ import annotations

import os
import runpy
import sys
from pathlib import Path

REAL = Path(__file__).resolve().parents[2] / "omega" / "buddy.py"

if not REAL.is_file():  # pragma: no cover - only if the tree was hand-edited
    sys.stderr.write(f"studdy-buddy shim: cannot find the moved agent core at {REAL}\n")
    raise SystemExit(2)

# Keep `__file__`-relative behaviour of the real module intact and let it see
# its own directory first on sys.path (it loads sibling modules from there).
sys.path.insert(0, str(REAL.parent))
os.environ.setdefault("BUDDY_ENTRY_SHIM", str(Path(__file__).resolve()))

if __name__ == "__main__":
    sys.argv[0] = str(REAL)
    runpy.run_path(str(REAL), run_name="__main__")
