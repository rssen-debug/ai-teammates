"""Tests for real V3 learning loop: verified -> persisted -> reused as advisory."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from genesis_playbooks import PlaybookStore, verified_sequence, goal_category


class PlaybookTests(unittest.TestCase):
    def good(self):
        return [
            {"seq": 1, "tool": "file_write", "ok": True, "effect": True, "observes": False},
            {"seq": 2, "tool": "file_read", "ok": True, "effect": False, "observes": True},
        ]

    def test_learning_really_persists_and_is_retrieved_on_next_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "playbooks.sqlite3"
            a = PlaybookStore(path)
            done = SimpleNamespace(status="complete", verified=True)
            self.assertIsNone(a.suggest("Fix my file"))
            self.assertTrue(a.record("Fix my file", done, self.good()))
            self.assertIsNone(a.suggest("Fix my file"))
            self.assertTrue(a.record("Fix my file", done, self.good()))
            b = PlaybookStore(path)
            hint = b.suggest("Fix my file")
            self.assertIn("file_write → file_read", hint)
            self.assertIn("not authorization", hint)
            self.assertEqual(b.count(), 1)

    def test_no_false_skill_from_chat_failure_or_unverified_effect(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = PlaybookStore(Path(tmp) / "p.db")
            done = SimpleNamespace(status="complete", verified=True)
            self.assertFalse(store.record("Fix my file", SimpleNamespace(status="answered", verified=True), self.good()))
            self.assertFalse(store.record("Fix my file", SimpleNamespace(status="failed", verified=False), self.good()))
            self.assertFalse(store.record("Fix my file", done, [{"seq": 1, "tool": "file_write", "ok": True, "effect": True, "observes": False}]))
            self.assertFalse(store.record("Fix my file", done, list(reversed([
                {"seq": 1, "tool": "file_read", "ok": True, "effect": False, "observes": True},
                {"seq": 2, "tool": "file_write", "ok": True, "effect": True, "observes": False},
            ]))))
            bad = self.good()
            bad[1]["ok"] = False
            self.assertFalse(store.record("Fix my file", done, bad))
            self.assertEqual(store.count(), 0)
            self.assertIsNone(store.suggest("Fix my file"))

    def test_reject_user_contents_as_tool_names(self):
        done = SimpleNamespace(status="complete", verified=True)
        bad = self.good()
        bad[1]["tool"] = "file_read secret=abc"
        self.assertEqual(verified_sequence(done, bad), ())
        self.assertEqual(goal_category("Fix an Outlook problem"), "WINDOWS")
        self.assertEqual(goal_category("script fails"), "KOD")

    def test_private_mode_guard_is_in_actual_buddy_hooks(self):
        text = (Path(__file__).resolve().parents[1] / "buddy.py").read_text(encoding="utf-8")
        self.assertIn("PlaybookStore().record(self.goal, o, self.ledger)", text)
        self.assertIn("PlaybookStore().suggest(run.goal)", text)
        self.assertIn("if not self.app.privacy.private:", text)
        self.assertIn("if not self.privacy.private:", text)


if __name__ == "__main__":
    unittest.main()
