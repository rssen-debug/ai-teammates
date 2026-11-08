"""Interactive side panel: timestamps, bounded messages and faithful traces."""
from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

OMEGA = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OMEGA))

from live_panel import LivePanel, remaining_seconds, clean_line, evidence_progress, pixel_companion


class FakeCLI:
    def __init__(self, app):
        self.app = app


class FakeCompanion:
    def present(self):
        return False, "not configured"


class PanelTest(unittest.TestCase):
    def build(self):
        app = SimpleNamespace(current_run=None, companion=FakeCompanion(),
                              level_snapshot=lambda: {"level": 10, "tier": "growing"})
        return LivePanel(app, FakeCLI)

    def test_next_level_uses_real_evidence_not_clock(self):
        a = evidence_progress({"level": 10, "measured_events": 23,
                               "raw_level": 40, "evidence_full": 250})
        self.assertTrue(a["measured"])
        self.assertEqual(a["target"], 11)
        self.assertGreaterEqual(a["required"], a["events"])
        self.assertNotIn("seconds", a)
        self.assertNotIn("eta", a)
        b = evidence_progress({"level": 10, "measured_events": 25,
                               "raw_level": 10.2, "evidence_full": 250})
        self.assertTrue(b["quality_limited"])

    def test_sprite_is_static_art_not_fake_tool_activity(self):
        a = pixel_companion("sleeping")
        b = pixel_companion("working")
        self.assertEqual(len(a), 7)
        self.assertNotEqual(a[2], b[2])

    def test_timers_never_guess(self):
        self.assertEqual(remaining_seconds(0, 30, 100), "--:--")
        self.assertEqual(remaining_seconds(100, 30, 105), "00:25")
        self.assertEqual(remaining_seconds(100, 30, 200), "00:00")

    def test_trace_has_real_tool_name_and_result(self):
        p = self.build()
        p.ui.status("Tolkar uppgiften")
        p.ui.step("UNDERSÖKER desktop_context")
        self.assertEqual(p.trace[-1][1], None)
        p.ui.step_done(True)
        self.assertEqual(p.trace[-1][1], True)
        self.assertIn("desktop_context", "".join(x[1] for x in p._side_text()))

    def test_chat_is_separate_from_tool_updates(self):
        p = self.build()
        p.ui._out("buddy › Hej!")
        p.ui.step("run_command")
        self.assertIn("Hej!", p._chat.text)
        self.assertNotIn("run_command", p._chat.text)
        self.assertEqual(len(p.trace), 1)

    def test_submit_is_visible_before_agent_runs(self):
        p = self.build()
        field = SimpleNamespace(text="hej, kan du hjälpa mig?")
        self.assertTrue(p._submit(field))
        self.assertEqual(field.text, "")
        self.assertIn("hej, kan du hjälpa mig?", p._chat.text)
        self.assertEqual(p.queue.get_nowait(), "hej, kan du hjälpa mig?")

    def test_colour_and_ansi_are_clean(self):
        p = self.build()
        p.ui._out("\x1b[36mbuddy › vit text\x1b[0m")
        self.assertNotIn("\x1b", p._chat.text)
        self.assertIn("vit text", p._chat.text)

    def test_bounded_chat_and_safe_compact_trace(self):
        p = self.build()
        for i in range(500):
            p.ui._out("Reply " + str(i))
        self.assertLessEqual(len(p.messages), 220)
        self.assertNotIn("\n", clean_line("line 1\nsecret", 30))
        self.assertIn("Reply 499", p._chat.text)


if __name__ == "__main__":
    unittest.main()
