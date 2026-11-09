"""Offline regression tests for native provider routing and auth headers."""
from __future__ import annotations

import sys
import unittest
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import buddy


class FakeVault:
    def __init__(self, values):
        self.values = values

    def get(self, name):
        return self.values.get(name)


class NativeProviderTests(unittest.TestCase):
    def test_openrouter_uses_exact_1017_without_kilo_fallback(self):
        vault = FakeVault({
            "omega_active_provider": "OpenRouter",
            "openrouter_api_key": "test-token",
        })
        gateway = buddy.Gateway(vault)
        self.assertEqual(gateway.provider, "OpenRouter")
        self.assertEqual(gateway.candidates,
                         ["https://openrouter.ai/api/v1"])
        self.assertEqual(gateway.key(), "test-token")
        router = buddy.Router(buddy.Settings.__new__(buddy.Settings), gateway)
        self.assertEqual(router.resolve("chat"),
                         "deepseek/deepseek-v4.1-flash-1017")
        self.assertEqual(router.ladder(), [])

    def test_opencode_go_has_stable_session_header(self):
        vault = FakeVault({
            "omega_active_provider": "OpenCode Go",
            "opencode_go_api_key": "test-go-token",
        })
        gateway = buddy.Gateway(vault)
        self.assertEqual(gateway.candidates,
                         ["https://opencode.ai/inference/go/openai/v1"])
        self.assertEqual(gateway.key(), "test-go-token")
        import provider_native
        one = urllib.request.Request(gateway.base + "/chat/completions")
        two = urllib.request.Request(gateway.base + "/models")
        self.assertEqual(one.get_header("X-opencode-session"),
                         two.get_header("X-opencode-session"))
        self.assertEqual(one.get_header("X-opencode-session"),
                         provider_native.SESSION_ID)

    def test_openrouter_requests_do_not_inherit_go_header(self):
        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/chat/completions")
        self.assertIsNone(req.get_header("X-opencode-session"))

    def test_kilo_mode_remains_available(self):
        gateway = buddy.Gateway(FakeVault({"omega_active_provider": "Kilo"}))
        self.assertEqual(gateway.provider, "Kilo")
        self.assertTrue(gateway.candidates)


if __name__ == "__main__":
    unittest.main()
