"""Background observation must never use the Buddy terminal or protected apps."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import buddy

class ObservationTargetTest(unittest.TestCase):
    def test_selects_eligible_background_window_with_explicit_handle(self):
        terminal = {"title": "Administrator: Studdy Buddy", "app": "WindowsTerminal.exe", "hwnd": 1}
        editor = {"title": "Code workspace", "app": "Code.exe", "hwnd": 2, "rect": [0, 0, 900, 600]}
        app = SimpleNamespace(
            world=SimpleNamespace(target=lambda: terminal,
                                  is_buddy_host=lambda w: w["hwnd"] == 1),
            privacy=SimpleNamespace(private=False, protected_window=lambda title, app: False))
        with patch.object(buddy, "IS_WIN", True), patch.object(buddy.Win32, "windows", return_value=[terminal, editor]):
            chosen = buddy.CompanionSubsystem(app)._screen_context()
        self.assertEqual(chosen, {"title": "Code workspace", "app": "Code.exe", "hwnd": 2})

    def test_excludes_sensitive_windows_and_private_mode(self):
        terminal = {"title": "Studdy Buddy", "app": "WindowsTerminal.exe", "hwnd": 1}
        bank = {"title": "Bank login", "app": "browser.exe", "hwnd": 3, "rect": [0, 0, 900, 600]}
        app = SimpleNamespace(
            world=SimpleNamespace(target=lambda: terminal,
                                  is_buddy_host=lambda w: w["hwnd"] == 1),
            privacy=SimpleNamespace(private=False, protected_window=lambda title, app: "Bank" in title))
        with patch.object(buddy, "IS_WIN", True), patch.object(buddy.Win32, "windows", return_value=[terminal, bank]):
            self.assertEqual(buddy.CompanionSubsystem(app)._screen_context(), {})
            app.privacy.private = True
            self.assertEqual(buddy.CompanionSubsystem(app)._screen_context(), {})

if __name__ == "__main__":
    unittest.main()
