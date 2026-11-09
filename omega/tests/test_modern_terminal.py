"""Regression checks for single-pane Omega TUI layout."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from live_panel import LivePanel

class DummyCLI:
    def __init__(self, app):
        self.app = app

class ModernTerminalTests(unittest.TestCase):
    def panel(self):
        app = SimpleNamespace(
            current_run=None,
            gateway=SimpleNamespace(base="https://openrouter.ai/api/v1"),
            router=SimpleNamespace(resolve=lambda role: "deepseek/deepseek-v4.1-flash-1017"),
        )
        return LivePanel(app, DummyCLI)

    def test_clean_header_shows_actual_gateway_and_model(self):
        p = self.panel()
        head = "".join(fragment[1] for fragment in p._top_text())
        self.assertIn("OpenRouter", head)
        self.assertIn("deepseek/deepseek-v4.1-flash-1017", head)
        self.assertNotIn("kilo-auto/free", head)

    def test_composer_stays_focused_and_single_pane(self):
        p = self.panel()
        self.assertIs(p._layout.current_window, p._typing.window)
        self.assertNotIn("OMEGA · LIVE", str(p._layout.container))
        self.assertEqual(p._typing.window.height.preferred, 1)

    def test_explicit_enter_binding_is_registered(self):
        p = self.panel()
        enter_bindings = [
            b for b in p.application.key_bindings.bindings
            if tuple(str(k) for k in b.keys) == ("Keys.ControlM",)
        ]
        self.assertTrue(enter_bindings)

    def test_first_submit_queues_once_without_waiting_for_reply(self):
        p = self.panel()
        buffer = SimpleNamespace(text="Hej Buddy")
        self.assertTrue(p._submit(buffer))
        self.assertEqual(buffer.text, "")
        self.assertEqual(p.queue.get_nowait(), "Hej Buddy")
        self.assertTrue(p.queue.empty())
