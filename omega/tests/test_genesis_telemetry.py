"""Durable Genesis outcome evidence: no fake learning, no stored user content."""
from __future__ import annotations

import tempfile
import sys
from contextlib import closing
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from genesis_telemetry import ExperienceLedger


class GenesisTelemetryTest(unittest.TestCase):
    def test_persists_real_outcomes_without_storing_labels_or_prompts(self):
        with tempfile.TemporaryDirectory() as folder:
            db = Path(folder) / "experience.sqlite3"
            first = ExperienceLedger(db)
            self.assertEqual(first.snapshot(now=20*86400)["total"], 0)
            first.record("FILER", True, now=18*86400)
            first.record("FILER", False, now=19*86400)
            first.record("WEBB", True, now=10*86400)
            again = ExperienceLedger(db)
            snapshot = again.snapshot(now=20*86400)
            self.assertEqual(snapshot["total"], 3)
            self.assertEqual(snapshot["categories"]["FILER"], [1, 1])
            self.assertEqual(snapshot["categories"]["WEBB"], [1, 0])
            self.assertEqual(snapshot["week"], [1, 1])
            self.assertEqual(snapshot["previous_week"], [1, 0])
            self.assertEqual(snapshot["trend_pp"], -50.0)
            self.assertIsNone(snapshot["needs_practice"])
            with closing(again._connect()) as conn:
                cols = [row[1] for row in conn.execute("PRAGMA table_info(outcomes)")]
            self.assertEqual(cols, ["id", "ts", "category", "ok"])

    def test_unknown_category_is_categorized_not_saved_raw(self):
        with tempfile.TemporaryDirectory() as folder:
            ledger = ExperienceLedger(Path(folder) / "test.db")
            ledger.record("secret sensitive filename", True, now=100)
            out = ledger.snapshot(now=101)
            self.assertEqual(out["categories"]["ÖVRIGT"], [1, 0])
            self.assertEqual(out["total"], 1)

    def test_does_not_invent_growth_or_weakness_without_samples(self):
        with tempfile.TemporaryDirectory() as folder:
            ledger = ExperienceLedger(Path(folder) / "test.db")
            a = ledger.snapshot(now=100)
            self.assertIsNone(a["trend_pp"])
            self.assertIsNone(a["needs_practice"])
            for i in range(3):
                ledger.record("KOD", False, now=101+i)
            b = ledger.snapshot(now=200)
            self.assertEqual(b["needs_practice"], "KOD")
            self.assertIsNone(b["trend_pp"])
            self.assertEqual(b["categories"]["KOD"], [0, 3])


if __name__ == "__main__":
    unittest.main()
