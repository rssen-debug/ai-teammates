"""Voice is off on each launch and /voice toggles microphone on/off."""
import asyncio
import inspect
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from buddy import Buddy, session


class Voice:
    def __init__(self):
        self.running = False
        self.starts = 0
        self.stops = 0
    def start(self):
        self.running = True
        self.starts += 1
        return True, "test mic"
    def stop(self):
        self.running = False
        self.stops += 1


class VoiceToggleTest(unittest.TestCase):
    def setUp(self):
        self.mic = Voice()
        self.output = []
        self.app = SimpleNamespace(voice=self.mic, out=self.output.append)

    def test_voice_command_toggles_on_then_off(self):
        asyncio.run(Buddy.command(self.app, "/voice"))
        self.assertTrue(self.mic.running)
        self.assertEqual(self.mic.starts, 1)
        asyncio.run(Buddy.command(self.app, "/voice"))
        self.assertFalse(self.mic.running)
        self.assertEqual(self.mic.stops, 1)

    def test_explicit_voice_on_and_off_still_work(self):
        asyncio.run(Buddy.command(self.app, "/voice on"))
        self.assertTrue(self.mic.running)
        asyncio.run(Buddy.command(self.app, "/voice off"))
        self.assertFalse(self.mic.running)

    def test_session_does_not_autostart_microphone(self):
        src = inspect.getsource(session)
        self.assertIn('app.settings.set("voice_enabled", False)', src)
        self.assertNotIn("app.voice.start)", src)
        self.assertIn("Voice OFF on startup", src)


if __name__ == "__main__":
    unittest.main()
