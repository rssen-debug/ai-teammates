"""OMEGA Genesis: privacy-minimal, durable tool outcome telemetry.

Stores only categorical tool outcomes and timestamps, never prompts, content,
paths, credentials or screenshots. This is historical evidence about execution,
NOT model training, intelligence or independently verified task completion.
"""
from __future__ import annotations

import os
import sqlite3
import time
from pathlib import Path

CATEGORIES = ("FILER", "WEBB", "KOD", "WINDOWS", "ÖVRIGT")


def default_path() -> Path:
    root = os.environ.get("BUDDY_HOME")
    if not root:
        root = str(Path(os.environ.get("APPDATA", str(Path.home()))) / "StuddyBuddy")
    return Path(root) / "genesis-experience.sqlite3"


class ExperienceLedger:
    def __init__(self, path: Path | None = None):
        self.path = Path(path) if path is not None else default_path()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.execute("""CREATE TABLE IF NOT EXISTS outcomes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                category TEXT NOT NULL,
                ok INTEGER NOT NULL CHECK(ok IN (0,1))
            )""")
            conn.execute("CREATE INDEX IF NOT EXISTS ix_outcomes_ts ON outcomes(ts)")
            conn.commit()

    def _connect(self):
        conn = sqlite3.connect(str(self.path), timeout=5)
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    def record(self, category: str, ok: bool, now: int | None = None) -> None:
        """A completed tool call only. Caller supplies actual executor outcome."""
        if category not in CATEGORIES:
            category = "ÖVRIGT"
        timestamp = int(time.time() if now is None else now)
        with self._connect() as conn:
            conn.execute("INSERT INTO outcomes(ts,category,ok) VALUES (?,?,?)",
                         (timestamp, category, int(bool(ok))))
            conn.commit()

    def snapshot(self, now: int | None = None) -> dict:
        """Read real totals and week-over-week outcome rates.

        A positive trend means more successful tool calls, not learned IQ.
        """
        timestamp = int(time.time() if now is None else now)
        week = 7 * 86400
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT category,ok,COUNT(*) FROM outcomes GROUP BY category,ok"
            ).fetchall()
            weeks = conn.execute(
                "SELECT (ts>=?),ok,COUNT(*) FROM outcomes "
                "WHERE ts>=? AND ts<=? GROUP BY (ts>=?),ok",
                (timestamp-week, timestamp-2*week, timestamp, timestamp-week)
            ).fetchall()
        by_category = {name: [0, 0] for name in CATEGORIES}
        for category, ok, count in rows:
            if category in by_category:
                by_category[category][0 if ok else 1] += count
        current = [0, 0]
        previous = [0, 0]
        for is_current, ok, count in weeks:
            target = current if is_current else previous
            target[0 if ok else 1] += count
        def rate(pair):
            return pair[0] / sum(pair) if sum(pair) else None
        cur, prev = rate(current), rate(previous)
        weak = [(name, counts[1] / sum(counts))
                for name, counts in by_category.items() if sum(counts) >= 3]
        weakest = max(weak, key=lambda item: item[1])[0] if weak else None
        return {
            "categories": by_category,
            "total": sum(sum(counts) for counts in by_category.values()),
            "week": current, "previous_week": previous,
            "week_success": cur, "previous_success": prev,
            "trend_pp": None if cur is None or prev is None else round(100 * (cur-prev), 1),
            "needs_practice": weakest,
        }
