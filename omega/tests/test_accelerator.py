"""Accelerator tests: grounded failures only, no fake levels or model calls."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from accelerator import enqueue, report, plan_from_failures, autopilot_cycle

class Store:
    def __init__(self, failures=None, runs=None, tasks=None):
        self.failures = failures or []
        self.runs = runs or []
        self.tasks = tasks or []
    def q(self, query, params=()):
        if "FROM runs WHERE verified=0" in query: return self.failures
        if "GROUP BY status,verified" in query: return self.runs
        if "FROM tasks" in query: return self.tasks
        raise AssertionError("unexpected query: " + query)

class AcceleratorTest(unittest.TestCase):
    def test_no_fabricated_practice_without_real_failures(self):
        calls = []
        app = SimpleNamespace(
            privacy=SimpleNamespace(private=False),
            gateway=SimpleNamespace(key=lambda:"test"),
            store=Store(), tasks=SimpleNamespace(paused=False,
                  create=lambda *args, **kw: calls.append(args)))
        with tempfile.TemporaryDirectory() as temp:
            result = enqueue(app, Path(temp))
        self.assertEqual(result["queued"], 0)
        self.assertFalse(calls)

    def test_only_distinct_real_failures_produce_bounded_practice(self):
        failed = [{"id":"1","goal":"Fix failed text parsing of local logs", "summary":"AssertionError", "status":"failed"},
                  {"id":"2","goal":"Fix failed text parsing of local logs", "summary":"AssertionError", "status":"blocked"},
                  {"id":"3","goal":"Investigate Windows audio input hang", "summary":"TimeoutError", "status":"failed"},
                  {"id":"4","goal":"Help debug terminal input stream", "summary":"OSError", "status":"failed"},
                  {"id":"5","goal":"Another old failed issue", "summary":"OSError", "status":"failed"}]
        recorded = []
        def create(*args, **kw):
            recorded.append((args, kw))
            return "t_"+str(len(recorded))
        app = SimpleNamespace(
            privacy=SimpleNamespace(private=False),
            gateway=SimpleNamespace(key=lambda:"test"),
            store=Store(failures=failed),
            tasks=SimpleNamespace(paused=False,create=create))
        with tempfile.TemporaryDirectory() as temp:
            outcome = enqueue(app, Path(temp), now_ts=1600000000)
            self.assertEqual(outcome["queued"], 3)
            self.assertEqual(len(recorded), 3)
            for args, kw in recorded:
                self.assertIn("ACCELERATOR PRACTICE", args[0])
                self.assertIn("LOCAL, MINIMAL", args[1]["goal"])
                self.assertEqual(kw["max_attempts"], 1)
                self.assertEqual(kw["budget"]["max_steps"], 12)
            self.assertTrue((Path(temp)/"accelerator").is_dir())

    def test_privacy_and_missing_key_are_hard_gates(self):
        app = SimpleNamespace(privacy=SimpleNamespace(private=True),
                gateway=SimpleNamespace(key=lambda:"valid"),
                tasks=SimpleNamespace(paused=False),store=Store())
        with tempfile.TemporaryDirectory() as temp:
            self.assertEqual(enqueue(app,Path(temp))["reason"],"private mode")
            app.privacy.private=False
            app.gateway.key=lambda:None
            self.assertIn("key", enqueue(app,Path(temp))["reason"])

    def test_report_counts_only_actual_verified_completions(self):
        store=Store(runs=[{"status":"complete","verified":1,"n":2},
                           {"status":"failed","verified":0,"n":3}],
                    tasks=[{"id":"a","state":"done","result":json.dumps({"verified":True,"status":"complete"}),"title":"ACCELERATOR PRACTICE A"},
                           {"id":"b","state":"done","result":json.dumps({"verified":False,"status":"partial"}),"title":"ACCELERATOR PRACTICE B"},
                           {"id":"c","state":"blocked","result":None,"title":"ACCELERATOR PRACTICE C"}])
        r=report(store)
        self.assertEqual(r["runs"],5)
        self.assertEqual(r["verified_runs"],2)
        self.assertEqual(r["practice_verified"],1)
        self.assertEqual(r["practice_failed"],1)
        self.assertEqual(r["verified_ratio"],0.4)

    def test_idle_autopilot_runs_once_per_day_without_manual_command(self):
        class AutoStore(Store):
            def __init__(self):
                super().__init__(failures=[{
                    "id": "real_failure_1",
                    "goal": "Fix a genuine parser failure with local tests",
                    "summary": "AssertionError", "status": "failed"}])
                self.practices = []
            def one(self, sql, params=()):
                if "title LIKE ?" in sql:
                    return {"id": "already"} if any(
                        p.startswith(params[0].removesuffix("%")) for p in self.practices) else None
                if "state IN ('queued','running')" in sql:
                    return None
                raise AssertionError(sql)
        store = AutoStore()
        task_calls = []
        def create(title, *args, **kwargs):
            store.practices.append(title)
            task_calls.append(title)
            return "t_" + str(len(task_calls))
        app = SimpleNamespace(settings=SimpleNamespace(get=lambda key, default=None: default),
            privacy=SimpleNamespace(private=False), shutting_down=False,
            current_run=None, gateway=SimpleNamespace(key=lambda: "test"),
            store=store, tasks=SimpleNamespace(paused=False, current={}, create=create))
        with tempfile.TemporaryDirectory() as root:
            a = autopilot_cycle(app, Path(root), now_ts=1700000000)
            b = autopilot_cycle(app, Path(root), now_ts=1700000000 + 120)
        self.assertEqual(a["queued"], 1)
        self.assertEqual(b["queued"], 0)
        self.assertEqual(len(task_calls), 1)

    def test_autopilot_yields_to_real_tasks_and_off_switch(self):
        called = []
        class AutoStore(Store):
            def one(self, sql, params=()):
                return {"id": "user_task"} if "state IN ('queued','running')" in sql else None
        app = SimpleNamespace(
            settings=SimpleNamespace(get=lambda key, default=None: default),
            privacy=SimpleNamespace(private=False), shutting_down=False,
            current_run=None, gateway=SimpleNamespace(key=lambda: "test"),
            store=AutoStore(failures=[{"id":"a","goal":"Real failure of local code execution",
                                      "summary":"test failed", "status":"failed"}]),
            tasks=SimpleNamespace(paused=False,current={},
                                  create=lambda *a, **kw: called.append(a)))
        with tempfile.TemporaryDirectory() as root:
            self.assertIn("priority", autopilot_cycle(app, Path(root))["reason"])
            app.settings.get = lambda key, default=None: False if key == "accelerator_auto" else default
            self.assertEqual(autopilot_cycle(app, Path(root))["reason"], "autopilot disabled")
        self.assertEqual(called, [])

    def test_no_level_inflation_api(self):
        import accelerator
        self.assertFalse(hasattr(accelerator,"set_level"))
        self.assertFalse(hasattr(accelerator,"award_xp"))
        self.assertEqual(plan_from_failures(Store()),[])

if __name__ == "__main__":
    unittest.main()
