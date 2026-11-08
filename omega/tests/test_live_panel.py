"""Interactive side panel: timestamps, bounded messages and faithful traces."""
from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

OMEGA = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OMEGA))

from live_panel import LivePanel, remaining_seconds, clean_line, evidence_progress, pixel_companion, companion_stage, companion_personality


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
        a = pixel_companion("sleeping", level=12)
        b = pixel_companion("working", level=12)
        self.assertEqual(len(a), 7)
        self.assertNotEqual(a[2], b[2])

    def test_pet_evolves_only_from_measured_level(self):
        levels = (1, 9, 10, 24, 25, 49, 50, 74, 75, 100)
        stages = [companion_stage(level)[0] for level in levels]
        self.assertEqual(stages, [0, 0, 1, 1, 2, 2, 3, 3, 4, 4])
        self.assertEqual(companion_stage(None)[0], 0)
        self.assertEqual(len(pixel_companion("awake", level=1)), 5)
        self.assertEqual(len(pixel_companion("awake", level=100)), 11)

    def test_visual_blink_does_not_level_up(self):
        a = pixel_companion("observing", frame=0, level=12)
        b = pixel_companion("observing", frame=1, level=12)
        self.assertNotEqual(a, b)
        self.assertEqual(companion_stage(12), companion_stage(12))
        self.assertIn("kollar vad som gick fel", companion_personality("working", 12, False).lower())

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

    def test_sidebar_redraw_never_calls_blocking_companion_methods(self):
        p = self.build()
        class FailsIfPolled:
            def __getattr__(self, name):
                raise AssertionError("render unexpectedly accessed Companion: " + name)
        p.app.companion = FailsIfPolled()
        rendered = "".join(fragment[1] for fragment in p._side_text())
        self.assertIn("COMPANION: OFF", rendered)

    def test_companion_cache_update_keeps_render_pure(self):
        p = self.build()
        class FakeLoop:
            captures = 0
            last_capture_at = 0
            last_tick_at = 0
            last_capture_note = "capture not configured"
            ticks = 0
            def options(self):
                return {"enabled": True, "capture_seconds": 30, "tick_seconds": 30}
            def idle_seconds(self):
                return 12
        loop = FakeLoop()
        p.app.companion = SimpleNamespace(present=lambda: (True, ""), loop=loop)
        p._read_companion_state()
        self.assertEqual(p._cached_idle_seconds, 12)
        self.assertTrue(p._cached_companion_enabled)
        rendered = "".join(fragment[1] for fragment in p._side_text())
        self.assertIn("COMPANION: LIVE", rendered)

    def test_submit_is_visible_before_agent_runs(self):
        p = self.build()
        field = SimpleNamespace(text="hej, kan du hjälpa mig?")
        self.assertTrue(p._submit(field))
        self.assertEqual(field.text, "")
        self.assertIn("hej, kan du hjälpa mig?", p._chat.text)
        self.assertEqual(p.queue.get_nowait(), "hej, kan du hjälpa mig?")

    def test_thinking_label_click_uses_supported_prompt_toolkit_fragments(self):
        from prompt_toolkit.data_structures import Point
        from prompt_toolkit.mouse_events import MouseButton, MouseEvent, MouseEventType
        p = self.build()
        self.assertFalse(p.show_thinking)
        p._status_control.create_content(width=39, height=35)
        # The status text supplies an actual prompt_toolkit mouse handler.
        clickable = [frag for frag in p._side_text() if len(frag) == 3]
        self.assertEqual(len(clickable), 1)
        clickable[0][2](MouseEvent(position=Point(x=1, y=0),
                                   event_type=MouseEventType.MOUSE_UP,
                                   button=MouseButton.LEFT, modifiers=frozenset()))
        self.assertTrue(p.show_thinking)

    def test_live_stream_preview_can_be_toggled_and_cleared(self):
        p = self.build()
        p.toggle_thinking()
        self.assertTrue(p.show_thinking)
        p.stream_begin()
        p.stream_delta("He")
        p.stream_delta("j!")
        self.assertIn("Hej!", p._chat.text)
        p.stream_end()
        self.assertNotIn("Hej!", p._chat.text)
        p.ui._out("buddy › Hej!")
        self.assertEqual(p._chat.text.count("Hej!"), 1)
        p.toggle_thinking()
        self.assertFalse(p.show_thinking)

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
