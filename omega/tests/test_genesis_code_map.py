"""Prove V3 code-map is deterministic, local and invoked from Buddy."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from genesis_code_map import source_map_for_goal


class GenesisSourceMapTests(unittest.TestCase):
    def test_only_self_maintenance_requests_trigger_mapping(self):
        self.assertIsNone(source_map_for_goal("Fix my Outlook email"))
        self.assertIsNone(source_map_for_goal("fix my Python script"))
        self.assertIsNone(source_map_for_goal("hello"))

    def test_ast_parses_without_executing_untrusted_code(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            (path / "live_panel.py").write_text(
                "def safe_panel():\n    return 3\n"
                "def dangerous():\n    raise Exception('should never execute')\n",
                encoding="utf-8")
            result = source_map_for_goal("fix Buddy panel", root=path)
            self.assertIn("live_panel.py", result)
            self.assertIn("safe_panel", result)
            self.assertIn("dangerous", result)

    def test_actual_buddy_runtime_wires_source_map(self):
        text = (Path(__file__).resolve().parents[1] / "buddy.py").read_text(encoding="utf-8")
        self.assertIn("source_map_for_goal(run.goal)", text)
        self.assertIn("GENESIS V3 SOURCE MAP", text)


if __name__ == "__main__":
    unittest.main()
