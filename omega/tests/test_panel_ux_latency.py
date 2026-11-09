"""Regression coverage for Windows pixel art and nonblocking input UI."""
from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from live_panel import LivePanel, pixel_companion


class BareCLI:
    def __init__(self, app):
        self.app = app


class PanelUXTests(unittest.TestCase):
    def panel(self):
        app = SimpleNamespace(current_run=None,
                              companion=SimpleNamespace(present=lambda: (False, "")),
                              level_snapshot=lambda: {"level": 30})
        return LivePanel(app, BareCLI)

    def test_five_stages_have_stable_width_and_no_broken_glyphs(self):
        expected = {1: 5, 12: 7, 30: 8, 60: 9, 85: 11}
        for level, height in expected.items():
            for mode in ("awake", "working", "observing", "sleeping"):
                rows = pixel_companion(mode, frame=1, level=level)
                self.assertEqual(len(rows), height)
                self.assertEqual({len(x) for x in rows}, {17})
                self.assertFalse(any(ch in "".join(rows) for ch in "▄▀◕ᴗ﹏ω♡♥✦✧"))
        self.assertNotEqual(pixel_companion("working", 0, 30),
                            pixel_companion("working", 1, 30))

    def test_sidebar_shows_workplan_before_skill_map(self):
        p = self.panel()
        content = "".join(fragment[1] for fragment in p._side_text())
        self.assertLess(content.index("MIN ARBETSPLAN"), content.index("EVOLUTION · SKILL MAP"))
        self.assertIn("PROGRESS CORE", content)
        self.assertNotIn("▰", content)
        self.assertNotIn("▱", content)

    def test_enter_commits_queue_before_chat_repaint(self):
        p = self.panel()
        observed = []
        original_add = p._add
        def recorded_add(text):
            observed.append(p.queue.get_nowait())
            original_add(text)
        p._add = recorded_add
        field = SimpleNamespace(text="hej")
        self.assertTrue(p._submit(field))
        self.assertEqual(observed, ["hej"])
        self.assertEqual(field.text, "")
        self.assertIn("hej", p._chat.text)

    def test_streaming_redraw_does_not_dirty_sidebar(self):
        p = self.panel()
        p._side_text()
        self.assertFalse(p._side_dirty)
        p.ui._out("buddy › Hej")
        self.assertFalse(p._side_dirty)
        p.stream_begin()
        p._side_text()  # One legitimate status change on stream begin.
        p.stream_delta("Hej")
        self.assertFalse(p._side_dirty)

    def test_ui_input_has_no_10_second_delay_built_in(self):
        p = self.panel()
        self.assertEqual(p.application.refresh_interval, 1.0)
        field = SimpleNamespace(text="hej")
        p._submit(field)
        self.assertEqual(p.queue.get_nowait(), "hej")


if __name__ == "__main__":
    unittest.main()
