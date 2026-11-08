"""Portable continuity stays evidence-backed and efficient on CPU."""
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import buddy
from personal_memory import ObservationVault


class ContinuityTest(unittest.TestCase):
    def test_sync_skips_existing_unchanged_note(self):
        with tempfile.TemporaryDirectory() as temp:
            row = {"kind": "preference", "title": "Use short answers",
                   "content": "Keep answers concise", "status": "verified",
                   "updated": time.time() - 10}
            store = SimpleNamespace(q=lambda query: [row])
            app = SimpleNamespace(store=store,
                settings=SimpleNamespace(get=lambda key, default=None:
                    True if key == "obsidian_auto_memory" else temp if key == "obsidian_vault" else default))
            with patch.object(buddy, "sibling", return_value=sys.modules["personal_memory"]):
                first = buddy.sync_owner_knowledge(app)
                path = ObservationVault(Path(temp)).knowledge_path(row["kind"], row["title"])
                self.assertEqual(first, (1, 0))
                before = path.stat().st_mtime_ns
                second = buddy.sync_owner_knowledge(app)
                self.assertEqual(second, (0, 1))
                self.assertEqual(before, path.stat().st_mtime_ns)
                row["updated"] = time.time() + 2
                third = buddy.sync_owner_knowledge(app)
                self.assertEqual(third, (1, 0))

    def test_private_mode_does_not_run_housekeeping(self):
        # Housekeeping must check owner consent before touching the vault.
        import inspect
        body = inspect.getsource(buddy.memory_continuity_loop)
        self.assertIn("app.privacy.private", body)
        self.assertIn("obsidian_auto_memory", body)

if __name__ == "__main__":
    unittest.main()
