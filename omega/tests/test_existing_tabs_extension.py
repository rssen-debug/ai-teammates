"""Existing-tabs extension bridge: no-focus protocol and safe routing tests."""
from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import buddy
import browser_extension_bridge

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"


class MemoryVault:
    def __init__(self):
        self.values = {}

    def get(self, key):
        return self.values.get(key)

    def set(self, key, val):
        self.values[key] = val


class ExtensionBridgeTests(unittest.TestCase):
    def test_pairing_uses_random_persistent_token(self):
        vault = MemoryVault()
        bridge = browser_extension_bridge.BrowserBridge(SimpleNamespace(vault=vault))
        first = bridge.token()
        self.assertGreaterEqual(len(first), 35)
        self.assertEqual(first, bridge.token())
        self.assertNotIn("token", first.lower())

    def test_disconnected_extension_fails_fast(self):
        bridge = browser_extension_bridge.BrowserBridge(SimpleNamespace(vault=MemoryVault()))
        self.assertFalse(bridge.ready()[0])
        with self.assertRaisesRegex(RuntimeError, "Extension"):
            bridge.call("tabs")
        with self.assertRaises(ValueError):
            bridge.call("eval", {"javascript": "alert(1)"})

    def test_extension_manifest_is_mv3_and_has_existing_tabs_capability(self):
        manifest = json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["manifest_version"], 3)
        self.assertIn("tabs", manifest["permissions"])
        self.assertIn("scripting", manifest["permissions"])
        self.assertNotIn("debugger", manifest["permissions"])
        self.assertNotIn("nativeMessaging", manifest["permissions"])

    def test_existing_tabs_js_never_activates_window_or_os_mouse(self):
        js = (EXT / "background.js").read_text(encoding="utf-8")
        for forbidden in ("chrome.tabs.update(", "chrome.windows.update(",
                          "chrome.debugger.", "sendInput", "remote-debugging"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, js)
        self.assertIn("chrome.scripting.executeScript", js)
        self.assertIn("chrome.tabs.query", js)

    @unittest.skipUnless(shutil.which("node"), "Node syntax check requires Node.js")
    def test_extension_scripts_are_syntactically_valid(self):
        for path in (EXT / "background.js", EXT / "options.js"):
            with self.subTest(filename=path.name):
                res = subprocess.run([shutil.which("node"), "--check", str(path)],
                                     capture_output=True, encoding="utf-8", errors="replace",
                                     text=True, timeout=20)
                self.assertEqual(res.returncode, 0, res.stderr)

    def test_runtime_registration_and_missing_extension_are_safe(self):
        app = buddy.Buddy(headless=True)
        self.assertIsNotNone(app.registry.get("background_tabs"))
        self.assertIsNotNone(app.registry.get("background_click"))
        self.assertIsNotNone(app.registry.get("background_click_many"))
        with patch.object(app.browser_bridge, "ready", return_value=(False, "offline")):
            run = buddy.AgentRun(app, "Klicka på de tre rätta svaren i min Chrome-flik")
            outcome = asyncio.run(run.execute())
        self.assertEqual(outcome.status, "blocked")
        self.assertEqual(outcome.steps, 0)

    def test_start_script_does_not_launch_second_chrome(self):
        src = (ROOT / "start_latest.ps1").read_text(encoding="utf-8")
        self.assertIn("StuddyBuddy\\extension", src)
        self.assertIn("Copy-Item", src)
        self.assertNotIn("Start-Process -FilePath $chrome", src)


if __name__ == "__main__":
    unittest.main()
