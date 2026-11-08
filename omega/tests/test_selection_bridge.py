"""Selection assistant does not use clipboard and refuses unsourced text."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from selection_bridge import selected_text, SelectionBridge, MAX_SELECTION


class FakeTextPattern:
    def __init__(self, values):
        self.values = values
    def GetSelection(self):
        return [SimpleNamespace(GetText=lambda maxlen, v=value: v[:maxlen])
                for value in self.values]


class FakeControl:
    def __init__(self, pattern):
        self.pattern = pattern
    def GetTextPattern(self):
        return self.pattern


class SelectionTest(unittest.TestCase):
    def test_real_selected_text_only(self):
        auto = SimpleNamespace(GetFocusedControl=lambda: FakeControl(
            FakeTextPattern(["real highlighted text", "second range"])))
        self.assertEqual(selected_text(auto), "real highlighted text\nsecond range")

    def test_no_selection_produces_no_context(self):
        auto = SimpleNamespace(GetFocusedControl=lambda: FakeControl(FakeTextPattern([])))
        self.assertEqual(selected_text(auto), "")
        auto = SimpleNamespace(GetFocusedControl=lambda: None)
        self.assertEqual(selected_text(auto), "")

    def test_bounded_text_avoids_huge_prompts(self):
        auto = SimpleNamespace(GetFocusedControl=lambda: FakeControl(
            FakeTextPattern(["a" * 20000])))
        self.assertEqual(len(selected_text(auto)), MAX_SELECTION)

    def test_hotkey_not_started_until_owner_opt_in(self):
        app = SimpleNamespace()
        bridge = SelectionBridge(app)
        self.assertIsNone(bridge.thread)
        self.assertEqual(bridge.status, "OFF")


if __name__ == "__main__":
    unittest.main()
