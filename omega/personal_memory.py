"""Local Obsidian-compatible, evidence-labelled screen observation notes.

This module records concise visual activity descriptions, NEVER screenshots,
keystrokes, passwords or raw browser page contents. An observation is an
unverified model interpretation, not a fact about the user's intentions.
"""
from __future__ import annotations

import datetime as dt
import hashlib
from pathlib import Path
import re
import time

_SECRET_WORDS = re.compile(
    r"(?i)\b(password|passphrase|lösenord|bankid|private browsing|incognito|"
    r"inkognito|one.time.password|security code|verification code|"
    r"personnummer|credit card|kreditkort|seed phrase|recovery phrase|api.key)\b"
)
_EMAIL = re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")
_URL_TOKEN = re.compile(r"(?i)\b(?:bearer\s+)?eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")
_LONG_NUMBER = re.compile(r"(?<!\d)\d{8,}(?!\d)")


def clean_observation(value: str) -> str:
    """Reject explicitly sensitive activity; otherwise minimise incidental identifiers."""
    text = re.sub(r"\s+", " ", str(value or "")).strip()[:1200]
    if not text or _SECRET_WORDS.search(text):
        return ""
    text = _EMAIL.sub("[email hidden]", text)
    text = _URL_TOKEN.sub("[token hidden]", text)
    text = _LONG_NUMBER.sub("[number hidden]", text)
    return text[:500]


class ObservationVault:
    """Opt-in bounded Obsidian writer. Only uses the Python standard library."""

    def __init__(self, root: Path, *, daily_cap: int = 72, same_note_cooldown: int = 900):
        self.root = Path(root).expanduser()
        self.daily_cap = daily_cap
        self.same_note_cooldown = same_note_cooldown
        self._last_digest = ""
        self._last_timestamp = 0.0

    def record(self, app_name: str, description: str, *, timestamp: float | None = None) -> tuple[bool, str, str]:
        """Return (stored, explanation, sanitized text). No guessed truth or secret logging."""
        text = clean_observation(description)
        if not text:
            return False, "empty or sensitive observation excluded", ""
        app_name = Path(str(app_name or "unknown")).name[:65]
        if _SECRET_WORDS.search(app_name):
            return False, "protected application excluded", ""
        stamp = timestamp if timestamp is not None else time.time()
        digest = hashlib.sha256((app_name.lower() + "|" + text.lower()).encode("utf-8")).hexdigest()
        if digest == self._last_digest and stamp - self._last_timestamp < self.same_note_cooldown:
            return False, "unchanged observation (deduplicated)", ""
        day = dt.datetime.fromtimestamp(stamp).strftime("%Y-%m-%d")
        folder = self.root / "observations" / day
        # Avoid an unbounded number of files even when the screen is constantly changing.
        if folder.exists() and len(list(folder.glob("*.md"))) >= self.daily_cap:
            return False, f"daily observation cap ({self.daily_cap}) reached", ""
        folder.mkdir(parents=True, exist_ok=True)
        clock = dt.datetime.fromtimestamp(stamp)
        filename = f"{int(stamp * 1000)}-{digest[:12]}.md"
        dest = folder / filename
        body = ("---\n"
                "type: observation\n"
                f"date: {clock.isoformat(timespec='seconds')}\n"
                "source: screen_vision\n"
                "confidence: unverified\n"
                "storage: local_obsidian_markdown\n"
                f"application: {re.sub(r'[^A-Za-z0-9_.-]', '_', app_name)}\n"
                "---\n\n"
                "## Observed activity\n\n"
                f"{text}\n\n"
                "> AI interpretation, not a verified fact, intention or diagnosis.\n")
        # This file contains no raw screenshot and is stored only on the owner's machine.
        try:
            with dest.open("x", encoding="utf-8") as stream:
                stream.write(body)
        except FileExistsError:
            return False, "observation already exists", ""
        self._last_digest, self._last_timestamp = digest, stamp
        return True, str(dest), text

    KNOWLEDGE_KINDS = frozenset({
        "preference", "fact", "project", "procedure", "fix", "summary",
        "correction", "long_term", "procedural", "skill", "task_outcome",
    })

    def knowledge_path(self, kind: str, title: str) -> Path:
        """Stable, scoped Markdown path; title cannot escape its vault directory."""
        digest = hashlib.sha256((kind + "|" + title.lower()).encode("utf-8")).hexdigest()[:12]
        safe_title = re.sub(r"[^A-Za-z0-9_-]", "_", title)[:48].strip("_") or "note"
        return self.root / "knowledge" / kind / f"{safe_title}-{digest}.md"

    def record_knowledge(self, kind: str, title: str, content: str,
                         confidence: str = "unverified") -> tuple[bool, str]:
        """Mirror explicitly saved durable memories, never all chat messages."""
        if kind not in self.KNOWLEDGE_KINDS:
            return False, "memory kind not eligible for knowledge vault"
        clean_title = clean_observation(title)
        clean_content = clean_observation(content)
        if not clean_title or not clean_content:
            return False, "sensitive or empty knowledge excluded"
        confidence = confidence if confidence in ("verified", "unverified", "active") else "unverified"
        path = self.knowledge_path(kind, title)
        path.parent.mkdir(parents=True, exist_ok=True)
        body = ("---\n"
                f"type: {kind}\n"
                f"confidence: {confidence}\n"
                "source: buddy_saved_memory\n"
                f"updated: {dt.datetime.now().isoformat(timespec='seconds')}\n"
                "---\n\n"
                f"# {clean_title}\n\n{clean_content}\n\n"
                "> Confirm the memory with the owner before relying on inferred preferences.\n")
        path.write_text(body, encoding="utf-8")
        return True, str(path)

    def clear_observations(self) -> int:
        """Erase only files created by this observer, never unrelated Obsidian notes."""
        folder = self.root / "observations"
        if not folder.is_dir():
            return 0
        count = 0
        for child in folder.glob("*/*.md"):
            if re.fullmatch(r"\d{13}-[0-9a-f]{12}\.md", child.name):
                child.unlink()
                count += 1
        for day in folder.iterdir():
            if day.is_dir() and not any(day.iterdir()):
                day.rmdir()
        return count
