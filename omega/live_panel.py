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
        self.messages: deque[str] = deque(maxlen=450)
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
                      title=" OMEGA · LIVE ", width=Dimension(preferred=43, min=36))
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
            mouse_support=True,
            refresh_interval=1.0,
            style=Style.from_dict({
                "frame.border": "#145e36",
                "frame.label": "bold #41e888",
                "text-area": "#dedede",
                "": "#c4e0cc bg:#07140f",
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
            self.messages.append("you › " + clean_line(shown, 900))
            self.queue.put_nowait(entered)
            self._refresh()
        return True

    def _refresh(self) -> None:
        # No terminal cursor manipulation: prompt_toolkit owns the full layout.
        if self.application.is_running:
            if self._loop is not None and self._loop.is_running():
                self._loop.call_soon_threadsafe(self.application.invalidate)

    def _add(self, text: str) -> None:
        with self._lock:
            self.messages.append(str(text))
            self._chat.text = "\n".join(self.messages)[-28000:]
            self._chat.buffer.cursor_position = len(self._chat.text)
        self._refresh()

    def _side_text(self) -> list[tuple[str, str]]:
        app = self.app
        now = time.time()
        lines: list[tuple[str, str]] = []
        def add(text: str, style: str = "") -> None:
            lines.append((style, clean_line(text, 55) + "\n"))

        running = bool(app.current_run)
        comp = None
        try:
            if app.companion.present()[0]:
                comp = app.companion.loop
        except Exception:
            pass
        observing = bool(comp and comp.enabled and comp.captures > 0
                         and (now - comp.last_capture_at) < 90)
        active = running or observing
        mode = ("● ARBETAR" if running else "◉ OBSERVERAR" if observing
                else "◌ VAKEN · INVÄNTAR CYKEL" if comp and comp.enabled else "○ SOVER")
        add(mode, "bold #46f184" if active else "#899c91")
        add("AI  kilo-auto/free  ·  VOICE OFF", "#b8f3c7")
        add("──────────────────────────────────", "#1f5438")
        add("STEG: " + self.phase, "bold #a1ffbe")
        add("VERKTYG: " + self.tool, "#8edcaa")
        add("──────────────────────────────────", "#1f5438")
        add("COMPANION: " + ("LIVE" if comp and comp.enabled else "OFF"), "#41e888")
        if comp and comp.enabled:
            opts = comp.options()
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
        add("──────────────────────────────────", "#1f5438")
        add("AKTIVITET · VERKLIGA VERKTYG", "bold #65ef9e")
        if self.trace:
            for label, ok, _at in list(self.trace)[-7:]:
                mark = "✓" if ok is True else ("✕" if ok is False else "›")
                add(" " + mark + " " + clean_line(label, 37), "#99efb5" if ok is True else "#d7ad74")
        else:
            add(" Inga verktyg körda ännu.", "#899c91")
        add("──────────────────────────────────", "#1f5438")
        level = app.level_snapshot()
        lvl = level.get("level")
        if isinstance(lvl, (float, int)):
            green = min(20, max(0, round(lvl / 5)))
            add("AI LEVEL: " + str(lvl) + "/100", "bold #a8fdbf")
            add("●" * green + "○" * (20 - green), "#42e985")
        else:
            add("AI LEVEL: ej uppmätt", "#899c91")
        add("Nivån bygger på verifierad evidens.", "#7d9a86")
        add("──────────────────────────────────", "#1f5438")
        add("Arbetsstatus, inte intern tankekedja.", "#8aab94")
        add("Skriv /presence för 20-minutersrapport.", "#8aab94")
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
