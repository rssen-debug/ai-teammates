"""Tests for bounded, non-secret Obsidian screen observation storage."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

OMEGA = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OMEGA))
from personal_memory import ObservationVault, clean_observation


class ObservationVaultTest(unittest.TestCase):
    def test_writes_obsidian_markdown_with_evidence_label(self):
        with tempfile.TemporaryDirectory() as d:
            vault = ObservationVault(Path(d))
            ok, file, text = vault.record("Code.exe", "Editing a Python project", timestamp=1794140000)
            self.assertTrue(ok, file)
            data = Path(file).read_text("utf-8")
            self.assertIn("type: observation", data)
            self.assertIn("confidence: unverified", data)
            self.assertIn("Editing a Python project", data)
            self.assertNotIn("data:image", data)

    def test_never_records_explicit_secrets(self):
        with tempfile.TemporaryDirectory() as d:
            vault = ObservationVault(Path(d))
            ok, _, _ = vault.record("Chrome", "Entering a password in login form")
            self.assertFalse(ok)
            self.assertFalse(list(Path(d).rglob("*.md")))

    def test_redacts_identifiers(self):
        clean = clean_observation("Working with hello@example.com ticket 1234567890123")
        self.assertNotIn("hello@example.com", clean)
        self.assertNotIn("1234567890123", clean)
        self.assertIn("[email hidden]", clean)

    def test_clear_removes_only_generated_notes(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            vault = ObservationVault(root)
            vault.record("Code.exe", "Editing a source file", timestamp=1794140000)
            other = root / "observations" / "notes" / "my-study-notes.md"
            other.parent.mkdir(parents=True, exist_ok=True)
            other.write_text("keep this", encoding="utf-8")
            self.assertEqual(vault.clear_observations(), 1)
            self.assertTrue(other.exists())

    def test_deduplicates_and_caps(self):
        with tempfile.TemporaryDirectory() as d:
            vault = ObservationVault(Path(d), daily_cap=2, same_note_cooldown=900)
            self.assertTrue(vault.record("Code", "Editing code", timestamp=1794140000)[0])
            self.assertFalse(vault.record("Code", "Editing code", timestamp=1794140005)[0])
            self.assertTrue(vault.record("Code", "Reviewing a test", timestamp=1794140010)[0])
            self.assertFalse(vault.record("Code", "Checking a third task", timestamp=1794140020)[0])
            self.assertEqual(len(list(Path(d).rglob("*.md"))), 2)


if __name__ == "__main__":
    unittest.main()
