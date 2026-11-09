"""OMEGA's optional live two-column terminal interface.

Real split-screen rendering through prompt_toolkit: left scrollable chat,
right compact status panel, and a dedicated input line. Never prints private
model chain-of-thought; it displays evidence-backed process summaries and
real tool execution results instead. This module is optional and imported
only for an interactive terminal.
"""
from __future__ import annotations

import asyncio
import sqlite3
import os
import sys
from pathlib import Path
from collections import deque
from datetime import datetime
import re
import shutil
import threading
import time
import textwrap
from typing import Any

from genesis_telemetry import ExperienceLedger

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


LIVE_PANEL_BUILD = "wrap-v3-20261109"


def chat_wrap_width(columns: int) -> int:
    """Conservative chat width in terminal cells, leaving room for sidebar.

    We use a maximum readable measure even in very wide Windows terminals.
    Prompt-toolkit's soft wrapping plus a cursor at EOF can horizontally
    scroll nonfocusable read-only TextAreas: hard wrap is display-only.
    """
    columns = max(60, int(columns))
    if columns >= 100:
        return min(80, max(36, columns - 61))
    return max(24, min(72, columns - 8))


def wrap_chat_display(text: str, width: int = 96) -> str:
    """Wrap *display text*, preserving paragraphs and original stored content.

    No ellipsis/truncation; long tokens/URLs are displayed across safe lines.
    We intentionally don't modify conversation state or the model input.
    """
    width = max(16, min(120, int(width)))
    wrapped = []
    for line in str(text).split("\n"):
        if not line:
            wrapped.append("")
            continue
        # Keep indentation for replies and bullet lists without overflowing.
        indent = len(line) - len(line.lstrip(" "))
        continuation = " " * min(indent, 12)
        rows = textwrap.wrap(
            line, width=width, expand_tabs=True, tabsize=4,
            replace_whitespace=False, drop_whitespace=False,
            break_long_words=True, break_on_hyphens=False,
            subsequent_indent=continuation,
        )
        wrapped.extend(rows or [""])
    return "\n".join(wrapped)


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
    """Coherent five-stage pixel pet; only basic block/ASCII glyphs.

    Each row is a fixed-width terminal cell row. Avoid fractional blocks,
    wide emoji and mixed-width Unicode facial features, which damaged WinPTY
    rendering. Frames change facial expression only, NEVER measured growth.
    """
    stage, _ = companion_stage(level)
    blink = frame % 9 == 8 or mode == "sleeping"
    eyes = "- -" if blink else "O O" if mode == "working" else "o o"
    mouth = "w" if mode == "awake" else "v" if mode != "sleeping" else "-"
    pulse = "<3" if frame % 2 == 0 else "++"
    if stage == 0:
        lines = (
            "    █████    ",
            "   ███████   ",
            "  ██ " + eyes + " ██  ",
            "   ██ " + mouth + " ██   ",
            "    █████    ",
        )
    elif stage == 1:
        lines = (
            "    █████    ",
            "  █████████  ",
            " ██  " + eyes + "  ██ ",
            " ██   " + mouth + "   ██ ",
            " ██   " + pulse + "  ██ ",
            "  █████████  ",
            "   ██   ██   ",
        )
    elif stage == 2:
        lines = (
            "  ██     ██  ",
            "  ███   ███  ",
            " ███████████ ",
            " ██  " + eyes + "  ██ ",
            " ██   " + mouth + "   ██ ",
            " ██   " + pulse + "  ██ ",
            "  █████████  ",
            "   ██   ██   ",
        )
    elif stage == 3:
        lines = (
            "  ██     ██  ",
            " ████   ████ ",
            "█████████████",
            "███  " + eyes + "  ███",
            "███   " + mouth + "   ███",
            "███   " + pulse + "  ███",
            " ███████████ ",
            "  ███   ███  ",
            "  ██     ██  ",
        )
    else:
        lines = (
            "  ██     ██  ",
            " ████   ████ ",
            "█████████████",
            "█████████████",
            "███  " + eyes + "  ███",
            "███   " + mouth + "   ███",
            "███   " + pulse + "  ███",
            " ███████████ ",
            "  █████████  ",
            "  ███   ███  ",
            "  ██     ██  ",
        )
    return tuple(line.center(17) for line in lines)


SKILL_LABELS = (
    ("FILER", ("file", "fil", "folder", "mapp", "path", "directory", "read", "write")),
    ("WEBB", ("browser", "chrome", "web", "url", "dom", "page", "sida")),
    ("KOD", ("python", "script", "code", "git", "repo", "test", "kod")),
    ("WINDOWS", ("window", "uia", "desktop", "powershell", "process", "fönster")),
)

def observed_skill(tool_label: str) -> str:
    """Visible, best-effort category; never learning evidence."""
    label = clean_line(tool_label, 150).casefold()
    for name, keywords in SKILL_LABELS:
        if any(word in label for word in keywords):
            return name
    return "ÖVRIGT"


LEVEL_AXES = (
    ("A", "UPPGIFTER"),
    ("B", "ÅTERHÄMTNING"),
    ("C", "VERKTYG"),
    ("D", "MINNE"),
    ("E", "BENCHMARK"),
    ("F", "REGRESSION"),
)

def measured_axis_rows(snapshot: dict) -> list[tuple[str, str, float | None]]:
    """Show only real persisted axis metrics; missing axes are unknown."""
    if not isinstance(snapshot, dict):
        return []
    raw = snapshot.get("axes", [])
    if not isinstance(raw, list):
        return []
    values = {}
    for entry in raw:
        if not isinstance(entry, dict) or entry.get("axis") not in dict(LEVEL_AXES):
            continue
        value = entry.get("value")
        if entry.get("measured") is False or value is None or isinstance(value, bool):
            values[entry["axis"]] = None
        elif isinstance(value, (int, float)) and 0 <= value <= 1:
            values[entry["axis"]] = float(value)
    return [(key, name, values.get(key)) for key, name in LEVEL_AXES]


AXIS_NEXT_ACTION = {
    "UPPGIFTER": "Testa en uppgift med kontroll",
    "ÅTERHÄMTNING": "Testa säker felåterhämtning",
    "VERKTYG": "Verifiera fler olika verktyg",
    "MINNE": "Testa minnessökning + återbruk",
    "BENCHMARK": "Kör reproducerbara benchmark",
    "REGRESSION": "Kör hela regressionstestsviten",
}

def evidence_focus(snapshot: dict) -> tuple[str, str] | None:
    """Pick lowest *measured* quality axis, never an unobserved guess."""
    known = [(name, val) for _, name, val in measured_axis_rows(snapshot)
             if val is not None]
    if not known:
        return None
    name, value = min(known, key=lambda item: item[1])
    return name, AXIS_NEXT_ACTION[name]


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
            "explain_action": LivePanel.explain_action,
            "explain_result": LivePanel.explain_result,
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
        self._cached_playbooks = 0
        # Cached on the background refresh, never query Settings/SQLite while
        # prompt_toolkit is rendering a keystroke.
        self._cached_free_only = True
        self._last_stream_paint = 0.0
        self._submitted_at: deque[float] = deque(maxlen=100)
        self._input_delay_max = 0.0
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
        self.goal = ""
        self.action_title = ""
        self.action_reason = ""
        self.action_expect = ""
        self.action_result = ""
        self.action_evidence = ""
        self.action_started = 0.0
        # Session-only real tool outcomes, NOT persisted learning evidence.
        self._progress_outcomes: deque[bool] = deque(maxlen=14)
        self._tool_successes = 0
        self._tool_failures = 0
        self._tool_streak = 0
        self._best_tool_streak = 0
        self._last_tool_success_at = 0.0
        self._last_tool_event_at = 0.0
        self._progress_phase = "IDLE"
        self._last_tool_duration = 0.0
        # Conversational activity and independently checked work are distinct
        # from tool executions and AI LEVEL. Never infer learning from a reply.
        self._answers_delivered = 0
        self._verified_work = 0
        self._unverified_work = 0
        self._last_answer_at = 0.0
        self._run_state = "VÄNTAR"
        self._run_state_detail = ""
        # Session observations, not claimed model intelligence or persistent levels.
        self._skill_checks = {name: [0, 0] for name in ("FILER", "WEBB", "KOD", "WINDOWS", "ÖVRIGT")}
        self._evolution_timeline: deque[tuple[str, str]] = deque(maxlen=6)
        self._current_skill = "ÖVRIGT"
        # Persistent, category-only historical statistics; no content stored.
        self._experience = None
        self._experience_snapshot = {}
        try:
            self._experience = ExperienceLedger()
            self._experience_snapshot = self._experience.snapshot()
        except (OSError, ValueError, RuntimeError, sqlite3.DatabaseError):
            # A restricted/missing data directory must not break the UI.
            pass
        self.show_thinking = True
        self.compact_mode = True
        self._last_queue_delay = 0.0
        self._last_model_delay = 0.0
        self._waiting_for_response = False
        self._waiting_started = 0.0
        self.events: deque[str] = deque(maxlen=24)
        self._stream_text = ""
        self._stream_active = False
        self._side_cache: list = []
        self._side_cache_at = 0.0
        self._side_dirty = True
        self._stderr_saved_fd = None
        self._stderr_log_fd = None
        self._last_tool_error = ""
        self.tool = "-"
        self.step_time = 0.0
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self.task: asyncio.Task | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock = threading.RLock()
        self._typing = TextArea(height=1, multiline=False, wrap_lines=False,
                                prompt="› ", accept_handler=self._submit)
        self._chat = TextArea(read_only=True, focusable=False,
                              scrollbar=True, wrap_lines=True, line_numbers=False)
        self._status_control = FormattedTextControl(self._side_text)
        self._last_terminal_width = 0
        self._resize_task = None
        keys = KeyBindings()
        @keys.add("f2")
        def _toggle(_event: Any) -> None:
            self.toggle_thinking()
        @keys.add("f3")
        def _metrics(_event: Any) -> None:
            self.compact_mode = not self.compact_mode
            self._refresh()
        # Full-width terminal-first layout. A sidebar isn't allowed to steal
        # half the conversation or shrink the composer as in the old split view.
        self._top_control = FormattedTextControl(self._top_text)
        self._bottom_control = FormattedTextControl(self._bottom_text)
        self._layout = Layout(
            HSplit([
                Window(content=self._top_control, height=1, style="class:chrome"),
                Window(height=1, char="─", style="class:divider"),
                self._chat,
                Window(height=1, char="─", style="class:divider"),
                self._typing,
                Window(content=self._bottom_control, height=1, style="class:chrome"),
            ]),
            focused_element=self._typing,
        )
        self.application = Application(
            layout=self._layout,
            full_screen=True,
            input=DummyInput() if not __import__('sys').stdin.isatty() else None,
            output=DummyOutput() if not __import__('sys').stdout.isatty() else None,
            # Some Windows console hosts generate many mouse events and fail
            # to notify full-screen terminal resizes reliably. Keyboard F2/F3
            # remains available; do not spend time processing mouse traffic.
            mouse_support=False,
            key_bindings=keys,
            refresh_interval=0.3,
            terminal_size_polling_interval=0.5,
            max_render_postpone_time=0.03,
            min_redraw_interval=0.04,
            style=Style.from_dict({
                "": "#e9e7f2 bg:#100e17",
                "text-area": "#e9e7f2 bg:#100e17",
                "chrome": "#b7acc9 bg:#1c1626",
                "divider": "#594269 bg:#100e17",
            }),
        )

    def _top_text(self) -> list[tuple[str, str]]:
        """Nonblocking single-line identity and real model status."""
        working = bool(getattr(self.app, "current_run", None))
        try:
            provider = getattr(getattr(self.app, "gateway", None), "base", "")
            provider = "OpenRouter" if "openrouter.ai" in provider else (
                "OpenCode Go" if "opencode.ai" in provider else "Kilo")
            model = self.app.router.resolve("chat")
        except (AttributeError, KeyError, ValueError, TypeError):
            provider, model = "unknown", "unknown"
        return [
            ("bold #e49cc9", "  ◈ OMEGA  "),
            ("#786a88", "│  "),
            ("#dbd4e5", provider + "  "),
            ("#786a88", "·  "),
            ("#9cddb2", str(model)[:50]),
            ("#786a88", "   │   "),
            ("bold #9cddb2" if working else "#b6b0c3",
             "WORKING" if working else "READY"),
        ]

    def _bottom_text(self) -> list[tuple[str, str]]:
        """Compact factual footer; tool telemetry never interrupts chat."""
        running = self._waiting_for_response
        return [
            ("bold #9cddb2", "  ● " + ("RESPONDING" if running else "READY")),
            ("#786a88", "  │  "),
            ("#c5bad3", f"TOOLS {self._tool_successes} OK / {self._tool_failures} FAIL"),
            ("#786a88", "  │  "),
            ("#a9a0b6", f"VERIFIED {self._verified_work}"),
            ("#786a88", "  │  "),
            ("#b79dc6", "F2 DETAILS · F3 METRICS · /help"),
        ]

    @property
    def ui(self) -> Any:
        return self._ui

    def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self.task = self._loop.create_task(self.application.run_async())
        self._companion_task = self._loop.create_task(self._companion_poll())
        self._resize_task = self._loop.create_task(self._watch_chat_width())
        self._redirect_stderr()

    async def _watch_chat_width(self) -> None:
        """Rewrap existing text when Windows terminal is resized, not on keys."""
        while True:
            try:
                # Detect geometry changes from the same source as rendering,
                # not a different Windows host size estimate.
                signature = self._current_chat_wrap_width()
                if signature != self._last_terminal_width:
                    self._last_terminal_width = signature
                    self._render_chat()
            except asyncio.CancelledError:
                raise
            except (AttributeError, ValueError, OSError):
                pass
            await asyncio.sleep(1.0)

    async def read_line(self) -> str:
        line = await self.queue.get()
        if self._submitted_at:
            elapsed = max(0.0, time.monotonic() - self._submitted_at.popleft())
            self._input_delay_max = max(self._input_delay_max, elapsed)
            self._last_queue_delay = elapsed
            if elapsed > 0.35:
                self.events.append(f"UI input queue: {elapsed:.2f}s (actual wait)")
                self._refresh()
        return line

    def close(self) -> None:
        if self._companion_task is not None:
            self._companion_task.cancel()
        if self._resize_task is not None:
            self._resize_task.cancel()
        self._restore_stderr()
        if self.application.is_running:
            self.application.exit()

    def response_started(self) -> None:
        self._waiting_for_response = True
        self._waiting_started = time.monotonic()
        self._refresh()

    def response_finished(self) -> None:
        if self._waiting_for_response:
            self._last_model_delay = max(0.0, time.monotonic() - self._waiting_started)
        self._waiting_for_response = False
        self._refresh()

    def toggle_thinking(self) -> None:
        self.show_thinking = not self.show_thinking
        self._refresh()

    def _side_click(self, event: Any) -> None:
        if event.event_type == MouseEventType.MOUSE_UP:
            self.toggle_thinking()
        return None

    def _current_chat_wrap_width(self) -> int:
        """Use the exact same width source for UI and its regression tests.

        In particular, a non-interactive CI shell may report 80 columns while
        a test assumed 120. Prefer actual prompt_toolkit window geometry,
        then its output geometry, then the process terminal fallback.
        """
        pane = getattr(getattr(self._chat, "window", None), "render_info", None)
        pane_columns = getattr(pane, "window_width", 0) if pane else 0
        if isinstance(pane_columns, int) and pane_columns > 28:
            return max(24, min(80, pane_columns - 7))
        # Windows10_Output is a real prompt_toolkit backend and may not expose
        # get_size(). Never require a method merely because DummyOutput has it.
        output = getattr(self.application, "output", None)
        getter = getattr(output, "get_size", None)
        if callable(getter):
            try:
                size = getter()
                columns = int(size.columns)
                if columns >= 60:
                    return chat_wrap_width(columns)
            except (OSError, TypeError, ValueError, AttributeError):
                pass
        return chat_wrap_width(shutil.get_terminal_size((120, 35)).columns)

    def _render_chat(self) -> None:
        # The older [-16000:] slice could cut off the middle of an answer.
        # Keep recent complete messages, trimming only whole older turns.
        recent = list(self.messages)
        selected = []
        budget = 64000
        for item in reversed(recent):
            if selected and budget - len(item) < 0:
                break
            selected.append(item)
            budget -= len(item) + 1
        view = "\n".join(reversed(selected))
        if self._stream_active and self._stream_text:
            view += "\nbuddy › " + self._stream_text
        # Use the width of the ACTUAL TextArea pane when prompt_toolkit has
        # rendered it. A Windows host's reported full terminal width is not
        # the width available to the chat alongside the OMEGA sidebar.
        wrap_at = self._current_chat_wrap_width()
        view = wrap_chat_display(view, wrap_at)
        self._chat.text = view
        self._chat.buffer.cursor_position = len(view)
        self._refresh(sidebar=False)

    def stream_begin(self) -> None:
        self._stream_text = ""
        self._stream_active = True
        self._refresh()

    def stream_delta(self, text: str) -> None:
        if not self._stream_active:
            return
        self._stream_text += re.sub(r"\x1b\[[0-9;]*m", "", str(text))
        # Do not rebuild an increasingly large conversation per character.
        current = time.monotonic()
        if len(self._stream_text) <= 64 or current - self._last_stream_paint >= 0.10:
            self._last_stream_paint = current
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
            if (getattr(self.app, "_omega_key_entry", None) or
                    getattr(self.app, "_worker_vnc_password_pending", False)):
                shown = "[API-nyckel dold]"
            # Commit to the agent queue BEFORE repainting a large transcript.
            # Prior version repainted synchronously before queuing, making
            # Enter feel stuck on slow Windows terminals.
            self._submitted_at.append(time.monotonic())
            self.queue.put_nowait(entered)
            if self._loop and self._loop.is_running():
                self._loop.call_soon(self._add, "you › " + clean_line(shown, 900))
            else:
                self._add("you › " + clean_line(shown, 900))
        return True

    def _refresh(self, sidebar: bool = True) -> None:
        # Streaming and chat echo must NOT rebuild the large sidebar.
        if sidebar:
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

    def _redirect_stderr(self) -> None:
        """Keep native/C++ library warnings off prompt_toolkit's input screen.

        Saves the actual OS stderr fd; Python logger streams bound to fd 2 and
        native library output go to a private append-only diagnostic file.
        Never touch stdout, which prompt_toolkit needs for full-screen drawing.
        """
        if os.name != "nt" or not sys.stderr.isatty():
            return
        try:
            root = Path(os.environ.get("APPDATA") or str(Path.home())) / "StuddyBuddy" / "logs"
            root.mkdir(parents=True, exist_ok=True)
            target = os.open(str(root / "terminal-stderr.log"),
                             os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
            backup = os.dup(2)
            try:
                sys.stderr.flush()
                os.dup2(target, 2)
            except Exception:
                os.close(backup)
                raise
            self._stderr_saved_fd = backup
            self._stderr_log_fd = target
            self.events.append("Logg: externa varningar går till " + str(root))
        except (OSError, ValueError):
            self.events.append("Varning: stderr kunde inte isoleras")

    def _restore_stderr(self) -> None:
        if self._stderr_saved_fd is not None:
            try:
                sys.stderr.flush()
                os.dup2(self._stderr_saved_fd, 2)
            except (OSError, ValueError):
                pass
            finally:
                os.close(self._stderr_saved_fd)
                self._stderr_saved_fd = None
        if self._stderr_log_fd is not None:
            os.close(self._stderr_log_fd)
            self._stderr_log_fd = None

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
        try:
            config = getattr(self.app, "settings", None)
            if config is not None:
                self._cached_free_only = bool(
                    await asyncio.to_thread(config.get, "free_only", True))
        except (OSError, ValueError, sqlite3.DatabaseError):
            pass
        try:
            from genesis_playbooks import PlaybookStore
            self._cached_playbooks = await asyncio.to_thread(lambda: PlaybookStore().count())
        except (OSError, ValueError, sqlite3.DatabaseError):
            self._cached_playbooks = 0
        self._refresh()

    def _compact_side_text(self) -> list[tuple[str, str]]:
        """Short, scannable operator dashboard; no blocking I/O or fake metrics.

        Full legacy metrics are still available with F3, details with F2.
        The renderer only reads existing in-memory fields; no filesystem,
        model calls or Windows UI automation on the keystroke path.
        """
        stamp = time.monotonic()
        if not self._side_dirty and stamp - self._side_cache_at < 0.75:
            return self._side_cache
        self._side_dirty = False
        self._side_cache_at = stamp
        rows: list[tuple[str, str]] = []
        def add(text: str, style: str = "") -> None:
            rows.append((style, clean_line(text, 43) + "\n"))
        app = self.app
        running = bool(getattr(app, "current_run", None))
        add("● " + ("ARBETAR" if running else "VAKEN · VÄNTAR"),
            "bold #ff8fc5")
        add("UI  " + LIVE_PANEL_BUILD, "#baf3d2")
        add("MODEL  kilo-auto/free" if self._cached_free_only else
            "MODEL  anpassad rollrouting", "#f0c0d8")
        level = self._cached_level.get("level")
        stage, stage_name = companion_stage(level)
        for line in pixel_companion("working" if running else "awake",
                                    int(time.time() / 2), level):
            add(line, "#ff8fc5")
        add("PIXELKOMPIS  " + stage_name + f"  {stage+1}/5", "bold #ffffff")
        add("──────────────────────────────────", "#633958")
        add("UPPGIFT  " + ("PÅGÅR" if running else self._run_state), "bold #80f4b2")
        add("Senaste: " + clean_line(self.goal or "Ingen uppgift", 33), "#ffffff")
        add("VERKTYG  OK " + str(self._tool_successes) +
            "  FEL " + str(self._tool_failures), "#baf3d2")
        add("KONTROLLERAT  " + str(self._verified_work) +
            "  EJ KONTROLL  " + str(self._unverified_work), "#f0c0d8")
        if self._waiting_for_response:
            elapsed = time.monotonic() - self._waiting_started
            add(f"AI väntar/svarar: {elapsed:.1f}s", "#ffcbac")
        elif self._last_model_delay:
            add(f"Senaste AI-körning: {self._last_model_delay:.1f}s", "#c7b6dc")
        if self._last_queue_delay:
            add(f"Enter till köläsning: {self._last_queue_delay:.2f}s",
                "#ffcbac" if self._last_queue_delay > 0.35 else "#baf3d2")
        add("──────────────────────────────────", "#633958")
        add("ARBETSSÄTT   F2 detaljer · F3 allt", "#ff90c8")
        if self.show_thinking:
            add("MÅL  " + clean_line(self.goal or "Redo för ny uppgift", 35))
            add("GÖR  " + clean_line(self.action_title or self.phase, 35))
            add("VARFÖR  " + clean_line(self.action_reason or
                                      "Inget verktygsbeslut ännu", 34),
                "#f2c6dc")
            if self.action_result:
                add("RESULTAT  " + clean_line(self.action_result, 33), "#c9e6d3")
        add("──────────────────────────────────", "#633958")
        history = self._experience_snapshot
        if history:
            add("HISTORIK  " + str(history.get("total", 0)) + " verktygssteg",
                "#baf3d2")
            add("PLAYBOOKS  " + str(self._cached_playbooks) + " verifierade",
                "#baf3d2")
        if isinstance(level, (int, float)):
            add("AI LEVEL  " + str(max(1, min(100, int(level)))) + "/100",
                "#ffffff")
            progress = evidence_progress(self._cached_level)
            if progress.get("measured") and not progress.get("complete"):
                add("Nästa nivå  " + str(progress.get("target", "?")) +
                    (" · kvalitet krävs" if progress.get("quality_limited")
                     else " · mer evidens krävs"), "#baf3d2")
        else:
            add("AI LEVEL  inväntar mätning", "#829c91")
        if self._last_tool_error:
            add("SENASTE FEL  " + clean_line(self._last_tool_error, 28),
                "#ff9ba6")
        add("SENASTE HÄNDELSER", "bold #ff90c8")
        for event in list(self.events)[-3:]:
            add("• " + clean_line(event, 39), "#d4bbcb")
        self._side_cache = rows
        return rows

    def _side_text(self) -> list[tuple[str, str]]:
        if self.compact_mode:
            return self._compact_side_text()
        stamp = time.monotonic()
        if not self._side_dirty and stamp - self._side_cache_at < 1.0:
            return self._side_cache
        self._side_dirty = False
        self._side_cache_at = stamp
        app = self.app
        current = time.time()
        lines: list = []
        def add(value: str, style: str = "") -> None:
            lines.append((style, clean_line(value, 43) + "\n"))
        def detail(value: str, style: str = "", max_lines: int = 2) -> None:
            # Wrap real reasons/errors without leaking a long tool transcript or
            # pushing the entire sidebar off-screen.
            normalized = clean_line(value, 180)
            wrapped = textwrap.wrap(normalized, width=42, break_long_words=False,
                                    break_on_hyphens=False)
            for item in wrapped[:max_lines]:
                lines.append((style, item + "\n"))

        running = bool(app.current_run) or bool(getattr(getattr(app, "tasks", None), "current", {}))
        comp = self._cached_companion
        enabled = self._cached_companion_enabled
        observing = bool(enabled and comp and comp.captures > 0 and
                         current - comp.last_capture_at < 90)
        mode = ("ARBETAR" if running else "OBSERVERAR" if observing
                else "VAKEN · VÄNTAR" if enabled else "SOVER")
        add("● " + mode, "bold #ff72b6" if running or observing else "#ffffff")
        add("UI  " + LIVE_PANEL_BUILD, "#baf3d2")
        # Show the actual model policy; do not claim model IQ or run a costly
        # network model discovery call during redraw.
        free_only = self._cached_free_only
        if free_only:
            add("MODELL: kilo-auto/free · FREE ONLY", "#ffcbac")
        else:
            add("MODELL: val via roll-routing", "#baf3d2")
        sprite_mode = ("working" if running else "observing" if observing
                       else "awake" if enabled else "sleeping")
        level = self._cached_level.get("level")
        stage, stage_name = companion_stage(level)
        for frame in pixel_companion(sprite_mode, int(current // 2), level):
            add(frame, "#ff8fc5")
        add(f"Pixelkompis · {stage_name} · {stage+1}/5", "#ffffff")
        add(companion_personality(sprite_mode, level,
                                  self.trace[-1][1] if self.trace else None), "#ffcae6")
        # No fake animation: progress derives solely from finished tool calls.
        add("── PROGRESS CORE ──", "#ff90c8")
        add("│ SESSION: " + self._run_state, "#ffcae6")
        add(f"│ AI-SVAR {self._answers_delivered} · KONTROLLERADE {self._verified_work}", "#ffffff")
        if self._unverified_work:
            add(f"│ EJ VERIFIERADE UPPGIFTER {self._unverified_work}", "#ffcbac")
        pending = bool(self.trace and self.trace[-1][1] is None)
        if pending:
            core_state, core_style = "◉ VERKTYG ARBETAR", "bold #ff8fc5"
        elif self._last_tool_event_at == 0:
            core_state, core_style = "◎ VÄNTAR PÅ RESULTAT", "#cdb3c4"
        elif self._progress_phase == "FAIL":
            core_state, core_style = "✕ STEGET MISSLYCKADES", "#ff9ba6"
        else:
            core_state, core_style = "✓ STEGET LYCKADES", "#9bcfb1"
        add("│ " + core_state, core_style)
        recent = list(self._progress_outcomes)
        if recent:
            ratio = sum(recent) / len(recent)
            filled = max(0, min(14, round(14 * ratio)))
            add("│ UTFALL [" + "█" * filled + "░" * (14-filled) + "]", "#9bcfb1")
            add("│ SENASTE " + "".join("●" if x else "×" for x in recent), "#ffb6dc")
        else:
            add("│ UTFALL [░░░░░░░░░░░░░░]", "#a795a6")
            add("│ SENASTE · inga mätta steg", "#bca8bc")
        add(f"│ VERKTYG ✓ {self._tool_successes}  ✕ {self._tool_failures}", "#ffffff")
        add(f"│ SVIT {self._tool_streak}  REKORD {self._best_tool_streak}", "#ffcae6")
        if self._last_tool_success_at:
            age = max(0, int(stamp - self._last_tool_success_at))
            add(f"│ SENAST LYCKAT {age}s sedan", "#d9b7cf")
        else:
            add("│ SENAST LYCKAT · ännu inget", "#d9b7cf")
        add("   Bara faktiska verktygshändelser", "#a795a6")
        add("Verktygsutfall ≠ verifierad AI-level", "#a795a6")
        lines.append(("bold #ff90c8", "MIN ARBETSPLAN · " + ("DÖLJ" if self.show_thinking else "VISA") + " / F2\n", self._side_click))
        if self.show_thinking:
            add("01  MÅL", "bold #ff8fc5")
            detail(self.goal or "Väntar på din nästa uppgift", "#ffffff", max_lines=3)
            add("02  VAD JAG GÖR", "bold #ff8fc5")
            detail(self.action_title or self.phase, "#ffffff", max_lines=2)
            add("03  VARFÖR DETTA STEG", "bold #ff8fc5")
            detail(self.action_reason or
                   "Inget verktygsbeslut registrerat ännu.", "#f8c6e3", max_lines=3)
            add("04  HUR JAG KONTROLLERAR", "bold #ff8fc5")
            detail(self.action_expect or
                   "Väntar på ett resultat att kontrollera.", "#d9b7cf", max_lines=2)
            add("05  FAKTISKT RESULTAT", "bold #ff8fc5")
            detail(self.action_result or "Pågår / ännu inget resultat.", "#ffffff", max_lines=3)
            if self.action_evidence:
                add("Händelse-ID: " + self.action_evidence, "#9bcfb1")
            if self._last_tool_error:
                add("SENASTE FEL:", "#ff9ba6")
                detail(self._last_tool_error, "#ff9ba6", max_lines=2)
            add("── HÄNDELSER · LIVE ──", "#ff8fc5")
            for item in list(self.events)[-4:]:
                detail(" • " + item, "#cfb5c6", max_lines=2)
        else:
            detail(self.action_title or self.phase, "#f8c6e3", max_lines=2)
            if self.action_result:
                detail(self.action_result, "#ffffff", max_lines=2)
            if self._last_tool_error:
                add("SENASTE FEL:", "#ff9ba6")
                detail(self._last_tool_error, "#ff9ba6", max_lines=2)

        add("── EVOLUTION · SKILL MAP ──", "#80f4b2")
        for skill, (won, lost) in self._skill_checks.items():
            total = won + lost
            if total:
                # Ratio describes completed tool calls, not level or mastery.
                blocks = round(8 * won / total)
                add(f"│ {skill:<8} {'#' * blocks}{'-' * (8-blocks)} {won}/{total}", "#baf3d2")
            else:
                add(f"│ {skill:<8} -------- --", "#839e92")
        add("│ Staplar = andel OK, antal till höger", "#92aea3")
        add("   Inga nivåer från animationer", "#80f4b2")
        history = self._experience_snapshot
        if history:
            add("── GENESIS · MELLAN SESSIONER ──", "bold #80f4b2")
            add(f"Historiska verktygssteg: {history['total']}", "#baf3d2")
            trend = history.get("trend_pp")
            if trend is None:
                add("Veckotrend: underlag saknas", "#829c91")
            else:
                add(f"Veckotrend: {trend:+.1f} procentenheter", "#baf3d2" if trend >= 0 else "#ff9ba6")
            practice = history.get("needs_practice")
            if practice:
                add("Öva mer på: " + practice, "#f2c78f")
            add("Historik ≠ bevisad intelligens", "#829c91")
            # Only mature, repeatedly verified workflow patterns count as
            # suggested playbooks. They never execute from this status panel.
            add(f"Verifierade playbooks: {self._cached_playbooks}", "#baf3d2")
        add("EVOLUTION · SENASTE HÄNDELSER", "bold #ff90c8")
        if self._evolution_timeline:
            for when, label in reversed(self._evolution_timeline):
                add(f"{when} · {label}", "#c9e6d3")
        else:
            add("Ännu inga avslutade händelser", "#91a89d")

        # Never re-read SQLite inside prompt_toolkit rendering.
        if stamp - self._level_checked_at >= 45:
            self._level_checked_at = stamp
            try:
                loop = asyncio.get_running_loop()
                if self._level_task is None or self._level_task.done():
                    self._level_task = loop.create_task(self._refresh_level())
            except RuntimeError:
                pass
        if isinstance(level, (int, float)):
            value = max(0, min(100, int(level)))
            add("AI LEVEL: " + str(value) + "/100", "bold #ffffff")
            add("●" * round(value/5) + "○" * (20 - round(value/5)), "#ff76b7")
            progress = evidence_progress(self._cached_level)
            if progress.get("complete"):
                add("MAX LEVEL · verifierad", "#ffffff")
            elif progress.get("measured"):
                add("Nästa LVL " + str(progress["target"]), "#ffffff")
                if progress.get("quality_limited"):
                    add("Kräver bättre resultat", "#ffd0e6")
                else:
                    add("Evidens " + str(progress["events"]) + "/" +
                        str(progress["required"]) + " · -" + str(progress["remaining"]), "#ffffff")
                    total = max(1, progress["required"])
                    dots = round(16 * min(1.0, progress["events"] / total))
                    add("Mot nästa nivå [" + "#" * dots + "-" * (16-dots) + "]", "#80f4b2")
            else:
                add("Nivåunderlag saknas", "#ffffff")
        else:
            add("AI LEVEL: väntar på mätning", "#ffffff")

        rows = measured_axis_rows(self._cached_level)
        if rows:
            add("── KAPACITET · MÄTBARA AXELVÄRDEN ──", "bold #80f4b2")
            known = [(name, val) for _, name, val in rows if val is not None]
            for key, name, val in rows:
                if val is None:
                    add(f"{key} {name:<13} INGET UNDERLAG", "#829c91")
                else:
                    filled = round(8 * val)
                    add(f"{key} {name:<13} {'#' * filled}{'·' * (8-filled)} {val:.0%}",
                        "#a7f1c8" if val >= .7 else "#f2c78f")
            if known:
                weakest, score = min(known, key=lambda pair: pair[1])
                add(f"FOKUS: {weakest} · {score:.0%}", "#ffcae6")
                focus = evidence_focus(self._cached_level)
                if focus:
                    add("NÄSTA TEST: " + focus[1], "#baf3d2")

        add("── MARKERING + RÖST ──", "#ff90c8")
        bridge = getattr(app, "selection_bridge", None)
        add("MARKERA: " + (bridge.status if bridge else "OFF"), "#ffffff")
        if bridge and getattr(bridge, "auto_task", None) is not None:
            add("AUTO: markerad text · aktiv", "#ff8fc5")
        selected = getattr(app, "last_selection", None)
        if selected and current - selected.get("created", 0) < 900:
            add("Text: " + str(len(selected.get("text", ""))) + " tecken", "#ffcae6")
            add("Från: " + clean_line(selected.get("app", ""), 20), "#ffffff")
        voice = getattr(app, "voice", None)
        add("RÖST: " + (voice.state_label() if voice else "OFF"), "#ffffff")
        if voice and not voice.running and voice.error:
            add("Röstfel: " + clean_line(voice.error, 100), "#ff9ba6")
        add("── COMPANION ──", "#ff90c8")
        add("COMPANION: " + ("LIVE" if enabled else "OFF"), "#ffffff")
        if enabled and comp:
            options = self._cached_companion_options
            add("Nästa tick: " + remaining_seconds(comp.last_tick_at,
                float(options.get("tick_seconds", 30)), current), "#ffffff")
            add("Skärm: " + str(comp.captures) + " lyckade", "#ffffff")
            add("Senaste: " + clean_line(comp.last_capture_note, 25), "#d4b7c9")
        else:
            add("Inga observationer aktiva", "#d4b7c9")


        add("AKTIVITET · VERKTYG", "bold #ff90c8")
        if self.trace:
            for label, ok, _when in list(self.trace)[-4:]:
                icon = "✓" if ok is True else "✕" if ok is False else "›"
                add(" " + icon + " " + clean_line(label, 30), "#ffffff")
        else:
            add(" Inga verktyg körda", "#bca8bc")
        add("Beslut och verktyg · ingen påhittad tankekedja", "#d4b7c9")
        self._side_cache = lines
        return lines

    async def _record_tool_experience(self, category: str, ok: bool) -> None:
        def persist() -> dict | None:
            if self._experience is None:
                return None
            self._experience.record(category, ok)
            return self._experience.snapshot()
        try:
            snapshot = await asyncio.to_thread(persist)
            if snapshot is not None:
                self._experience_snapshot = snapshot
                self._refresh()
        except (OSError, ValueError, RuntimeError, sqlite3.DatabaseError):
            pass  # Telemetry must never block a human message.

    # Below methods become overrides on an actual CLI subclass.
    def _out(self, text: str) -> None:
        self._panel_state._add(text)

    def status(self, text: str) -> None:
        panel = self._panel_state
        panel.phase = clean_line(text, 44)
        panel.events.append(datetime.now().strftime("%H:%M:%S") + " · " + panel.phase)
        panel._refresh()

    def explain_action(self, goal: str, action: str, reason: str, expect: str) -> None:
        """Structured, user-facing decision summary, never private model reasoning."""
        panel = self._panel_state
        panel.goal = clean_line(goal, 240)
        panel.action_title = clean_line(action, 180)
        panel.action_reason = clean_line(reason, 240)
        panel.action_expect = clean_line(expect, 180)
        panel.action_result = ("Analyserar din fråga; inget verktygsresultat ännu."
                               if action == "Analyserar din fråga"
                               else "Verktyget körs – resultat ej klart.")
        panel._run_state = "ARBETAR"
        panel._run_state_detail = panel.action_title
        panel.action_evidence = ""
        panel.action_started = time.monotonic()
        panel.events.append(datetime.now().strftime("%H:%M:%S") +
                            " · Start: " + panel.action_title)
        panel._refresh()

    def explain_result(self, ok: bool, evidence_id: str, observation: bool,
                       effect: bool, category: str = "") -> None:
        panel = self._panel_state
        elapsed = max(0, time.monotonic() - panel.action_started) if panel.action_started else 0.0
        if ok:
            if effect and not observation:
                note = "Åtgärd lyckades; kontroll behövs för att bekräfta effekten."
            elif observation:
                note = "Verktyget läste tillbaka underlag för kontroll."
            else:
                note = "Verktyget avslutades utan rapporterat fel."
        else:
            note = "Steget misslyckades; se senaste fel nedan."
        panel.action_result = f"{note} ({elapsed:.1f}s)"
        panel.action_evidence = clean_line(evidence_id, 30) if ok else ""
        panel.events.append(datetime.now().strftime("%H:%M:%S") +
                            " · " + ("✓ " if ok else "✕ ") + panel.action_result)
        panel._refresh()

    def step(self, text: str) -> None:
        panel = self._panel_state
        panel.tool = clean_line(text, 150)
        panel.phase = "Kör verktyg"
        panel.action_result = "Verktyget körs – inväntar faktiskt resultat."
        panel.step_time = time.monotonic()
        panel._progress_phase = "WORK"
        panel.trace.append((panel.tool, None, time.time()))
        panel._current_skill = observed_skill(panel.tool)
        panel.events.append(datetime.now().strftime("%H:%M:%S") + " · " + panel.tool)
        panel._refresh()

    def step_done(self, ok: bool, err: str = "") -> None:
        panel = self._panel_state
        if panel.trace:
            old = panel.trace.pop()
            panel.trace.append((old[0], bool(ok), old[2]))
        panel.phase = ("Steg klart" if ok else "Steg misslyckades")
        duration = max(0.0, time.monotonic() - panel.step_time)
        panel._last_tool_duration = duration
        panel._last_tool_event_at = time.monotonic()
        panel._progress_outcomes.append(bool(ok))
        category = observed_skill(panel.trace[-1][0]) if panel.trace else panel._current_skill
        counts = panel._skill_checks[category]
        counts[0 if ok else 1] += 1
        if panel._experience is not None and not getattr(getattr(panel.app, "privacy", None), "private", False):
            # SQLite disk writes used to happen synchronously in the UI event
            # callback and could block Enter/keystrokes. Record off-thread.
            try:
                loop = asyncio.get_running_loop()
                loop.create_task(panel._record_tool_experience(category, bool(ok)))
            except RuntimeError:
                pass  # No UI event loop during pure unit tests.
        panel._evolution_timeline.append((
            datetime.now().strftime("%H:%M"),
            ("✓ " if ok else "✕ ") + category + " · " + clean_line(panel.tool, 21)))
        if ok:
            panel._tool_successes += 1
            panel._tool_streak += 1
            panel._best_tool_streak = max(panel._best_tool_streak, panel._tool_streak)
            panel._last_tool_success_at = panel._last_tool_event_at
            panel._progress_phase = "SUCCESS"
        else:
            panel._tool_failures += 1
            panel._tool_streak = 0
            panel._progress_phase = "FAIL"
        panel.events.append(datetime.now().strftime("%H:%M:%S") +
            (f" · ✓ Klart efter {duration:.1f}s" if ok
             else f" · ✕ Misslyckades efter {duration:.1f}s"))
        if err and not ok:
            from buddy import redact
            panel._last_tool_error = clean_line(redact(str(err)), 110)
            panel.events.append(datetime.now().strftime("%H:%M:%S") +
                                " · Fel: " + panel._last_tool_error)
        elif ok:
            panel._last_tool_error = ""
        panel._refresh()

    def summary(self, run: Any, result: Any) -> None:
        panel = self._panel_state
        count = sum(1 for item in run.ledger if item.get("ok"))
        verified = bool(result.verified) and result.status in ("complete", "answered")
        # A fluent model answer is activity, never proof of new capability.
        delivered = result.status in ("answered", "complete")
        if delivered:
            panel._answers_delivered += 1
            panel._last_answer_at = time.monotonic()
            panel._evolution_timeline.append((datetime.now().strftime("%H:%M"), "AI-svar levererat"))
        # A failed tool cannot become a verified completed task simply because
        # a model claims success or a ledger object exists.
        independently_checked = (verified and result.status == "complete"
                                  and any(item.get("ok") is True for item in run.ledger))
        if independently_checked:
            panel._verified_work += 1
            panel._evolution_timeline.append((datetime.now().strftime("%H:%M"), "✓ Uppgift verifierad"))
            panel._run_state = "VERIFIERAD UPPGIFT"
            panel.action_result = "Uppgiften klar med registrerade verktygsresultat."
        elif verified and not run.ledger and result.status == "answered":
            panel._run_state = "AI-SVAR KLART"
            panel.action_result = "Svar levererat. Inga verktygssteg utfördes eller verifierades."
        else:
            panel._unverified_work += 1
            panel._evolution_timeline.append((datetime.now().strftime("%H:%M"), "△ Ej verifierat"))
            panel._run_state = "EJ VERIFIERAT"
            panel.action_result = "Körningen avslutad utan oberoende verifiering."
        panel.action_title = "AI-svar levererat" if not run.ledger else "Uppgift avslutad"
        panel.action_reason = ("Språkmodellen besvarade frågan direkt." if not run.ledger
                               else "Verktygsresultaten ligger till grund för svaret.")
        panel.action_expect = ("Ingen separat verktygskontroll gjord." if not run.ledger
                               else "Bedömningen bygger på registrerade verktygsresultat.")
        panel.phase = panel._run_state
        panel.events.append(datetime.now().strftime("%H:%M:%S") +
                            " · " + panel._run_state + f" · {count} lyckade verktygssteg")
        # Run metrics belong in the dedicated panel, not between messages
        # in the human conversation. Only the actual answer is chat content.
        panel._refresh()

    def event(self, text: str) -> None:
        panel = self._panel_state
        panel.phase = clean_line(text, 80)
        panel.events.append(datetime.now().strftime("%H:%M:%S") + " · " + panel.phase)
        panel._refresh()

    def prompt(self) -> None:
        self._panel_state._refresh()

    def header(self) -> None:
        self._panel_state._refresh()
