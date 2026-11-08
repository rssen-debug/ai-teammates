"""No unsolicited status report may pollute the conversation panel."""
from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import buddy


class CleanChatTest(unittest.IsolatedAsyncioTestCase):
    async def test_presence_heartbeat_only_reports_to_event_channel(self):
        class StopNow(Exception):
            pass

        events = []
        messages = []
        app = SimpleNamespace(
            shutting_down=False,
            privacy=SimpleNamespace(private=False),
            ui=SimpleNamespace(event=events.append, prompt=lambda: messages.append("PROMPT")),
            out=messages.append
        )
        async def fake_sleep(seconds):
            raise StopNow if events else None
        # Advance exactly one heartbeat then stop the loop on next sleep.
        original = buddy.asyncio.sleep
        async def tick(seconds):
            if events:
                raise StopNow()
        try:
            buddy.asyncio.sleep = tick
            with self.assertRaises(StopNow):
                await buddy.presence_heartbeat(app, interval=1200)
        finally:
            buddy.asyncio.sleep = original
        self.assertEqual(len(events), 1)
        self.assertIn("Presence", events[0])
        self.assertEqual(messages, [])

    def test_presence_summary_has_no_canned_ask_cta(self):
        source = Path(buddy.__file__).read_text(encoding="utf-8")
        self.assertNotIn("Ask 'Vad har du lärt dig om mina projekt?'", source)
        self.assertNotIn('app.out(presence_report(app, minutes=20))', source)
        self.assertNotIn('app.out("\\n".join(ram_snapshot.splitlines()[:8]))', source)

    def test_prompt_requires_link_evidence_and_no_generic_ask(self):
        self.assertIn("inspect it with browser/web tools", buddy.SYSTEM_PROMPT)
        self.assertIn("do not merely restate their input", buddy.SYSTEM_PROMPT)


if __name__ == "__main__":
    unittest.main()
