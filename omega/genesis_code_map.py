"""Read-only source map for OMEGA itself.

Deterministic AST inspection of allowlisted first-party modules; no project
execution, no scanning of user files, no external embeddings or network.
"""
from __future__ import annotations

import ast
from pathlib import Path

OWN_MODULES = ("buddy.py", "live_panel.py", "level.py", "accelerator.py",
               "genesis_telemetry.py", "genesis_playbooks.py")
KEYWORDS = {
    "panel": ("live_panel.py",),
    "pixel": ("live_panel.py",),
    "level": ("level.py", "live_panel.py"),
    "nivå": ("level.py", "live_panel.py"),
    "minne": ("buddy.py", "genesis_telemetry.py"),
    "memory": ("buddy.py", "genesis_telemetry.py"),
    "autopilot": ("buddy.py", "accelerator.py"),
    "skill": ("buddy.py", "genesis_playbooks.py"),
    "checkpoint": ("buddy.py",),
    "krasch": ("buddy.py",),
    "voice": ("buddy.py",),
    "röst": ("buddy.py",),
}
SELF_TERMS = ("buddy", "omega", "studdy", "egen agent", "vår agent")


def source_map_for_goal(goal: str, root: Path | None = None) -> str | None:
    """Bounded, explainable file pointers for tasks about OMEGA source only."""
    query = str(goal or "").casefold()
    if not any(term in query for term in SELF_TERMS):
        return None
    picked = set()
    for word, paths in KEYWORDS.items():
        if word in query:
            picked.update(paths)
    if not picked:
        return None
    root = Path(root) if root else Path(__file__).resolve().parent
    rows = []
    for name in OWN_MODULES:
        if name not in picked:
            continue
        candidate = root / name
        try:
            tree = ast.parse(candidate.read_text(encoding="utf-8"), filename=name)
        except (OSError, SyntaxError, UnicodeError):
            continue
        names = [n.name for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
        rows.append(name + ": " + ", ".join(names[:8]))
    if not rows:
        return None
    return "Relevant OMEGA source index (AST only; confirm actual code before changes): " + " | ".join(rows)[:800]
