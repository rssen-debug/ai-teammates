"""Windows transcript must never cut off text at the right edge."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from live_panel import LivePanel, chat_wrap_width, wrap_chat_display


class FakeCLI:
    def __init__(self, app):
        self.app = app


class WrapRegressionTests(unittest.TestCase):
    def panel(self):
        app = SimpleNamespace(current_run=None,
                              companion=SimpleNamespace(present=lambda: (False, "")),
                              level_snapshot=lambda: {"level": 30})
        return LivePanel(app, FakeCLI)

    def test_long_swedish_answer_is_visible_at_safe_line_width(self):
        sentence = "Här är ett exempel på ett längre svenskt svar som behöver läsas i sin helhet utan att kapas. "
        original = "buddy › " + sentence * 16
        wrapped = wrap_chat_display(original, 85)
        self.assertTrue(all(len(line) <= 85 for line in wrapped.splitlines()))
        self.assertEqual("".join(original.split()), "".join(wrapped.split()))
        self.assertIn("kapas.", wrapped)

    def test_super_long_unbroken_token_does_not_overflow(self):
        original = "buddy › https://example.org/" + "a" * 380
        wrapped = wrap_chat_display(original, 70)
        self.assertTrue(all(len(line) <= 70 for line in wrapped.splitlines()))
        self.assertEqual(original.replace(" ", ""), wrapped.replace("\n", "").replace(" ", ""))

    def test_blank_lines_and_bullets_survive(self):
        out = wrap_chat_display("buddy › svar\n\n  • Första punkt\n  • Andra punkt", 60)
        self.assertIn("\n\n", out)
        self.assertIn("Första punkt", out)
        self.assertIn("Andra punkt", out)

    def test_width_accounts_for_sidebar_and_small_terminals(self):
        for columns in (60, 80, 120, 160, 200, 300):
            width = chat_wrap_width(columns)
            self.assertLess(width, columns)
            self.assertLessEqual(width, 100)
            self.assertGreaterEqual(width, 36)

    def test_render_is_wrapped_without_mutating_source_message(self):
        p = self.panel()
        source = "buddy › " + "långt_sammansatt_ord_" * 40
        p.ui._out(source)
        self.assertEqual(p.messages[-1], source)
        width = chat_wrap_width(120)
        self.assertTrue(all(len(line) <= width for line in p._chat.text.splitlines()))
        self.assertIn("långt_sammansatt_ord_", p.messages[-1])

    def test_newest_long_reply_not_truncated_by_old_16000_limit(self):
        p = self.panel()
        reply = "buddy › " + ("viktig text " * 2200) + "SLUTMARKÖR"
        p.ui._out(reply)
        self.assertIn("SLUTMARKÖR", p._chat.text)
        self.assertEqual(p.messages[-1], reply)


if __name__ == "__main__":
    unittest.main()
