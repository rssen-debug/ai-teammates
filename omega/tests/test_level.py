#!/usr/bin/env python3
"""Tests for the measured level 1–100 system.

The most important tests here are the *anti-gaming* ones: the requirement is
explicit that a level must never rise because the model used more tokens, ran
longer or produced more text. Those assertions are the regression guard.
"""
from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import level as lv  # noqa: E402


def make_db(path: Path, *, runs=None, tasks=None, audit=None, memories=None, effects=0,
            settings=None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.executescript("""
    CREATE TABLE runs(id TEXT PRIMARY KEY, ts REAL, goal TEXT, status TEXT, verified INTEGER,
                      summary TEXT, steps INTEGER, tokens INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY, title TEXT, plan TEXT, state TEXT, run_at REAL, deps TEXT,
                       attempts INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 3, created REAL,
                       updated REAL, heartbeat REAL, owner_pid INTEGER, result TEXT, error TEXT,
                       error_class TEXT, budget TEXT, step_idx INTEGER DEFAULT 0);
    CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, actor TEXT, tool TEXT, risk TEXT,
                       decision TEXT, detail TEXT);
    CREATE TABLE effects(key TEXT PRIMARY KEY, task_id TEXT, tool TEXT, ts REAL, result TEXT);
    CREATE TABLE memories(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, title TEXT, content TEXT,
                          tags TEXT, status TEXT, source_run TEXT, created REAL, updated REAL,
                          uses INTEGER DEFAULT 0);
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
    """)
    now = time.time()
    for i, r in enumerate(runs or []):
        conn.execute("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?)",
                     (r.get("id", f"r{i}"), now - i, r.get("goal", "g"), r.get("status", "complete"),
                      int(r.get("verified", 1)), r.get("summary", ""), int(r.get("steps", 5)),
                      int(r.get("tokens", 1000))))
    for i, t in enumerate(tasks or []):
        conn.execute("INSERT INTO tasks (id,title,state,attempts,error,created,updated) VALUES (?,?,?,?,?,?,?)",
                     (t.get("id", f"t{i}"), t.get("title", "task"), t.get("state", "done"),
                      int(t.get("attempts", 1)), t.get("error", ""), now - i, now - i))
    for i, a in enumerate(audit or []):
        conn.execute("INSERT INTO audit (ts,actor,tool,risk,decision,detail) VALUES (?,?,?,?,?,?)",
                     (now - i, "agent", a.get("tool", "tool"), a.get("risk", "low"),
                      a.get("decision", "allow"), ""))
    for i in range(effects):
        conn.execute("INSERT INTO effects VALUES (?,?,?,?,?)", (f"k{i}", "t0", "tool", now, "{}"))
    for i, m in enumerate(memories or []):
        conn.execute("INSERT INTO memories (kind,title,content,status,created,updated,uses) VALUES (?,?,?,?,?,?,?)",
                     (m.get("kind", "long_term"), m.get("title", f"m{i}"), m.get("content", "c"),
                      m.get("status", "active"), now - i, now - i, int(m.get("uses", 0))))
    for k, v in (settings or {}).items():
        conn.execute("INSERT INTO settings VALUES (?,?)", (k, json.dumps(v) if not isinstance(v, str) else v))
    conn.commit()
    conn.close()


class TestFormula(unittest.TestCase):
    def test_nothing_measured_is_level_one_not_level_zero(self) -> None:
        res = lv.compute(evidence={})
        self.assertEqual(res.level, 1)
        self.assertEqual(res.tier, "seedling")
        self.assertTrue(all(not a.measured for a in res.axes))
        self.assertTrue(any("nothing has been measured" in w for w in res.warnings))

    def test_unmeasured_axes_are_excluded_not_zeroed(self) -> None:
        """An agent that was never benchmarked must not be scored as if it failed."""
        only_f = lv.compute(evidence={}, suite={"results": [{"status": "PASS"}] * 5})
        self.assertEqual(only_f.score, 1.0, "with only F measured and F perfect, the mean must be 1.0")
        self.assertTrue(any("redistributed" in w for w in only_f.warnings))

    def test_weights_sum_to_one(self) -> None:
        self.assertAlmostEqual(sum(lv.WEIGHTS.values()), 1.0, places=9)
        self.assertEqual(set(lv.WEIGHTS), {"A", "B", "C", "D", "E", "F"})

    def test_verified_success_ratio_drives_axis_a(self) -> None:
        ev = {"runs_decided": 10, "runs_verified": 7}
        res = lv.compute(evidence=ev)
        a = next(x for x in res.axes if x.key == "A")
        self.assertAlmostEqual(a.value, 0.7, places=6)

    def test_an_unverified_complete_claim_counts_against_the_score(self) -> None:
        """The core honesty property: saying 'done' is not doing it."""
        honest = lv.compute(evidence={"runs_decided": 10, "runs_verified": 10})
        lying = lv.compute(evidence={"runs_decided": 10, "runs_verified": 2, "runs_complete_unverified": 8})
        self.assertGreater(honest.score, lying.score)
        self.assertLess(next(a.value for a in lying.axes if a.key == "A"), 0.25)

    def test_recovery_axis_rewards_recovering_and_punishes_abandoning(self) -> None:
        good = lv.compute(evidence={"tasks_recovered": 8, "tasks_abandoned": 2})
        bad = lv.compute(evidence={"tasks_recovered": 2, "tasks_abandoned": 8})
        self.assertAlmostEqual(next(a.value for a in good.axes if a.key == "B"), 0.8)
        self.assertAlmostEqual(next(a.value for a in bad.axes if a.key == "B"), 0.2)
        self.assertGreater(good.score, bad.score)

    def test_a_failing_test_suite_zeroes_regression_resistance(self) -> None:
        failing = lv.compute(evidence={}, suite={"results": [{"status": "PASS"}, {"status": "FAIL"}]})
        passing = lv.compute(evidence={}, suite={"results": [{"status": "PASS"}] * 3})
        self.assertEqual(next(a.value for a in failing.axes if a.key == "F"), 0.0)
        self.assertEqual(next(a.value for a in passing.axes if a.key == "F"), 1.0)

    def test_all_blocked_suite_is_half_credit_never_full(self) -> None:
        blocked = lv.compute(evidence={}, suite={"results": [{"status": "BLOCKED"}] * 8})
        self.assertEqual(next(a.value for a in blocked.axes if a.key == "F"), 0.5)

    def test_level_is_concave_and_bounded(self) -> None:
        raw, cap, level = lv.to_level(1.0, lv.EVIDENCE_FULL)
        self.assertEqual(level, 100)
        self.assertAlmostEqual(raw, 100.0)
        _, _, zero = lv.to_level(0.0, lv.EVIDENCE_FULL)
        self.assertEqual(zero, 1)
        for score in (0.0, 0.25, 0.5, 0.75, 1.0):
            _, _, lvl = lv.to_level(score, lv.EVIDENCE_FULL)
            self.assertGreaterEqual(lvl, 1)
            self.assertLessEqual(lvl, 100)
        _, _, mid = lv.to_level(0.5, lv.EVIDENCE_FULL)
        _, _, high = lv.to_level(0.75, lv.EVIDENCE_FULL)
        self.assertLess(mid, high, "the mapping must be monotonic in score")


class TestEvidenceGate(unittest.TestCase):
    def test_a_few_good_runs_cannot_buy_a_high_level(self) -> None:
        res = lv.compute(evidence={"runs_decided": 3, "runs_verified": 3})
        self.assertEqual(res.score, 1.0)
        self.assertLessEqual(res.level, 5, "3 runs must not produce a high level")
        self.assertLess(res.cap, res.raw_level, "the cap should be the binding constraint")

    def test_more_evidence_unlocks_more_level_at_the_same_quality(self) -> None:
        small = lv.compute(evidence={"runs_decided": 5, "runs_verified": 5})
        large = lv.compute(evidence={"runs_decided": 250, "runs_verified": 250})
        self.assertEqual(small.score, large.score)
        self.assertLess(small.level, large.level)
        self.assertEqual(large.level, 100)


class TestAntiGaming(unittest.TestCase):
    """NON-NEGOTIABLE: tokens, runtime and text volume are not level inputs."""

    def test_more_tokens_do_not_raise_level(self) -> None:
        # A real database carries token counts; make them absurd and re-measure.
        tmp = Path(tempfile.mkdtemp(prefix="omega-level-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(tmp, ignore_errors=True))
        db_a, db_b = tmp / "a.db", tmp / "b.db"
        make_db(db_a, runs=[{"verified": 1, "tokens": 1_000, "steps": 5} for _ in range(20)]
                + [{"verified": 0, "status": "failed", "tokens": 1_000, "steps": 5} for _ in range(10)])
        make_db(db_b, runs=[{"verified": 1, "tokens": 50_000_000, "steps": 999_999} for _ in range(20)]
                + [{"verified": 0, "status": "failed", "tokens": 50_000_000, "steps": 999_999} for _ in range(10)])
        a = lv.compute(db_path=db_a)
        b = lv.compute(db_path=db_b)
        self.assertEqual(a.level, b.level, "burning 50 000× more tokens must not change the level")
        self.assertEqual(a.score, b.score)

    def test_longer_runtime_does_not_raise_level(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="omega-level-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(tmp, ignore_errors=True))
        db_a, db_b = tmp / "a.db", tmp / "b.db"
        make_db(db_a, runs=[{"verified": 1} for _ in range(10)])
        make_db(db_b, runs=[{"verified": 1} for _ in range(10)])
        # Age every row in b by a year: elapsed time must be irrelevant.
        conn = sqlite3.connect(str(db_b))
        conn.execute("UPDATE runs SET ts = ts - 31536000")
        conn.commit()
        conn.close()
        self.assertEqual(lv.compute(db_path=db_a).level, lv.compute(db_path=db_b).level)

    def test_more_output_text_does_not_raise_level(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="omega-level-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(tmp, ignore_errors=True))
        db_a, db_b = tmp / "a.db", tmp / "b.db"
        make_db(db_a, runs=[{"verified": 1, "summary": "done"} for _ in range(10)])
        make_db(db_b, runs=[{"verified": 1, "summary": "x" * 100_000} for _ in range(10)])
        self.assertEqual(lv.compute(db_path=db_a).level, lv.compute(db_path=db_b).level)

    def test_level_inputs_contain_no_volume_metrics(self) -> None:
        """Structural guard: the evidence keys the formula reads are enumerated."""
        allowed = {"runs_decided", "runs_verified", "runs_total", "runs_complete_unverified",
                   "tasks_total", "tasks_recovered", "tasks_abandoned", "tasks_done",
                   "audit_rows", "tool_calls", "distinct_tools_used", "effects_recorded",
                   "memories_total", "memories_used", "memories_verified", "memory_searches",
                   "tools_available", "level_tools_available", "stat_tool_searches",
                   "stat_tool_search_hits", "stat_tool_calls", "stat_tool_errors",
                   "db", "db_exists", "error"}
        res = lv.compute(evidence={"runs_decided": 4, "runs_verified": 3})
        used = {a.key for a in res.axes}
        self.assertEqual(used, set(lv.WEIGHTS))
        import inspect
        src = inspect.getsource(lv.compute)
        for banned in ("tokens", "duration", "elapsed", "len(summary", "characters"):
            self.assertNotIn(banned, src, f"the scoring formula must not read '{banned}'")
        self.assertTrue(allowed.issuperset({"runs_decided", "runs_verified"}))


class TestRealDatabaseCollection(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="omega-level-db-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))

    def test_collects_real_numbers_from_the_omega_schema(self) -> None:
        db = self.tmp / "buddy.db"
        make_db(db,
                runs=[{"verified": 1, "status": "complete"}] * 6 + [{"verified": 0, "status": "failed"}] * 2
                     + [{"verified": 0, "status": "complete"}] * 2,
                tasks=[{"state": "done", "attempts": 3, "error": "boom"}] * 3
                      + [{"state": "failed", "attempts": 3, "error": "boom"}] * 1,
                audit=[{"tool": t, "decision": "allow"} for t in ("file_read", "file_write", "run_command", "file_read")],
                memories=[{"uses": 2}, {"uses": 0}, {"uses": 5}],
                effects=4,
                settings={"tools_available": 20, "stat_tool_search_hits": 8, "memory_searches": 10})
        ev = lv.collect_from_db(db)
        self.assertEqual(ev["runs_total"], 10)
        self.assertEqual(ev["runs_verified"], 6)
        self.assertEqual(ev["runs_decided"], 10)
        self.assertEqual(ev["runs_complete_unverified"], 2)
        self.assertEqual(ev["tasks_recovered"], 3)
        self.assertEqual(ev["tasks_abandoned"], 1)
        self.assertEqual(ev["distinct_tools_used"], 3)
        self.assertEqual(ev["tool_calls"], 4)
        self.assertEqual(ev["memories_total"], 3)
        self.assertEqual(ev["memories_used"], 2)
        res = lv.compute(db_path=db, home=self.tmp)
        a = next(x for x in res.axes if x.key == "A")
        self.assertAlmostEqual(a.value, 0.6)
        b = next(x for x in res.axes if x.key == "B")
        self.assertAlmostEqual(b.value, 0.75)
        c = next(x for x in res.axes if x.key == "C")
        self.assertAlmostEqual(c.value, 3 / 20)
        self.assertGreater(res.level, 1)

    def test_missing_database_is_not_an_error(self) -> None:
        res = lv.compute(db_path=self.tmp / "nope.db", home=self.tmp)
        self.assertEqual(res.level, 1)
        self.assertTrue(all(not a.measured for a in res.axes))

    def test_corrupt_database_is_reported_not_crashed(self) -> None:
        bad = self.tmp / "buddy.db"
        bad.write_text("not a database", encoding="utf-8")
        ev = lv.collect_from_db(bad)
        self.assertIn("error", ev)
        res = lv.compute(evidence=ev)
        self.assertEqual(res.level, 1)

    def test_benchmark_report_moves_axis_e(self) -> None:
        (self.tmp / "last_benchmark_report.json").write_text(json.dumps(
            {"passed": 4, "run": 5, "tasks": []}), encoding="utf-8")
        res = lv.compute(evidence={"runs_decided": 10, "runs_verified": 10}, home=self.tmp)
        e = next(x for x in res.axes if x.key == "E")
        self.assertTrue(e.measured)
        self.assertAlmostEqual(e.value, 0.8)

    def test_selftest_report_moves_axis_f(self) -> None:
        (self.tmp / "last_selftest_report.json").write_text(json.dumps(
            {"when": "now", "platform": "linux",
             "results": [{"id": "T1", "status": "PASS"}, {"id": "T2", "status": "PASS"},
                         {"id": "J1", "status": "BLOCKED"}, {"id": "A", "status": "NOT TESTED"}]}),
            encoding="utf-8")
        res = lv.compute(evidence={"runs_decided": 10, "runs_verified": 10}, home=self.tmp)
        f = next(x for x in res.axes if x.key == "F")
        self.assertEqual(f.value, 1.0)
        self.assertEqual(f.denominator, 4)


class TestPersistence(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="omega-level-hist-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.db = self.tmp / "buddy.db"

    def test_history_records_every_measurement(self) -> None:
        make_db(self.db, runs=[{"verified": 1}] * 5)
        for _ in range(3):
            lv.record(self.db, lv.compute(db_path=self.db, home=self.tmp))
        hist = lv.history(self.db)
        self.assertEqual(len(hist), 3)
        self.assertTrue(all(h["level"] >= 1 for h in hist))
        self.assertTrue(all(h["tier"] for h in hist))

    def test_cached_level_setting_is_valid_json_with_the_breakdown(self) -> None:
        make_db(self.db, runs=[{"verified": 1}] * 5)
        lv.record(self.db, lv.compute(db_path=self.db, home=self.tmp))
        conn = sqlite3.connect(str(self.db))
        raw = conn.execute("SELECT value FROM settings WHERE key='level'").fetchone()[0]
        conn.close()
        doc = json.loads(raw)
        self.assertIn("level", doc)
        self.assertIn("axes", doc)
        self.assertEqual(doc["formula_version"], lv.LEVEL_VERSION)
        self.assertEqual(len(doc["axes"]), 6)

    def test_history_of_a_missing_database_is_empty_not_an_exception(self) -> None:
        self.assertEqual(lv.history(self.tmp / "nope.db"), [])


class TestTiers(unittest.TestCase):
    def test_tiers_are_monotonic_and_cover_the_range(self) -> None:
        seen = [lv.tier_for(n) for n in (1, 9, 10, 24, 25, 49, 50, 74, 75, 100)]
        self.assertEqual(seen, ["seedling", "seedling", "growing", "growing", "capable", "capable",
                                "strong", "strong", "elite", "elite"])

    def test_render_shows_the_cap_honestly(self) -> None:
        res = lv.compute(evidence={"runs_decided": 2, "runs_verified": 2})
        out = res.render()
        self.assertIn("LEVEL", out)
        self.assertIn("capped", out, "a capped level must say so instead of implying full capability")


if __name__ == "__main__":
    unittest.main(verbosity=2)
