"""Real prompt_toolkit input-path tests: one Enter must queue one turn.

These run without a physical TTY using a pipe and DummyOutput. They exercise
the key binding through the actual Application loop rather than calling the
_submit helper directly. Hardware-level Windows responsiveness still needs a
separate manual/desktop test.
"""
from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from prompt_toolkit import Application
from prompt_toolkit.input import create_pipe_input
from prompt_toolkit.output import DummyOutput
from live_panel import LivePanel


class MinimalCLI:
    def __init__(self, app):
        self.app = app


class EnterE2ETests(unittest.IsolatedAsyncioTestCase):
    def panel(self):
        owner = SimpleNamespace(
            current_run=None,
            gateway=SimpleNamespace(base="https://openrouter.ai/api/v1"),
            router=SimpleNamespace(resolve=lambda role: "deepseek/deepseek-v4.1-flash-1017"),
        )
        return LivePanel(owner, MinimalCLI)

    async def run_keys(self, keys: str, expected: list[str]):
        panel = self.panel()
        with create_pipe_input() as pipe:
            app = Application(
                layout=panel._layout,
                key_bindings=panel.application.key_bindings,
                style=panel.application.style,
                input=pipe,
                output=DummyOutput(),
                full_screen=False,
                refresh_interval=0.8,
                mouse_support=False,
            )
            panel.application = app
            panel._loop = asyncio.get_running_loop()
            task = asyncio.create_task(app.run_async())
            try:
                await asyncio.sleep(0.08)
                pipe.send_text(keys)
                got = [
                    await asyncio.wait_for(panel.queue.get(), timeout=2.0)
                    for _ in expected
                ]
                self.assertEqual(got, expected)
                await asyncio.sleep(0.05)
                self.assertTrue(panel.queue.empty(), "duplicate message was queued")
            finally:
                if app.is_running:
                    app.exit()
                await asyncio.wait_for(task, timeout=2.0)

    async def test_first_enter_submits_without_extra_keypress(self):
        await self.run_keys("hej buddy\r", ["hej buddy"])

    async def test_two_rapid_messages_are_not_duplicated(self):
        await self.run_keys("hej\rhur mår du\r", ["hej", "hur mår du"])

    async def test_blank_enter_does_not_create_an_empty_turn(self):
        await self.run_keys("\rfråga\r", ["fråga"])


if __name__ == "__main__":
    unittest.main()
