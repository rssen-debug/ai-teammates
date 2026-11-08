"""Presence start and progress invariants: consent, off, and evidence-only display."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

OMEGA = Path(__file__).resolve().parents[1]
if str(OMEGA) not in sys.path:
    sys.path.insert(0, str(OMEGA))

import buddy


class SettingsFake:
    def __init__(self, values=None):
        self.data = dict(values or {})

    def get(self, key, default=None):
        return self.data.get(key, default)

    def set(self, key, value):
        self.data[key] = value


class GrantsFake:
    def __init__(self, values=None):
        self.data = dict(values or {})

    def all(self):
        return dict(self.data)


class ObservationFake:
    def __init__(self):
        self.depth = ""
    def set_depth(self, depth):
        self.depth = depth
        return True, ""


class CompanionFake:
    def __init__(self):
        self._obs = None
        self.observation = ObservationFake()
        self.loop = SimpleNamespace(enable=lambda enabled: None)

    def present(self):
        return True, ""


class PresenceTests(unittest.TestCase):
    def make_app(self, settings=None, grants=None):
        return SimpleNamespace(
            settings=SettingsFake(settings), perms=GrantsFake(grants),
            companion=CompanionFake())

    def test_explicit_off_stays_off(self):
        app = self.make_app(
            {"auto_mode_on_start": False, "screenshot_upload": "allow"},
            {k: "always" for k in ("observe", "input", "write", "exec")})
        activated, _ = buddy.activate_saved_presence(app)
        self.assertFalse(activated)
        self.assertFalse(app.settings.get("auto_mode_on_start"))

    def test_missing_consent_is_not_invented(self):
        app = self.make_app()
        activated, _ = buddy.activate_saved_presence(app)
        self.assertFalse(activated)
        self.assertEqual(app.perms.all(), {})

    def test_prior_owner_activation_restored_without_voice_change(self):
        app = self.make_app(
            {"screenshot_upload": "allow", "voice_enabled": False, "obsidian_auto_memory": True},
            {k: "always" for k in ("observe", "input", "write", "exec")})
        activated, _ = buddy.activate_saved_presence(app)
        self.assertTrue(activated)
        self.assertEqual(app.companion.observation.depth, "capture")
        self.assertEqual(app.settings.get("models")["chat"], "kilo-auto/free")
        self.assertTrue(app.settings.get("obsidian_auto_memory"))
        self.assertFalse(app.settings.get("voice_enabled"))

    def test_previous_obsidian_off_is_respected(self):
        app = self.make_app(
            {"screenshot_upload": "allow", "obsidian_auto_memory": False,
             "observe_enabled": False},
            {k: "always" for k in ("observe", "input", "write", "exec")})
        activated, _ = buddy.activate_saved_presence(app)
        self.assertTrue(activated)
        self.assertFalse(app.settings.get("obsidian_auto_memory"))
        self.assertFalse(app.settings.get("observe_enabled"))

    def test_revoked_permission_never_regranted(self):
        app = self.make_app(
            {"auto_mode_on_start": True, "screenshot_upload": "allow"},
            {"observe": "always", "input": "always", "write": "always"})
        activated, _ = buddy.activate_saved_presence(app)
        self.assertFalse(activated)
        self.assertNotIn("exec", app.perms.all())


if __name__ == "__main__":
    unittest.main()
