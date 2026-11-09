"""Background browser control stays in an existing CDP tab, never host UI."""
from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import buddy
import worker_vnc


class BackgroundControlTests(unittest.TestCase):
    def setUp(self):
        self.app = buddy.Buddy(headless=True)
        self.app.settings.set("worker_vnc_enabled", False)

    def tearDown(self):
        self.app.settings.set("worker_vnc_enabled", False)

    def test_host_desktop_blocked_even_without_vm(self):
        invoked = []
        spec = buddy.ToolSpec(
            name="window_focus", description="must not run",
            parameters=buddy.schema_obj(),
            handler=lambda a, c: invoked.append(1),
            category="desktop", risk=buddy.Risk.INPUT)
        result = asyncio.run(self.app.executor.execute(
            spec, {}, buddy.ToolContext(self.app)))
        self.assertFalse(result.ok)
        self.assertEqual(result.category, "permission_denied")
        self.assertFalse(invoked)

    def test_terminal_command_cannot_work_around_background_browser(self):
        run = type("RunStub", (), {
            "goal": "Klicka tre alternativ i min Chrome-flik",
            "background": False,
        })()
        spec = buddy.ToolSpec(
            name="run_command", description="must not run",
            parameters=buddy.schema_obj(),
            handler=lambda a, c: (_ for _ in ()).throw(AssertionError("executed")),
            category="terminal", risk=buddy.Risk.EXEC)
        result = asyncio.run(self.app.executor.execute(
            spec, {"command": "echo wrong"}, buddy.ToolContext(self.app, run=run)))
        self.assertFalse(result.ok)
        self.assertEqual(result.category, "permission_denied")

    def test_browser_automation_gates_non_cdp_paths(self):
        spec = self.app.registry.get("browser_launch_debug")
        self.assertIsNotNone(spec)
        result = asyncio.run(self.app.executor.execute(
            spec, {"browser": "chrome"}, buddy.ToolContext(self.app)))
        self.assertFalse(result.ok)
        self.assertEqual(result.category, "permission_denied")

    def test_browser_controls_tool_is_registered(self):
        for name in ("background_tabs", "background_elements", "background_text",
                     "background_click", "background_type"):
            with self.subTest(tool=name):
                self.assertIsNotNone(self.app.registry.get(name))

    def test_click_tasks_have_tight_budget(self):
        run = buddy.AgentRun(self.app, "Klicka på de tre rätta alternativen")
        self.assertLessEqual(run.budget["max_steps"], 12)
        self.assertLessEqual(run.budget["max_seconds"], 120)

    def test_missing_extension_blocks_immediately_without_agent_calls(self):
        run = buddy.AgentRun(self.app, "Skriv till ChatGPT i en webbläsarflik")
        with patch.object(self.app.browser_bridge, "ready", return_value=(False, "not paired")):
            outcome = asyncio.run(run.execute())
        self.assertEqual(outcome.status, "blocked")
        self.assertEqual(outcome.steps, 0)
        self.assertIn("tillägget", outcome.summary.lower())

if __name__ == "__main__":
    unittest.main()
