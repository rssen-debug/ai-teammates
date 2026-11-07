"""Tests for the benchmark harness that produces capability axis E.

The benchmarks themselves assert things about the product; these tests assert
things about the *measurement*, because a broken measurement is worse than no
measurement — it would quietly feed a wrong number into the level.

What is guarded here:

  * the report carries the exact keys `omega/level.py` reads;
  * `passed` really is the sum of per-task scores and `run` really is the count of
    tasks that executed — so partial credit cannot silently become all-or-nothing;
  * skipped tasks are excluded from the denominator, never counted as failures;
  * two runs on the same host produce the same scores (reproducibility is a
    stated requirement for level evidence);
  * the task table is well-formed: unique ids, real names, real callables.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
OMEGA = HERE.parent
BENCH = OMEGA / "benchmarks"
RUNNER = BENCH / "runner.py"

#: Fast, deterministic, no child processes, no Node, no network, no model.
FAST = ["B02", "B09", "B10", "B11", "B14"]


def _import_tasks():
    if str(BENCH) not in sys.path:
        sys.path.insert(0, str(BENCH))
    import tasks
    return tasks


def _run(ids: list[str], report: Path) -> dict:
    """Run the real runner in a real subprocess, exactly as `buddy bench` does."""
    proc = subprocess.run([sys.executable, str(RUNNER), *ids, "--report", str(report)],
                          capture_output=True, text=True, timeout=900, cwd=str(OMEGA))
    if not report.is_file():
        raise AssertionError(f"the runner wrote no report (rc={proc.returncode}):\n{proc.stdout[-800:]}\n{proc.stderr[-800:]}")
    doc = json.loads(report.read_text(encoding="utf-8"))
    doc["_rc"] = proc.returncode
    doc["_stdout"] = proc.stdout
    return doc


class TestTaskTableIsWellFormed(unittest.TestCase):
    def setUp(self) -> None:
        self.tasks = _import_tasks()

    def test_ids_are_unique_and_shaped_right(self) -> None:
        ids = [b[0] for b in self.tasks.BENCHMARKS]
        self.assertEqual(len(ids), len(set(ids)), f"duplicate benchmark ids: {ids}")
        for bid in ids:
            self.assertRegex(bid, r"^B\d\d$", f"benchmark id {bid!r} is not shaped Bnn")

    def test_every_entry_has_a_name_and_a_callable(self) -> None:
        for bid, name, fn in self.tasks.BENCHMARKS:
            self.assertTrue(name.strip(), f"{bid} has no human-readable name")
            self.assertTrue(callable(fn), f"{bid} is not callable")
            self.assertTrue(fn.__name__.startswith(f"b{bid[1:]}_"),
                            f"{bid} is implemented by {fn.__name__}, expected b{bid[1:]}_*")

    def test_there_are_enough_benchmarks_to_be_meaningful(self) -> None:
        self.assertGreaterEqual(len(self.tasks.BENCHMARKS), 10,
                                "axis E needs a real spread of capabilities, not three token checks")

    def test_routing_intents_reference_real_tools(self) -> None:
        """An intent pointing at a tool that does not exist would be unfixable noise."""
        if str(OMEGA) not in sys.path:
            sys.path.insert(0, str(OMEGA))
        import os
        os.environ.setdefault("BUDDY_HOME", tempfile.mkdtemp(prefix="buddy-benchtest-"))
        import buddy
        app = buddy.Buddy(headless=True)
        try:
            names = set(app.registry.tools)
            wanted = {w for _q, want in self.tasks.INTENTS
                      for w in (want if isinstance(want, tuple) else (want,))}
            bogus = sorted(wanted - names)
        finally:
            import asyncio
            asyncio.run(app.close())
        self.assertEqual(bogus, [], f"benchmark expects tools that are not registered: {bogus}")

    def test_anti_gaming_inputs_are_not_benchmark_inputs(self) -> None:
        """No score may be computed from tokens, wall-clock time or output volume.

        Checked precisely: only the expressions that actually produce a score are
        inspected. B11 mentions all of them on purpose — it exists to prove they
        do NOT move the level — and prose and SQL schemas are not scoring code.
        """
        src = (BENCH / "tasks.py").read_text(encoding="utf-8")
        scoring_lines = [ln for ln in src.splitlines()
                         if ("scored(" in ln or "BenchOutcome(" in ln or "score=" in ln
                             or "score =" in ln)]
        self.assertTrue(scoring_lines, "found no scoring expressions at all")
        for banned in ("token", "output_chars", "words_written", "lines_of_code", "seconds"):
            hits = [ln.strip() for ln in scoring_lines if banned in ln]
            self.assertEqual(hits, [], f"{banned!r} feeds a benchmark score: {hits[:2]}")


class TestReportFeedsTheLevel(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = Path(tempfile.mkdtemp(prefix="buddy-bench-report-"))
        cls.doc = _run(FAST, cls.tmp / "report.json")

    def test_runner_exited_clean(self) -> None:
        self.assertEqual(self.doc["_rc"], 0,
                         f"a benchmark failed:\n{self.doc['_stdout'][-1500:]}")

    def test_top_level_keys_level_reads(self) -> None:
        for key in ("passed", "run"):
            self.assertIn(key, self.doc, f"level.py reads doc[{key!r}] and it is missing")
        self.assertIsInstance(self.doc["passed"], (int, float))
        self.assertIsInstance(self.doc["run"], int)

    def test_passed_is_the_sum_of_scores(self) -> None:
        executed = [t for t in self.doc["tasks"] if t["status"] != "skip"]
        expected = round(sum(float(t["score"] or 0.0) for t in executed), 4)
        self.assertAlmostEqual(float(self.doc["passed"]), expected, places=3,
                               msg="`passed` must be the sum of per-task scores (partial credit)")

    def test_run_counts_only_executed_tasks(self) -> None:
        executed = [t for t in self.doc["tasks"] if t["status"] != "skip"]
        self.assertEqual(self.doc["run"], len(executed),
                         "skipped tasks must not enter the denominator")
        self.assertEqual(self.doc["metric"]["skipped"],
                         len([t for t in self.doc["tasks"] if t["status"] == "skip"]))

    def test_axis_e_is_in_range(self) -> None:
        if self.doc["run"]:
            axis = float(self.doc["passed"]) / float(self.doc["run"])
            self.assertGreaterEqual(axis, 0.0)
            self.assertLessEqual(axis, 1.0, "axis E must never exceed 1.0")

    def test_report_is_self_describing(self) -> None:
        for key in ("schema", "benchmark_version", "when", "host", "metric", "tasks"):
            self.assertIn(key, self.doc, f"the report is not reproducible without {key!r}")
        self.assertIn("definition", self.doc["metric"],
                      "the metric must state how it is computed, or nobody can check it")

    def test_every_task_recorded_evidence(self) -> None:
        for t in self.doc["tasks"]:
            self.assertIn("detail", t)
            self.assertTrue(str(t["detail"]).strip(), f"{t['id']} produced no detail")


class TestReproducibility(unittest.TestCase):
    """Level evidence must be reproducible, so two runs must agree."""

    def test_two_runs_produce_the_same_scores(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="buddy-bench-repeat-"))
        first = _run(FAST, tmp / "a.json")
        second = _run(FAST, tmp / "b.json")
        a = {t["id"]: t["score"] for t in first["tasks"]}
        b = {t["id"]: t["score"] for t in second["tasks"]}
        self.assertEqual(a, b, f"benchmark scores are not reproducible:\n  run1={a}\n  run2={b}")
        self.assertEqual(first["passed"], second["passed"])
        self.assertEqual(first["run"], second["run"])


class TestRunnerCli(unittest.TestCase):
    def test_list_does_not_run_anything(self) -> None:
        proc = subprocess.run([sys.executable, str(RUNNER), "--list"],
                              capture_output=True, text=True, timeout=120, cwd=str(OMEGA))
        self.assertEqual(proc.returncode, 0)
        self.assertIn("CAPABILITY BENCHMARKS", proc.stdout)
        self.assertNotIn("axis E input", proc.stdout, "--list must not execute the suite")

    def test_json_output_is_machine_readable(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="buddy-bench-json-"))
        proc = subprocess.run([sys.executable, str(RUNNER), "B10", "--json",
                               "--report", str(tmp / "r.json")],
                              capture_output=True, text=True, timeout=600, cwd=str(OMEGA))
        self.assertEqual(proc.returncode, 0, proc.stderr[-500:])
        doc = json.loads(proc.stdout)
        self.assertEqual([t["id"] for t in doc["tasks"]], ["B10"])

    def test_unknown_id_runs_nothing_and_says_so(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="buddy-bench-none-"))
        proc = subprocess.run([sys.executable, str(RUNNER), "B99", "--report", str(tmp / "r.json")],
                              capture_output=True, text=True, timeout=300, cwd=str(OMEGA))
        doc = json.loads((tmp / "r.json").read_text(encoding="utf-8"))
        self.assertEqual(doc["tasks"], [], "an unknown id must not silently run the whole suite")
        self.assertEqual(doc["run"], 0)
        self.assertEqual(doc["passed"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
