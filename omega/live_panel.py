"""OMEGA's optional live two-column terminal interface.

Real split-screen rendering through prompt_toolkit: left scrollable chat,
right compact status panel, and a dedicated input line. Never prints private
model chain-of-thought; it displays evidence-backed process summaries and
real tool execution results instead. This module is optional and imported
only for an interactive terminal.
"""
from __future__ import annotations

import asyncio
from collections import deque
from datetime import datetime
import re
import shutil
import threading
import time
from typing import Any

from prompt_toolkit import Application
from prompt_toolkit.input import DummyInput
from prompt_toolkit.output import DummyOutput
from prompt_toolkit.filters import Condition
from prompt_toolkit.layout import (
    ConditionalContainer, Dimension, HSplit, Layout, VSplit, Window,
)
from prompt_toolkit.layout.controls import FormattedTextControl
from prompt_toolkit.widgets import Frame, TextArea
from prompt_toolkit.styles import Style


def remaining_seconds(last: float, seconds: float, current: float) -> str:
    """Elapsed timer with no invented deadline."""
    if not last or seconds <= 0:
        return "--:--"
    left = max(0, int(seconds - (current - last)))
    return f"{left // 60:02d}:{left % 60:02d}"


def clean_line(value: Any, limit: int = 52) -> str:
    """Compact visible trace, no raw tool args, tokens or full screen text."""
    value = re.sub(r"\x1b\[[0-9;]*m", "", str(value or ""))
    value = re.sub(r"[\r\n\t]+", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value[:limit - 1] + "…" if len(value) > limit else value


class LivePanel:
    """Factory-backed UI: uses the existing CLI contract, not a second agent."""

    def __init__(self, app: Any, cli_base: type):
        # Use an actual subclass to preserve isinstance(ui, CLI) behaviour in
        # the existing input routing, permissions, and voice callbacks.
        self._ui = type("_LivePanelCLI", (cli_base,), {
            "_out": LivePanel._out,
            "status": LivePanel.status,
            "step": LivePanel.step,
            "step_done": LivePanel.step_done,
            "summary": LivePanel.summary,
            "event": LivePanel.event,
            "prompt": LivePanel.prompt,
            "header": LivePanel.header,
        })(app)
        ui = self._ui
        ui._panel_state = self
        self.app = app
        self.messages: deque[str] = deque(maxlen=220)
        self._cached_level: dict = {}
        self._level_checked_at = 0.0
        self._level_task: asyncio.Task | None = None
        self._cached_companion: Any = None
        self._cached_companion_options: dict = {}
        self._cached_companion_enabled = False
        self._companion_checked_at = 0.0
        self.trace: deque[tuple[str, bool | None, float]] = deque(maxlen=9)
        self.phase = "Väntar på uppgift"
        self.tool = "-"
        self.step_time = 0.0
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self.task: asyncio.Task | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock = threading.RLock()
        self._typing = TextArea(height=1, multiline=False, wrap_lines=False,
                                prompt="you › ", accept_handler=self._submit)
        self._chat = TextArea(read_only=True, focusable=False,
                              scrollbar=True, wrap_lines=True, line_numbers=False)
        self._status_control = FormattedTextControl(self._side_text)
        right = Frame(Window(content=self._status_control, wrap_lines=True),
                      title=" OMEGA · LIVE ", width=Dimension.exact(39))
        visibility = Condition(lambda: shutil.get_terminal_size((120, 35)).columns >= 94)
        self._layout = Layout(
            VSplit([
                HSplit([
                    Frame(self._chat, title=" CHAT "),
                    Frame(self._typing, title=" SKRIV "),
                ], padding=0),
                ConditionalContainer(right, filter=visibility),
            ], padding=1),
            focused_element=self._typing,
        )
        self.application = Application(
            layout=self._layout,
            full_screen=True,
            input=DummyInput() if not __import__('sys').stdin.isatty() else None,
            output=DummyOutput() if not __import__('sys').stdout.isatty() else None,
            mouse_support=False,
            refresh_interval=1.0,
            style=Style.from_dict({
                "frame.border": "#b02d78",
                "frame.label": "bold #ff79bb",
                "text-area": "#ffffff bg:#140d17",
                "": "#ffffff bg:#140d17",
            }),
        )

    @property
    def ui(self) -> Any:
        return self._ui

    def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self.task = self._loop.create_task(self.application.run_async())

    async def read_line(self) -> str:
        return await self.queue.get()

    def close(self) -> None:
        if self.application.is_running:
            self.application.exit()

    def _submit(self, buffer: Any) -> bool:
        entered = buffer.text.strip()
        buffer.text = ""
        if entered:
            shown = re.sub(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",
                           "[REDACTED-JWT]", entered)
            # Echo instantly into the visible conversation, not just the backing deque.
            self._add("you › " + clean_line(shown, 900))
            self.queue.put_nowait(entered)
        return True

    def _refresh(self) -> None:
        # No terminal cursor manipulation: prompt_toolkit owns the full layout.
        if self.application.is_running:
            if self._loop is not None and self._loop.is_running():
                self._loop.call_soon_threadsafe(self.application.invalidate)

    def _add(self, text: str) -> None:
        # Prior CLI output contains ANSI codes. In prompt_toolkit those were
        # printed as visible escape garbage; render clean white text instead.
        sanitized = re.sub(r"\x1b\[[0-9;]*m", "", str(text))
        def update() -> None:
            with self._lock:
                self.messages.append(sanitized)
                view = "\n".join(self.messages)[-16000:]
                self._chat.text = view
                self._chat.buffer.cursor_position = len(view)
            self._refresh()
        if self._loop and self._loop.is_running() and threading.current_thread() is not threading.main_thread():
            self._loop.call_soon_threadsafe(update)
        else:
            update()

    async def _refresh_level(self) -> None:
        try:
            self._cached_level = await asyncio.to_thread(self.app.level_snapshot)
        except Exception:
            self._cached_level = {}
        self._refresh()

    def _side_text(self) -> list[tuple[str, str]]:
        app = self.app
        now = time.time()
        lines: list[tuple[str, str]] = []
        def add(text: str, style: str = "") -> None:
            lines.append((style, clean_line(text, 55) + "\n"))

        running = bool(app.current_run)
        # Avoid loading the profile/SQLite and lazy Companion subsystem on
        # every 1-second redraw: doing so stalls the terminal input.
        if time.monotonic() - self._companion_checked_at >= 8:
            self._companion_checked_at = time.monotonic()
            try:
                self._cached_companion = app.companion.loop if app.companion.present()[0] else None
                self._cached_companion_options = self._cached_companion.options() if self._cached_companion else {}
                self._cached_companion_enabled = bool(self._cached_companion_options.get("enabled"))
            except Exception:
                self._cached_companion = None
                self._cached_companion_enabled = False
                self._cached_companion_options = {}
        comp = self._cached_companion
        comp_enabled = self._cached_companion_enabled
        observing = bool(comp_enabled and comp and comp.captures > 0
                         and (now - comp.last_capture_at) < 90)
        active = running or observing
        mode = ("● ARBETAR" if running else "◉ OBSERVERAR" if observing
                else "◌ VAKEN · INVÄNTAR CYKEL" if comp_enabled else "○ SOVER")
        add(mode, "bold #ff72b6" if active else "#bca8bc")
        add("AI  kilo-auto/free  ·  VOICE OFF", "#ffffff")
        add("──────────────────────────────────", "#744061")
        add("STEG: " + self.phase, "bold #ffe0f1")
        add("VERKTYG: " + self.tool, "#fbc4df")
        add("──────────────────────────────────", "#744061")
        add("COMPANION: " + ("LIVE" if comp_enabled else "OFF"), "#ff72b6")
        if comp_enabled and comp:
            opts = self._cached_companion_options
            add("Nästa Companion-tick: " + remaining_seconds(
                comp.last_tick_at, float(opts.get("tick_seconds", 30)), now))
            capture_after = float(opts.get("capture_seconds", 30))
            next_capture = remaining_seconds(comp.last_capture_at, capture_after, now)
            if comp.last_capture_at == 0:
                next_capture = "första körning ej klar"
            add("Nästa skärmkoll: " + next_capture)
            idle = max(0, float(comp.idle_seconds()))
            threshold = float(opts.get("idle_seconds", 180))
            add("Reflektion vid vila: " + f"{max(0, int(threshold-idle))} s")
            add("Lyckade skärmkoller: " + str(comp.captures))
            add("Senaste: " + clean_line(comp.last_capture_note, 37))
            add("Cykler: " + str(comp.ticks))
        else:
            add("Nästa skärmkoll: --:--")
            add("Reflektion: pausad")
        add("──────────────────────────────────", "#744061")
        add("AKTIVITET · VERKLIGA VERKTYG", "bold #ff90c8")
        if self.trace:
            for label, ok, _at in list(self.trace)[-7:]:
                mark = "✓" if ok is True else ("✕" if ok is False else "›")
                add(" " + mark + " " + clean_line(label, 37), "#ffffff" if ok is True else "#ffb3bc")
        else:
            add(" Inga verktyg körda ännu.", "#bca8bc")
        add("──────────────────────────────────", "#744061")
        # Evidence level can query the whole task/tool/memory history. Cache it.
        if time.monotonic() - self._level_checked_at >= 45:
            self._level_checked_at = time.monotonic()
            try:
                loop = asyncio.get_running_loop()
                if self._level_task is None or self._level_task.done():
                    self._level_task = loop.create_task(self._refresh_level())
            except RuntimeError:
                pass  # unit tests and headless status do not trigger expensive queries
        lvl = self._cached_level.get("level")
        if isinstance(lvl, (float, int)):
            green = min(20, max(0, round(lvl / 5)))
            add("AI LEVEL: " + str(lvl) + "/100", "bold #ffffff")
            add("●" * green + "○" * (20 - green), "#ff76b7")
        else:
            add("AI LEVEL: ej uppmätt", "#bca8bc")
        add("Nivån bygger på verifierad evidens.", "#bdafba")
        add("──────────────────────────────────", "#744061")
        add("Arbetsstatus, inte intern tankekedja.", "#d4b7c9")
        add("Skriv /presence för 20-minutersrapport.", "#d4b7c9")
        return lines

    # Below methods become overrides on an actual CLI subclass.
    def _out(self, text: str) -> None:
        self._panel_state._add(text)

    def status(self, text: str) -> None:
        panel = self._panel_state
        panel.phase = clean_line(text, 44)
        panel._refresh()

    def step(self, text: str) -> None:
        panel = self._panel_state
        panel.tool = clean_line(text, 48)
        panel.phase = "Kör verktyg"
        panel.step_time = time.monotonic()
        panel.trace.append((panel.tool, None, time.time()))
        panel._refresh()

    def step_done(self, ok: bool, err: str = "") -> None:
        panel = self._panel_state
        if panel.trace:
            old = panel.trace.pop()
            panel.trace.append((old[0], bool(ok), old[2]))
        panel.phase = ("Steg klart" if ok else "Steg misslyckades")
        if err and not ok:
            # Never dump raw exceptions here: provider errors can contain secrets.
            panel._add("Ett verktyg misslyckades. Se felstatus i panelen.")
        panel._refresh()

    def summary(self, run: Any, result: Any) -> None:
        panel = self._panel_state
        count = sum(1 for item in run.ledger if item.get("ok"))
        verified = bool(result.verified) and result.status in ("complete", "answered")
        panel.phase = "Verifierat" if verified else "Ej fullständigt verifierat"
        panel._add(f"RESULTAT · {count} lyckade steg · {panel.phase}")
        panel._refresh()

    def event(self, text: str) -> None:
        panel = self._panel_state
        panel.phase = clean_line(text, 45)
        panel._refresh()

    def prompt(self) -> None:
        self._panel_state._refresh()

    def header(self) -> None:
        self._panel_state._refresh()
