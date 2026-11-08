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
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.mouse_events import MouseEventType
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


def evidence_progress(snapshot: dict) -> dict:
    """Genuine next-level evidence cap; quality may impose a stricter limit.

    No wall-clock ETA: level progression depends on verified outcomes, not time.
    """
    try:
        level = int(snapshot["level"])
        count = int(snapshot["measured_events"])
        full = int(snapshot.get("evidence_full") or 250)
        raw = float(snapshot.get("raw_level", level))
    except (TypeError, ValueError, KeyError):
        return {"measured": False, "reason": "Nivådata saknas"}
    if level >= 100:
        return {"measured": True, "complete": True, "level": 100, "reason": "Maxnivå"}
    next_level = level + 1
    # See omega/level.py: floor(min(raw, 1 + 99*min(1,count/full))).
    from math import ceil
    required = ceil((next_level - 1) * full / 99)
    if raw < next_level:
        return {"measured": True, "complete": False, "level": level,
                "target": next_level, "quality_limited": True,
                "events": count, "required": required,
                "remaining": max(0, required - count),
                "reason": "Förbättra verifierad kvalitet"}
    lower = max(0, ceil((level - 1) * full / 99))
    span = max(1, required - lower)
    portion = min(1.0, max(0.0, (count - lower) / span))
    return {"measured": True, "complete": False, "level": level,
            "target": next_level, "quality_limited": False,
            "events": count, "required": required,
            "remaining": max(0, required - count),
            "fraction": portion,
            "reason": "Mer verifierad evidens krävs"}


def companion_stage(level: int | None) -> tuple[int, str]:
    """Visual evolution tracks measured capability levels, never time or tokens."""
    if not isinstance(level, (int, float)):
        return 0, "okänd"
    level = max(1, min(100, int(level)))
    if level < 10:
        return 0, "Frö"
    if level < 25:
        return 1, "Liten kompis"
    if level < 50:
        return 2, "Upptäckare"
    if level < 75:
        return 3, "Väktare"
    return 4, "Stjärnkompis"


def companion_personality(mode: str, level: int | None = None,
                          success: bool | None = None) -> str:
    """A playful one-liner derived from actual state, not claimed emotions."""
    if success is False:
        return "Oops! Kollar vad som gick fel."
    phrases = {
        "working": "På ett uppdrag! Verktyg i gång.",
        "observing": "Nyfiken! Läser det jag får se.",
        "awake": "Här finns jag. Redo för nästa idé.",
        "sleeping": "Zzz... viloläge.",
    }
    if level is None:
        return phrases.get(mode, "Redo när du behöver mig.")
    stage, _ = companion_stage(level)
    if mode == "working" and stage >= 3:
        return "Fokusläge! Jag testar och verifierar."
    return phrases.get(mode, "Redo när du behöver mig.")


def pixel_companion(mode: str, frame: int = 0,
                    level: int | None = None) -> tuple[str, ...]:
    """Five pixel-art life stages tied to actual LEVEL 1-100 evidence.

    Small idle blink/bob animations use time only for appearance. Growth itself
    strictly follows the measured level from omega/level.py.
    """
    stage, _ = companion_stage(level)
    blink = frame % 9 == 8
    eyes = ("─ ─" if blink or mode == "sleeping" else
            "◕ ◕" if mode == "working" else
            "● ●" if mode == "observing" else "• •")
    mouth = ("﹏" if mode == "sleeping" else
             "ᴗ" if mode in ("working", "observing") else "ω")
    heart = "♥" if frame % 2 == 0 else "♡"
    if stage == 0:
        return (
            "     ▄██▄",
            "    █ " + eyes + " █",
            "    █  " + mouth + "  █",
            "     ▀██▀",
            "      ▀▀",
        )
    if stage == 1:
        return (
            "     ▄███▄",
            "   ▄███████▄",
            "   █  " + eyes + "  █",
            "   █   " + mouth + "   █",
            "   ▀█  " + heart + "  █▀",
            "     ▀███▀",
            "      ▀ ▀",
        )
    if stage == 2:
        return (
            "   ▄▄     ▄▄",
            "  ▄██▄▄███▄▄",
            " ▄██████████▄",
            " ███  " + eyes + "  ███",
            " ███   " + mouth + "   ███",
            " ▀██   " + heart + "   ██▀",
            "   ▀███████▀",
            "    ▀▀ ▀▀",
        )
    if stage == 3:
        return (
            "  ✦ ▄▄     ▄▄ ✦",
            "   ▄██▄▄███▄▄",
            " ▄████████████▄",
            " ███   " + eyes + "   ███",
            " ███    " + mouth + "    ███",
            " ███    " + heart + "    ███",
            " ▀████████████▀",
            "   ▀██▀ ▀██▀",
            "    ▀▀   ▀▀",
        )
    return (
        "       ✧   ✦",
        "  ✦ ▄▄▄     ▄▄▄ ✦",
        "   ▄████▄▄▄████▄",
        "  ███████████████",
        "  ████   " + eyes + "  ████",
        "  ████    " + mouth + "   ████",
        "  ████    " + heart + "   ████",
        "  ▀█████████████▀",
        "    ▀███▀ ▀███▀",
        "      ▀▀   ▀▀",
        "   ✧           ✧",
    )


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
        self._last_level: int | None = None
        self._last_level_change = 0.0
        self._level_checked_at = 0.0
        self._level_task: asyncio.Task | None = None
        self._companion_task: asyncio.Task | None = None
        self._cached_idle_seconds: float = 0.0
        self._cached_companion: Any = None
        self._cached_companion_options: dict = {}
        self._cached_companion_enabled = False
        self._companion_checked_at = 0.0
        self.trace: deque[tuple[str, bool | None, float]] = deque(maxlen=9)
        self.phase = "Väntar på uppgift"
        self.show_thinking = False
        self.events: deque[str] = deque(maxlen=24)
        self._stream_text = ""
        self._stream_active = False
        self._side_cache: list = []
        self._side_cache_at = 0.0
        self._side_dirty = True
        self._tetris: Any = None
        self._tetris_task: asyncio.Task | None = None
        self._build_state = "ej startad"
        self._build_step = 0
        self._build_error = ""
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
        keys = KeyBindings()
        @keys.add("f2")
        def _toggle(_event: Any) -> None:
            self.toggle_thinking()
        right = Frame(Window(content=self._status_control, wrap_lines=False),
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
            mouse_support=True,
            key_bindings=keys,
            refresh_interval=2.0,
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
        self._companion_task = self._loop.create_task(self._companion_poll())
        self._tetris_task = self._loop.create_task(self._tetris_loop())

    async def read_line(self) -> str:
        return await self.queue.get()

    def close(self) -> None:
        if self._companion_task is not None:
            self._companion_task.cancel()
        if self._tetris_task is not None:
            self._tetris_task.cancel()
        if self.application.is_running:
            self.application.exit()

    def toggle_thinking(self) -> None:
        self.show_thinking = not self.show_thinking
        self._refresh()

    def _side_click(self, event: Any) -> None:
        if event.event_type == MouseEventType.MOUSE_UP:
            self.toggle_thinking()
        return None

    def _render_chat(self) -> None:
        view = "\n".join(self.messages)[-16000:]
        if self._stream_active and self._stream_text:
            view += "\nbuddy › " + self._stream_text[-9000:]
        self._chat.text = view
        self._chat.buffer.cursor_position = len(view)
        self._refresh()

    def stream_begin(self) -> None:
        self._stream_text = ""
        self._stream_active = True
        self._refresh()

    def stream_delta(self, text: str) -> None:
        if not self._stream_active:
            return
        self._stream_text += re.sub(r"\x1b\[[0-9;]*m", "", str(text))
        # Do not rebuild an increasingly large conversation per character.
        if len(self._stream_text) < 64 or len(self._stream_text) % 48 < len(text):
            self._render_chat()

    def stream_end(self) -> None:
        self._stream_active = False
        self._stream_text = ""
        self._render_chat()

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
        # Keep heavy sidebar rendering separate from each typed character.
        self._side_dirty = True
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
                self._render_chat()
        if self._loop and self._loop.is_running() and threading.current_thread() is not threading.main_thread():
            self._loop.call_soon_threadsafe(update)
        else:
            update()

    async def _tetris_loop(self) -> None:
        """Live game state, not fabricated AI activity or an AI level shortcut.

        The coding task is a distinct, durable tool-driven process in the task DB.
        Polling that state happens in a worker thread so typing remains responsive.
        """
        try:
            from pixel_tetris import PixelTetris
            self._tetris = PixelTetris()
        except Exception as exc:
            self._build_error = "Tetris engine: " + type(exc).__name__
            return
        while True:
            try:
                self._tetris.tick()
                self._refresh()
                if self.app.tasks:
                    await asyncio.to_thread(self._poll_build_state)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._build_error = type(exc).__name__
            await asyncio.sleep(1.2)

    def _poll_build_state(self) -> None:
        try:
            tasks = self.app.tasks.list(30)
            related = next((task for task in tasks
                            if str(task.get("title") or "").startswith("Pixel Tetris BUILD")), None)
            if related:
                self._build_state = str(related.get("state") or "unknown")
                self._build_step = int(related.get("step_idx") or 0)
                self._build_error = clean_line(related.get("error") or "", 35)
                if self._build_state == "done":
                    # A completed task is NOT necessarily a verified game.
                    import json
                    try:
                        record = json.loads(related.get("result") or "{}")
                        if not record.get("verified", False):
                            self._build_state = "klar · ej verifierad"
                        else:
                            self._build_state = "klar · agentverifierad"
                    except (ValueError, TypeError):
                        self._build_state = "klar · bevis saknas"
            else:
                self._build_state = "ej köad"
        except Exception as exc:
            self._build_error = "task status: " + type(exc).__name__

    async def _companion_poll(self) -> None:
        """Collect potentially blocking settings/Windows idle data outside UI rendering."""
        while True:
            try:
                await asyncio.to_thread(self._read_companion_state)
                self._refresh()
            except asyncio.CancelledError:
                raise
            except Exception:
                self._cached_companion = None
                self._cached_companion_enabled = False
                self._cached_companion_options = {}
            await asyncio.sleep(8)

    def _read_companion_state(self) -> None:
        try:
            companion = self.app.companion
            loop = companion.loop if companion.present()[0] else None
            options = loop.options() if loop else {}
            idle = float(loop.idle_seconds()) if loop else 0.0
            with self._lock:
                self._cached_companion = loop
                self._cached_companion_options = options
                self._cached_companion_enabled = bool(options.get("enabled"))
                self._cached_idle_seconds = idle
        except Exception:
            with self._lock:
                self._cached_companion = None
                self._cached_companion_options = {}
                self._cached_companion_enabled = False
                self._cached_idle_seconds = 0.0

    async def _refresh_level(self) -> None:
        try:
            self._cached_level = await asyncio.to_thread(lambda: self.app.settings.get("level") or self.app.level_snapshot())
        except Exception:
            self._cached_level = {}
        self._refresh()

    def _side_text(self) -> list[tuple[str, str]]:
        stamp = time.monotonic()
        if not self._side_dirty and stamp - self._side_cache_at < 1.0:
            return self._side_cache
        self._side_dirty = False
        self._side_cache_at = stamp
        app = self.app
        now = time.time()
        lines: list[tuple[str, str]] = []
        def add(text: str, style: str = "") -> None:
            lines.append((style, clean_line(text, 34) + "\n"))

        running = bool(app.current_run)
        # Rendering must NEVER query SQLite, discover plugins or poll Win32.
        # The dedicated companion poll above maintains these cached values.
        comp = self._cached_companion
        comp_enabled = self._cached_companion_enabled
        observing = bool(comp_enabled and comp and comp.captures > 0
                         and (now - comp.last_capture_at) < 90)
        active = running or observing
        mode = ("● ARBETAR" if running else "◉ OBSERVERAR" if observing
                else "◌ VAKEN · INVÄNTAR CYKEL" if comp_enabled else "○ SOVER")
        add(mode, "bold #ff72b6" if active else "#bca8bc")
        sprite_mode = ("working" if running else "observing" if observing else
                       "awake" if comp_enabled else "sleeping")
        sprite_level = self._cached_level.get("level")
        stage, stage_name = companion_stage(sprite_level)
        for part in pixel_companion(sprite_mode, int(now // 2), sprite_level):
            add(part, "#ff8fc5")
        add(f"Pixelkompis · {stage_name} · form {stage + 1}/5", "#ffffff")
        last_tool_ok = self.trace[-1][1] if self.trace else None
        add(companion_personality(sprite_mode, sprite_level, last_tool_ok), "#ffcae6")
        if sprite_level is None:
            add("Växer först när level mäts.", "#d4b7c9")
        add("AI kilo-auto/free · VOICE OFF", "#ffffff")
        add("──── PIXEL TETRIS · LIVE ────", "#744061")
        if self._tetris is not None:
            for row in self._tetris.display():
                add(" " + row, "#ff9bd0")
            add(f"Spel: {self._tetris.score}p · {self._tetris.lines} rader", "#ffffff")
            add(f"Riktiga lås: {self._tetris.pieces}", "#ffffff")
        else:
            add("Spelmotor ej startad", "#bca8bc")
        # Game physics never contributes to AI LEVEL. A live project build is
        # separately backed by the persistent task engine and its evidence.
        add("AI BYGGER: " + self._build_state, "#ff8fc5")
        if self._build_step:
            add("Agentsteg: " + str(self._build_step), "#ffffff")
        if self._build_error:
            add("Hinder: " + self._build_error, "#ff9ba6")
        add("Spel ≠ AI-framsteg", "#bca8bc")
        if running and app.current_run:
            elapsed = max(0, int(now - float(app.current_run.t0)))
            add(f"Väntat på AI: {elapsed // 60:02d}:{elapsed % 60:02d}", "#ffffff")
        add("──────────────────────────────────", "#744061")
        lines.append(("bold #ff90c8", "TÄNKER · klicka här / F2\n", self._side_click))
        if self.show_thinking:
            add("LIVE ARBETSSPÅR · " + str(len(self.events)), "#ffffff")
            for detail in list(self.events)[-9:]:
                add(" " + detail, "#ffe0f1")
            if not self.events:
                add(" Inga arbetssteg ännu", "#bca8bc")
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
            idle = max(0, float(self._cached_idle_seconds))
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
            current = int(lvl)
            if self._last_level is None:
                self._last_level = current
            elif current != self._last_level:
                self._last_level_change = now
                self._last_level = current
            pink = min(20, max(0, round(current / 5)))
            add("AI LEVEL: " + str(current) + "/100", "bold #ffffff")
            add("●" * pink + "○" * (20 - pink), "#ff76b7")
            if self._last_level_change:
                add("Senaste nivåbyte: " + datetime.fromtimestamp(
                    self._last_level_change).strftime("%H:%M:%S"), "#ffffff")
            progress = evidence_progress(self._cached_level)
            if progress.get("measured"):
                if progress.get("complete"):
                    add("Maxnivå nådd.", "#ffffff")
                elif progress.get("quality_limited"):
                    add("Nästa LVL: " + str(progress["target"]), "bold #ffffff")
                    add("Hinder: förbättra verifierade", "#ffd0e6")
                    add("resultat (inte bara fler körningar)", "#ffd0e6")
                else:
                    add("Nästa LVL: " + str(progress["target"]), "bold #ffffff")
                    fill = max(0, min(20, round(progress["fraction"] * 20)))
                    add("[" + "█" * fill + "░" * (20-fill) + "]", "#ff8ec6")
                    add(f"Evidens: {progress['events']}/{progress['required']} · saknas {progress['remaining']}", "#ffffff")
            else:
                add("Nästa level: saknar mätdata", "#ffffff")
            add("Tid till level: okänd (ej tidstyrt)", "#d4b7c9")
        else:
            add("AI LEVEL: ej uppmätt", "#bca8bc")
        add("Nivån bygger på verifierad evidens.", "#bdafba")
        add("──────────────────────────────────", "#744061")
        add("Arbetsstatus, inte intern tankekedja.", "#d4b7c9")
        add("Skriv /presence för 20-minutersrapport.", "#d4b7c9")
        self._side_cache = lines
        return lines

    # Below methods become overrides on an actual CLI subclass.
    def _out(self, text: str) -> None:
        self._panel_state._add(text)

    def status(self, text: str) -> None:
        panel = self._panel_state
        panel.phase = clean_line(text, 44)
        panel.events.append(datetime.now().strftime("%H:%M:%S") + " · " + panel.phase)
        panel._refresh()

    def step(self, text: str) -> None:
        panel = self._panel_state
        panel.tool = clean_line(text, 48)
        panel.phase = "Kör verktyg"
        panel.step_time = time.monotonic()
        panel.trace.append((panel.tool, None, time.time()))
        panel.events.append(datetime.now().strftime("%H:%M:%S") + " · Kör " + panel.tool)
        panel._refresh()

    def step_done(self, ok: bool, err: str = "") -> None:
        panel = self._panel_state
        if panel.trace:
            old = panel.trace.pop()
            panel.trace.append((old[0], bool(ok), old[2]))
        panel.phase = ("Steg klart" if ok else "Steg misslyckades")
        panel.events.append(datetime.now().strftime("%H:%M:%S") + " · " + panel.phase)
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
        panel.events.append(datetime.now().strftime("%H:%M:%S") + " · " + panel.phase)
        panel._refresh()

    def prompt(self) -> None:
        self._panel_state._refresh()

    def header(self) -> None:
        self._panel_state._refresh()
