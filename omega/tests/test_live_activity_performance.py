"""Omega V3 live timeline and render hot-path regressions."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import live_panel
from live_panel import LivePanel

class FakeCLI:
    def __init__(self, app):
        self.app = app

class HotPathTests(unittest.TestCase):
    def panel(self):
        return LivePanel(SimpleNamespace(
            current_run=None,
            gateway=SimpleNamespace(provider="OpenRouter", base="https://openrouter.ai/api/v1"),
            router=SimpleNamespace(resolve=lambda role: "deepseek/deepseek-v4.1-flash-1017"),
            settings=SimpleNamespace(get=lambda key, default=None: False),
        ), FakeCLI)

    def test_activity_visible_by_default_and_f2_can_hide(self):
        p = self.panel()
        self.assertTrue(p._show_tui_details)
        p.ui.explain_action("Find answer", "Search web", "Need verified source", "Read search results")
        p.ui.step("web search")
        p.ui.step_done(True)
        report = "".join(item[1] for item in p._details_text())
        self.assertIn("Find answer", report)
        self.assertIn("Search web", report)
        self.assertIn("web search", report)
        self.assertIn("PASS", report)
        self.assertNotIn("private chain", report)

    def test_header_never_resolves_model_or_queries_settings_during_redraw(self):
        p = self.panel()
        p._read_provider_state()
        def fail(*a, **k):
            raise AssertionError("DB/provider access on keystroke/render path")
        p.app.router.resolve = fail
        p.app.settings.get = fail
        self.assertIn("OpenRouter", "".join(x[1] for x in p._top_text()))
        p._bottom_text()
        p._details_text()

    def test_streaming_reuses_wrapped_static_history(self):
        p = self.panel()
        p.ui._out("buddy › " + "long content " * 250)
        p.stream_begin()
        with patch.object(live_panel, "wrap_chat_display",
                          wraps=live_panel.wrap_chat_display) as wrapper:
            for token in ["hej ", "jag ", "undersöker ", "nu"]:
                p._stream_text += token
                p._render_chat()
            # Exactly one wrap per streaming update, for the growing tail.
            self.assertEqual(wrapper.call_count, 4)

    def test_error_is_visible_not_pretended_success(self):
        p = self.panel()
        p.ui.step("broken tool")
        p.ui.step_done(False, "connection failed")
        report = "".join(x[1] for x in p._details_text())
        self.assertIn("FAIL", report)
        self.assertIn("broken tool", report)

if __name__ == "__main__":
    unittest.main()
