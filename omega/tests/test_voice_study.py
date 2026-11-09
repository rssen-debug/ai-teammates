"""Low-latency study voice: offline unit/integration tests with no microphone/API."""
from __future__ import annotations

import asyncio
import sys
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import voice_study


class SentenceTests(unittest.TestCase):
    def test_first_full_sentence_can_be_spoken_before_model_finishes(self):
        chunks, rest = voice_study.completed_sentence(
            "Det är en switch som arbetar på lager två. Nästa sats pågår"
        )
        self.assertEqual(chunks, ["Det är en switch som arbetar på lager två."])
        self.assertEqual(rest, "Nästa sats pågår")

    def test_very_long_clause_makes_progress_without_full_reply(self):
        chunks, rest = voice_study.completed_sentence("ord " * 50)
        self.assertTrue(chunks)
        self.assertLess(len(rest), 140)

    def test_final_flush_preserves_short_answer(self):
        chunks, rest = voice_study.completed_sentence("Ja.", force=True)
        self.assertEqual(chunks, ["Ja."])
        self.assertFalse(rest)


class FakeMemory:
    def __init__(self):
        self.saved = []

    def history(self, max_chars):
        return "Tidigare läste vi OSI", [
            {"role": "user", "content": "Vad är IP?"},
            {"role": "assistant", "content": "IP är adressering."},
        ]

    def add_turn(self, role, content, ticket, source):
        self.saved.append((role, content, source))


class FakeSpeech:
    instances = []

    def __init__(self, voice, cancel, generation):
        self.sentences = []
        self.cancel = cancel
        self.__class__.instances.append(self)

    def enqueue(self, text):
        self.sentences.append(text)

    def finish(self):
        pass


class MockGateway:
    def __init__(self):
        self.received = None

    def chat_stream_sync(self, model, messages, tools, max_tokens, timeout, on_delta):
        self.received = (model, messages, tools, max_tokens, timeout)
        on_delta("En switch kopplar ihop enheter i samma nätverk. ")
        on_delta("Den arbetar vanligtvis på lager två.")
        return {"message": {"content":
            "En switch kopplar ihop enheter i samma nätverk. Den arbetar vanligtvis på lager två."}}


class StudyFlowTests(unittest.IsolatedAsyncioTestCase):
    async def test_tutor_streams_audio_while_saving_context(self):
        speech = FakeSpeech
        speech.instances.clear()
        gateway = MockGateway()
        memory = FakeMemory()
        events = []
        outputs = []
        fake_voice = SimpleNamespace(
            _study_generation=0,
            interrupt=lambda: None,
            speaking=False,
        )
        app = SimpleNamespace(
            voice=fake_voice,
            gateway=gateway,
            memory=memory,
            router=SimpleNamespace(resolve=lambda role: "deepseek/deepseek-v4.1-flash-1017"),
            live_panel=None,
            privacy=SimpleNamespace(private=False),
            last_selection={"text": "Text från en NetAcad-övning"},
            ui=SimpleNamespace(event=events.append),
            out=outputs.append,
        )
        with patch.object(voice_study, "SpeechStream", speech):
            await voice_study.study_turn(app, "Vad gör en switch?", "sv")
        self.assertEqual(len(speech.instances), 1)
        self.assertEqual(len(speech.instances[0].sentences), 2)
        self.assertIn("switch", speech.instances[0].sentences[0].lower())
        self.assertEqual([x[0] for x in memory.saved], ["user", "assistant"])
        self.assertIn("voice-study", memory.saved[0][2])
        self.assertIn("markerade", gateway.received[1][0]["content"])
        self.assertEqual(gateway.received[2], None)
        self.assertTrue(outputs)
        self.assertTrue(any("första token" in x for x in events))


if __name__ == "__main__":
    unittest.main()
