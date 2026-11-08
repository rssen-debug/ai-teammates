"""OMEGA Genesis V3: evidence-gated, non-executable workflow playbooks.

A playbook stores only tool identifiers and a category from independently
verified completed runs. No prompts, arguments, contents, paths or secrets.
It is advisory: the agent must independently observe/verify every future run.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
from contextlib import closing
from pathlib import Path

from genesis_telemetry import default_path

ALLOWED_CATEGORIES = ("FILER", "WEBB", "KOD", "WINDOWS", "ÖVRIGT")
CATEGORY_HINTS = {
    "FILER": ("file", "fil", "folder", "mapp", "document", "dokument"),
    "WEBB": ("web", "browser", "chrome", "site", "sida", "url"),
    "KOD": ("code", "kod", "python", "script", "test", "repo", "git"),
    "WINDOWS": ("windows", "desktop", "outlook", "fönster", "app", "program"),
}
TOOL_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_]{0,63}$")


def goal_category(goal: str) -> str:
    words = str(goal or "").casefold()
    for category, hints in CATEGORY_HINTS.items():
        if any(re.search(r"(?<!\w)" + re.escape(word) + r"(?!\w)", words) for word in hints):
            return category
    return "ÖVRIGT"


def verified_sequence(outcome, ledger: list[dict]) -> tuple[str, ...]:
    """Only completed runs with actual successful read-back evidence qualify."""
    if getattr(outcome, "status", None) != "complete" or getattr(outcome, "verified", False) is not True:
        return ()
    if not isinstance(ledger, list) or not ledger or any(not isinstance(x, dict) for x in ledger):
        return ()
    steps = sorted(ledger, key=lambda x: x.get("seq", 0))
    if any(not isinstance(x.get("seq"), int) or not TOOL_RE.fullmatch(str(x.get("tool", ""))) for x in steps):
        return ()
    if not all(x.get("ok") is True for x in steps):
        return ()
    if not any(x.get("observes") is True for x in steps):
        return ()
    effects = [x["seq"] for x in steps if x.get("effect") is True]
    checks = [x["seq"] for x in steps if x.get("observes") is True]
    if effects and max(checks) < max(effects):
        return ()
    names = tuple(x["tool"] for x in steps)
    if len(names) > 12:
        return ()
    return names


class PlaybookStore:
    def __init__(self, path: Path | None = None):
        self.path = Path(path) if path is not None else default_path().with_name("genesis-playbooks.sqlite3")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.path, timeout=5)) as con:
            con.execute("""CREATE TABLE IF NOT EXISTS playbooks (
                signature TEXT PRIMARY KEY,
                category TEXT NOT NULL,
                tools_json TEXT NOT NULL,
                verified_runs INTEGER NOT NULL DEFAULT 0,
                last_seen INTEGER NOT NULL
            )""")
            con.execute("CREATE INDEX IF NOT EXISTS playbooks_cat ON playbooks(category,verified_runs)")
            con.commit()

    def record(self, goal: str, outcome, ledger: list[dict]) -> bool:
        sequence = verified_sequence(outcome, ledger)
        if not sequence:
            return False
        category = goal_category(goal)
        signature = hashlib.sha256((category + ":" + "|".join(sequence)).encode()).hexdigest()
        with closing(sqlite3.connect(self.path, timeout=5)) as con:
            con.execute("""INSERT INTO playbooks(signature,category,tools_json,verified_runs,last_seen)
                VALUES (?,?,?,?,?)
                ON CONFLICT(signature) DO UPDATE SET
                verified_runs=verified_runs+1,last_seen=excluded.last_seen""",
                (signature, category, json.dumps(sequence), 1, int(time.time())))
            con.commit()
        return True

    def suggest(self, goal: str, min_verified: int = 2) -> str | None:
        category = goal_category(goal)
        if category == "ÖVRIGT":
            return None
        with closing(sqlite3.connect(self.path, timeout=5)) as con:
            row = con.execute("""SELECT tools_json,verified_runs FROM playbooks
                WHERE category=? AND verified_runs>=?
                ORDER BY verified_runs DESC,last_seen DESC LIMIT 1""",
                (category, max(2, min_verified))).fetchone()
        if not row:
            return None
        try:
            names = json.loads(row[0])
        except (TypeError, ValueError):
            return None
        if not isinstance(names, list) or not names or any(not isinstance(n, str) or not TOOL_RE.fullmatch(n) for n in names):
            return None
        return ("Previously verified tool pattern for " + category +
                " (" + str(row[1]) + " completed runs): " + " → ".join(names) +
                ". This is a suggestion, not authorization. Re-observe live state, "
                "check tool availability and permissions, verify each effect; do not blindly replay.")

    def forge_candidates(self, min_verified: int = 3, limit: int = 2) -> list[dict]:
        """Only repeated, verified patterns, never raw prompts or arguments."""
        with closing(sqlite3.connect(self.path, timeout=5)) as con:
            rows = con.execute("""SELECT signature,category,tools_json,verified_runs
                FROM playbooks WHERE verified_runs >= ?
                ORDER BY verified_runs DESC,last_seen DESC LIMIT ?""",
                (max(3, int(min_verified)), max(1, min(5, int(limit))))).fetchall()
        candidates = []
        for signature, category, encoded, count in rows:
            try:
                names = json.loads(encoded)
            except (TypeError, ValueError):
                continue
            if (category not in ALLOWED_CATEGORIES or not isinstance(names, list)
                    or not names or len(names) > 12
                    or any(not isinstance(n, str) or not TOOL_RE.fullmatch(n) for n in names)):
                continue
            candidates.append({"signature": signature, "category": category,
                               "tools": names, "verified_runs": count})
        return candidates

    def count(self) -> int:
        with closing(sqlite3.connect(self.path, timeout=5)) as con:
            return int(con.execute("SELECT COUNT(*) FROM playbooks WHERE verified_runs>=2").fetchone()[0])
