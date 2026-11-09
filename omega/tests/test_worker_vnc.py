"""Offline tests for opt-in VM VNC isolation policy."""
from __future__ import annotations
import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import buddy
import worker_vnc


class FakeConfig:
    def __init__(self, values=None):
        self.values = dict(values or {})
    def get(self, name, default=None):
        return self.values.get(name, default)
    def set(self, name, value):
        self.values[name] = value


class WorkerIsolationTests(unittest.TestCase):
    def test_rejects_public_vnc_and_untrusted_addresses(self):
        for target in ["8.8.8.8::5900", "example.org::5900", "0.0.0.0::5900",
                       "http://127.0.0.1:5900", "127.0.0.1::70000"]:
            with self.subTest(target=target):
                with self.assertRaises(ValueError):
                    worker_vnc.validate_target(target)
        self.assertEqual(worker_vnc.validate_target("127.0.0.1::5901"),
                         "127.0.0.1::5901")

    def test_vm_worker_disabled_by_default(self):
        app = SimpleNamespace(settings=FakeConfig(), vault=None)
        worker = worker_vnc.Worker(app)
        self.assertFalse(worker.enabled)
        self.assertFalse(worker.ready()[0])

    def test_host_desktop_tools_are_blocked_when_worker_enabled(self):
        app = buddy.Buddy(headless=True)
        app.settings.set("worker_vnc_enabled", True)
        try:
            spec = buddy.ToolSpec(
                name="ui_fake", description="Fake host desktop action",
                parameters=buddy.schema_obj(), handler=lambda *_: "SHOULD NOT RUN",
                category="desktop", risk=buddy.Risk.OBSERVE)
            ctx = buddy.ToolContext(app)
            result = asyncio.run(app.executor.execute(spec, {}, ctx))
            self.assertFalse(result.ok)
            self.assertEqual(result.category, "permission_denied")
            self.assertIn("HOST PROTECTED", result.error)
        finally:
            app.settings.set("worker_vnc_enabled", False)


if __name__ == "__main__":
    unittest.main()
