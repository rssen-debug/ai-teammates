#!/usr/bin/env python3
"""
Legacy memory migration — one utility that inherits the owner's real history.

Omega is only as useful as what it remembers. The owner has several previous
installations on their Windows machine, each with its own storage format. This
module finds them, inspects their **actual** schemas, backs the target up,
imports compatible records without touching a single source byte, deduplicates,
preserves timestamps and provenance, validates the result, proves retrieval
works, and can roll the whole thing back.

Real formats this understands (each verified against the source in this repo):

| Source | Location | Format |
| --- | --- | --- |
| Previous/current Omega | `%APPDATA%\\StuddyBuddy\\buddy.db` | SQLite: `memories`, `runs`, `skills`, `conversation`, `summaries` |
| Old Study Buddy | `%APPDATA%\\StuddyBuddy\\studdy.db` | SQLite (node:sqlite): `concept`, `learning_evidence`, `chat_message`, `agent_task`, `misconception`, `mastery_estimate` |
| Obsidian vaults | any dir containing `.obsidian/`, plus `…\\StuddyBuddy\\Obsidian-Vault` | Markdown + YAML frontmatter |
| MAJIN V2/V5 memory | `<v5 data dir>/memory/<kind>.json` | `majin.v2.memory/v1`, kinds conversation/project/task/preference/tool-success/failure-pattern/workflow/environment |
| MAJIN V5 learned procedures | `<v5 data dir>/learned-procedures.json` | `majin.v5.learning/v1` |
| MAJIN V6 | `%LOCALAPPDATA%\\MAJIN\\v6\\…` | `majin.v6.jobs/v1`, `majin.v6.profiles/v1`, queue JSON, JSONL event log |
| MAJIN matrix workspaces | `.majin-matrix-ws-*/teams/*/memory.jsonl`, `missions/*/journal.jsonl` | JSONL |

Hard rules, enforced in code and covered by tests
-------------------------------------------------
1. Sources are opened **read-only** (SQLite `mode=ro`, files never written).
2. A verified backup of the target database is taken before any import.
3. Nothing is deleted from any source. Ever.
4. Secrets are never migrated: `provider_config`, API-key-looking values and
   anything a source marks `sensitive` are skipped, and the skip is counted.
5. Imported records land as `status='migrated'`, tagged `legacy` — old or
   unverified information never becomes trusted current fact automatically.
6. Counts are validated and retrieval is tested after import; a mismatch fails
   the migration and offers rollback.
7. Dry run is the default.

Standalone: `python omega/memory_migration.py scan|plan|run|verify|rollback`.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

IS_WIN = sys.platform == "win32"
MIGRATOR_VERSION = "1.0.0"

#: Memory kinds in the unified Omega engine. Legacy kinds are mapped onto these.
MEMORY_KINDS = ("long_term", "working", "project", "episodic", "procedural", "fix", "skill", "preference", "conversation")

#: Legacy kind → unified kind. Anything unmapped becomes `long_term`.
KIND_MAP = {
    # Omega
    "fact": "long_term", "note": "long_term", "preference": "preference", "procedure": "procedural",
    "fix": "fix", "skill": "skill", "episode": "episodic", "project": "project",
    # MAJIN v2 namespaces
    "conversation": "conversation", "task": "episodic", "tool-success": "procedural",
    "failure-pattern": "fix", "workflow": "procedural", "environment": "long_term",
    # Study Buddy
    "concept": "long_term", "learning_evidence": "episodic", "misconception": "fix",
    "mastery_estimate": "long_term", "agent_task": "episodic",
    # Obsidian
    "obsidian": "long_term",
}

#: Rows/values that must never cross the boundary.
SECRET_TABLES = {"provider_config", "secrets", "credentials", "vault", "api_keys", "tokens"}
SECRET_KEY_RE = re.compile(
    r"(?i)\b(api[_-]?key|apikey|secret|token|password|passwd|pwd|bearer|authorization|"
    r"client[_-]?secret|refresh[_-]?token|access[_-]?token|private[_-]?key|conn(?:ection)?[_-]?string)\b")
SECRET_VALUE_RE = re.compile(
    r"(sk-[A-Za-z0-9_\-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|ya29\.[A-Za-z0-9_\-]{10,}|"
    r"AIza[A-Za-z0-9_\-]{20,}|xox[baprs]-[A-Za-z0-9\-]{10,}|eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}|"
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----)")


def _now() -> float:
    return time.time()


def _iso(ts: Optional[float] = None) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts or _now()))


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()


def file_sha256(path: Path, chunk: int = 1 << 20) -> Optional[str]:
    try:
        h = hashlib.sha256()
        with path.open("rb") as fh:
            for block in iter(lambda: fh.read(chunk), b""):
                h.update(block)
        return h.hexdigest()
    except OSError:
        return None


def looks_secret(key: str = "", value: str = "") -> bool:
    """True when a field name or value is credential material."""
    if SECRET_KEY_RE.search(str(key or "")):
        return True
    return bool(SECRET_VALUE_RE.search(str(value or "")))


def redact_text(text: str) -> str:
    return SECRET_VALUE_RE.sub("[REDACTED]", str(text or ""))


def parse_iso(value: Any) -> Optional[float]:
    """Best-effort timestamp parsing that preserves original provenance times."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        v = float(value)
        return v / 1000.0 if v > 1e12 else v  # JS millis vs unix seconds
    s = str(value).strip().replace("Z", "+00:00")
    try:
        import datetime as dt
        d = dt.datetime.fromisoformat(s)
        return d.timestamp()
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d", "%d/%m/%Y"):
        try:
            import datetime as dt
            return dt.datetime.strptime(s[:19], fmt).timestamp()
        except ValueError:
            continue
    return None


# ════════════════════════════════════════════════════════════════════════════
# Records and sinks
# ════════════════════════════════════════════════════════════════════════════
@dataclass
class Record:
    """One migratable memory record, source-agnostic."""
    kind: str
    title: str
    content: str
    tags: str = ""
    status: str = "migrated"
    created: Optional[float] = None
    updated: Optional[float] = None
    source: str = ""
    source_path: str = ""
    source_id: str = ""
    extra: dict = field(default_factory=dict)

    @property
    def dedupe_key(self) -> str:
        """Stable identity: same knowledge from two installs is imported once."""
        norm = re.sub(r"\s+", " ", (self.title + "\n" + self.content).strip().lower())
        return _sha(f"{self.kind}|{norm}")[:32]

    def provenance(self) -> dict:
        return {"source": self.source, "path": self.source_path, "id": self.source_id,
                "migrated_at": _iso(), "migrator": MIGRATOR_VERSION, **self.extra}


class Sink:
    """Where records land. buddy.py supplies the real one; tests supply a fake."""

    def existing_keys(self) -> set[str]:
        raise NotImplementedError

    def save(self, rec: Record) -> int:
        raise NotImplementedError

    def count(self) -> int:
        raise NotImplementedError

    def search(self, query: str, limit: int = 5) -> list[dict]:
        raise NotImplementedError

    def snapshot_path(self) -> Optional[Path]:
        """File to back up before importing (None = nothing on disk to protect)."""
        return None


class ListSink(Sink):
    """In-memory sink used by tests and by `plan`/`scan` reporting."""

    def __init__(self) -> None:
        self.rows: list[Record] = []
        self._keys: set[str] = set()

    def existing_keys(self) -> set[str]:
        return set(self._keys)

    def save(self, rec: Record) -> int:
        self.rows.append(rec)
        self._keys.add(rec.dedupe_key)
        return len(self.rows)

    def count(self) -> int:
        return len(self.rows)

    def search(self, query: str, limit: int = 5) -> list[dict]:
        q = query.lower()
        hits = [r for r in self.rows if q in r.title.lower() or q in r.content.lower() or q in r.tags.lower()]
        return [{"title": r.title, "content": r.content[:200], "kind": r.kind} for r in hits[:limit]]


# ════════════════════════════════════════════════════════════════════════════
# Sources
# ════════════════════════════════════════════════════════════════════════════
@dataclass
class SourceReport:
    name: str
    found: bool
    path: str = ""
    schema: str = ""
    detail: str = ""
    records: int = 0
    skipped_secret: int = 0
    error: str = ""


class Source:
    """A legacy installation. `discover` finds it, `records` reads it read-only."""

    name = "source"

    #: how many records this source withheld because they were credential
    #: material. Sources filter at read time (defence in depth); the count is
    #: surfaced so the owner can see that secrets were found and refused,
    #: rather than silently never arriving.
    secret_skips = 0

    def __init__(self, roots: Optional[dict] = None):
        self.roots = roots or discover_roots()
        self.secret_skips = 0

    def _withhold_secret(self) -> None:
        self.secret_skips += 1

    def discover(self) -> list[SourceReport]:
        raise NotImplementedError

    def records(self) -> Iterable[Record]:
        raise NotImplementedError


def _ro(uri_path: Path) -> str:
    """SQLite URI that cannot write, even if a query tried to."""
    return "file:" + uri_path.as_posix().replace("?", "%3F").replace("#", "%23") + "?mode=ro"


def open_ro_db(path: Path) -> Optional[sqlite3.Connection]:
    """Open a SQLite file strictly read-only, or return None.

    `sqlite3.connect` does not validate the header, so a text file that is not a
    database would connect happily and then fail on the first query. We probe it
    here so callers can report "not a database" instead of an empty result.
    """
    try:
        conn = sqlite3.connect(_ro(path), uri=True, timeout=5)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only=ON")
        conn.execute("SELECT count(*) FROM sqlite_master")
        return conn
    except sqlite3.Error:
        try:
            conn.close()  # type: ignore[possibly-undefined]
        except Exception:
            pass
        return None


def db_tables(conn: sqlite3.Connection) -> list[str]:
    try:
        return [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    except sqlite3.Error:
        return []


def db_columns(conn: sqlite3.Connection, table: str) -> list[str]:
    try:
        return [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]
    except sqlite3.Error:
        return []


# ── real storage locations on the owner's machine ───────────────────────────
def discover_roots(override: Optional[dict] = None) -> dict:
    """Every plausible legacy home, from environment — never a hardcoded user path."""
    override = override or {}
    home = Path.home()
    appdata = Path(os.environ.get("APPDATA") or (home / "AppData" / "Roaming")) if IS_WIN else Path(os.environ.get("XDG_DATA_HOME") or (home / ".local" / "share"))
    local = Path(os.environ.get("LOCALAPPDATA") or (home / "AppData" / "Local")) if IS_WIN else appdata
    docs = Path(os.environ.get("USERPROFILE") or str(home)) / "Documents" if IS_WIN else home / "Documents"
    roots = {
        "omega_home": Path(override.get("omega_home") or os.environ.get("BUDDY_HOME") or (appdata / "StuddyBuddy")),
        "studdy_home": Path(override.get("studdy_home") or os.environ.get("STUDDY_DATA_DIR") or (appdata / "StuddyBuddy")),
        "majin_v5": Path(override.get("majin_v5") or os.environ.get("MAJIN_V5_DATA_DIR")
                         or ((local / "MAJIN" / "v5") if IS_WIN else (home / ".majin" / "v5"))),
        "majin_v6": Path(override.get("majin_v6") or os.environ.get("MAJIN_V6_HOME") or (local / "MAJIN" / "v6")),
        "documents": Path(override.get("documents") or docs),
        "home": home,
        "repo": Path(override.get("repo") or Path(__file__).resolve().parents[1]),
    }
    return roots


class OmegaDbSource(Source):
    """Previous Omega: `%APPDATA%\\StuddyBuddy\\buddy.db`."""

    name = "omega-db"

    def __init__(self, roots=None, db_path: Optional[Path] = None):
        super().__init__(roots)
        self.db_path = db_path

    def _paths(self) -> list[Path]:
        if self.db_path:
            return [self.db_path]
        return [self.roots["omega_home"] / "buddy.db"]

    def discover(self) -> list[SourceReport]:
        out = []
        for p in self._paths():
            if not p.is_file():
                out.append(SourceReport(self.name, False, str(p), detail="not present on this machine"))
                continue
            conn = open_ro_db(p)
            if conn is None:
                out.append(SourceReport(self.name, True, str(p), error="unreadable or not a SQLite database"))
                continue
            tables = db_tables(conn)
            n = 0
            try:
                if "memories" in tables:
                    n = conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
            except sqlite3.Error:
                pass
            runs = 0
            try:
                if "runs" in tables:
                    runs = conn.execute("SELECT COUNT(*) FROM runs WHERE verified=1").fetchone()[0]
            except sqlite3.Error:
                pass
            conn.close()
            out.append(SourceReport(self.name, True, str(p), schema="omega sqlite: " + ",".join(sorted(tables)[:8]),
                                    records=n, detail=f"{n} memories, {runs} verified runs"))
        return out

    def records(self) -> Iterable[Record]:
        for p in self._paths():
            if not p.is_file():
                continue
            conn = open_ro_db(p)
            if conn is None:
                continue
            try:
                tables = db_tables(conn)
                if "memories" in tables:
                    cols = set(db_columns(conn, "memories"))
                    for row in conn.execute("SELECT * FROM memories"):
                        d = dict(row)
                        content = str(d.get("content") or "")
                        title = str(d.get("title") or "")
                        if looks_secret(title, content):
                            self._withhold_secret()
                            continue
                        yield Record(kind=KIND_MAP.get(str(d.get("kind") or "").lower(), "long_term"),
                                     title=title[:300] or "untitled", content=content,
                                     tags=str(d.get("tags") or ""),
                                     status="migrated",
                                     created=parse_iso(d.get("created")) if "created" in cols else None,
                                     updated=parse_iso(d.get("updated")) if "updated" in cols else None,
                                     source=self.name, source_path=str(p), source_id=str(d.get("id") or ""),
                                     extra={"legacy_status": d.get("status"), "uses": d.get("uses"),
                                            "source_run": d.get("source_run")})
                # Verified task history is exactly the "verified experience" the
                # owner wants carried forward — imported as episodic evidence.
                if "runs" in tables:
                    for row in conn.execute("SELECT * FROM runs WHERE verified=1"):
                        d = dict(row)
                        summary = str(d.get("summary") or "")
                        yield Record(kind="episodic", title=f"verified run: {str(d.get('goal') or '')[:120]}",
                                     content=summary or str(d.get("goal") or ""), tags="verified,legacy-run",
                                     created=parse_iso(d.get("ts")), updated=parse_iso(d.get("ts")),
                                     source=self.name, source_path=str(p), source_id=str(d.get("id") or ""),
                                     extra={"steps": d.get("steps"), "status": d.get("status")})
                if "skills" in tables:
                    for row in conn.execute("SELECT * FROM skills"):
                        d = dict(row)
                        if str(d.get("state") or d.get("status") or "").lower() not in ("approved", "active", ""):
                            continue
                        yield Record(kind="skill", title=f"skill: {d.get('name')}",
                                     content=str(d.get("description") or ""), tags="skill,legacy",
                                     created=parse_iso(d.get("created")), updated=parse_iso(d.get("updated")),
                                     source=self.name, source_path=str(p), source_id=str(d.get("name") or ""),
                                     extra={"version": d.get("version")})
                if "summaries" in tables:
                    for row in conn.execute("SELECT * FROM summaries"):
                        d = dict(row)
                        text = str(d.get("content") or "").strip()
                        if not text:
                            continue
                        yield Record(kind="conversation", title="earlier conversation summary",
                                     content=text, tags="summary,legacy", created=parse_iso(d.get("ts")),
                                     source=self.name, source_path=str(p), source_id=str(d.get("id") or ""))
            finally:
                conn.close()


class StuddyDbSource(Source):
    """Old Study Buddy (TypeScript, node:sqlite): `studdy.db` in the same folder."""

    name = "studdy-db"

    def __init__(self, roots=None, db_path: Optional[Path] = None):
        super().__init__(roots)
        self.db_path = db_path

    def _paths(self) -> list[Path]:
        if self.db_path:
            return [self.db_path]
        cands = [self.roots["studdy_home"] / "studdy.db"]
        if not IS_WIN:
            cands.append(Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")) / "studdy-buddy" / "studdy.db")
        return cands

    #: table → (title column candidates, body column candidates, unified kind)
    PLAN = {
        "concept": (["name", "title"], ["summary", "definition", "notes"], "long_term"),
        "learning_evidence": (["concept_id", "id"], ["detail", "note", "evidence"], "episodic"),
        "misconception": (["concept_id", "id"], ["text", "description", "correction"], "fix"),
        "mastery_estimate": (["concept_id"], ["level", "estimate"], "long_term"),
        "chat_message": (["role"], ["content"], "conversation"),
        "agent_task": (["title", "id"], ["result", "summary", "plan"], "episodic"),
        "observation_event": (["app", "title"], ["detail"], "episodic"),
        "study_session": (["id"], ["summary", "notes"], "episodic"),
    }

    def discover(self) -> list[SourceReport]:
        out = []
        seen = set()
        for p in self._paths():
            if str(p) in seen:
                continue
            seen.add(str(p))
            if not p.is_file():
                out.append(SourceReport(self.name, False, str(p), detail="not present on this machine"))
                continue
            conn = open_ro_db(p)
            if conn is None:
                out.append(SourceReport(self.name, True, str(p), error="unreadable or not a SQLite database"))
                continue
            tables = db_tables(conn)
            known = [t for t in self.PLAN if t in tables]
            total = 0
            for t in known:
                try:
                    total += conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                except sqlite3.Error:
                    pass
            conn.close()
            secret_tables = sorted(t for t in tables if t.lower() in SECRET_TABLES)
            out.append(SourceReport(self.name, True, str(p), schema="studdy sqlite: " + ",".join(sorted(tables)[:10]),
                                    records=total,
                                    detail=f"{total} rows across {known or 'no known tables'}"
                                           + (f"; EXCLUDED secret tables: {secret_tables}" if secret_tables else "")))
        return out

    def records(self) -> Iterable[Record]:
        seen = set()
        for p in self._paths():
            if str(p) in seen or not p.is_file():
                continue
            seen.add(str(p))
            conn = open_ro_db(p)
            if conn is None:
                continue
            try:
                tables = set(db_tables(conn))
                for table, (title_cols, body_cols, kind) in self.PLAN.items():
                    if table not in tables or table.lower() in SECRET_TABLES:
                        continue
                    cols = db_columns(conn, table)
                    if not cols:
                        continue
                    time_col = next((c for c in ("created_at", "createdAt", "ts", "updated_at", "at", "started_at") if c in cols), None)
                    try:
                        rows = list(conn.execute(f"SELECT * FROM {table} LIMIT 20000"))
                    except sqlite3.Error:
                        continue
                    for row in rows:
                        d = dict(row)
                        title = next((str(d[c]) for c in title_cols if c in d and d[c] not in (None, "")), "")
                        body = " ".join(str(d[c]) for c in body_cols if c in d and d[c] not in (None, ""))
                        if not body and not title:
                            continue
                        if looks_secret(title, body):
                            self._withhold_secret()
                            continue
                        yield Record(kind=kind, title=f"{table}: {title[:120]}" if title else table,
                                     content=body[:20000] or title, tags=f"{table},legacy",
                                     created=parse_iso(d.get(time_col)) if time_col else None,
                                     updated=parse_iso(d.get(time_col)) if time_col else None,
                                     source=self.name, source_path=str(p),
                                     source_id=str(d.get("id") if "id" in d else title),
                                     extra={"table": table})
            finally:
                conn.close()


class ObsidianSource(Source):
    """Obsidian vaults: Markdown with optional YAML frontmatter.

    A vault is any directory containing `.obsidian/`, plus the Study Buddy
    generated vault. Notes are read, never modified.
    """

    name = "obsidian"
    FRONT_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)

    def __init__(self, roots=None, vaults: Optional[list[Path]] = None, max_notes: int = 20000, max_bytes: int = 2_000_000):
        super().__init__(roots)
        self._vaults = vaults
        self.max_notes = max_notes
        self.max_bytes = max_bytes

    def find_vaults(self) -> list[Path]:
        if self._vaults is not None:
            return [v for v in self._vaults if v.is_dir()]
        found: list[Path] = []
        seen: set[str] = set()
        search_roots = [self.roots["studdy_home"] / "Obsidian-Vault", self.roots["documents"],
                        self.roots["home"] / "Documents", self.roots["home"]]
        env_vault = os.environ.get("OBSIDIAN_VAULT")
        if env_vault:
            search_roots.insert(0, Path(env_vault).expanduser())
        for root in search_roots:
            if not root or not root.is_dir():
                continue
            if (root / ".obsidian").is_dir() and str(root) not in seen:
                seen.add(str(root))
                found.append(root)
            # Bounded walk: vaults live shallow; never crawl the whole profile.
            try:
                for dirpath, dirnames, _files in os.walk(root):
                    here = Path(dirpath)
                    depth = len(here.relative_to(root).parts)
                    # The vault marker is a dot-directory, so it must be tested
                    # BEFORE hidden entries are pruned from the walk.
                    if ".obsidian" in dirnames and str(here) not in seen:
                        seen.add(str(here))
                        found.append(here)
                        dirnames[:] = []          # do not descend into a vault's subvaults
                    elif depth >= 4:
                        dirnames[:] = []
                    else:
                        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in
                                       ("node_modules", "AppData", ".git", "venv", ".venv", "__pycache__")]
                    if len(found) >= 25:
                        return found
            except OSError:
                continue
        return found

    def discover(self) -> list[SourceReport]:
        vaults = self.find_vaults()
        if not vaults:
            return [SourceReport(self.name, False, str(self.roots["documents"]),
                                 detail="no Obsidian vault found (looked for a .obsidian/ folder)")]
        out = []
        for v in vaults:
            notes = [p for p in v.rglob("*.md") if p.is_file()][: self.max_notes]
            out.append(SourceReport(self.name, True, str(v), schema="markdown+frontmatter",
                                    records=len(notes), detail=f"{len(notes)} notes"))
        return out

    def records(self) -> Iterable[Record]:
        for v in self.find_vaults():
            count = 0
            for p in sorted(v.rglob("*.md")):
                if count >= self.max_notes:
                    return
                if not p.is_file():
                    continue
                try:
                    if p.stat().st_size > self.max_bytes:
                        continue
                    raw = p.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                count += 1
                meta: dict[str, Any] = {}
                m = self.FRONT_RE.match(raw)
                body = raw[m.end():] if m else raw
                if m:
                    for line in m.group(1).splitlines():
                        if ":" in line:
                            k, _, val = line.partition(":")
                            meta[k.strip().lower()] = val.strip().strip("'\"")
                title = str(meta.get("title") or p.stem).strip()[:300]
                text = body.strip()
                if not text:
                    continue
                if looks_secret(title, text[:2000]):
                    self._withhold_secret()
                    continue
                tags = meta.get("tags") or ""
                if isinstance(tags, str):
                    tags = tags.strip("[]").replace(",", " ")
                st = p.stat()
                yield Record(kind=KIND_MAP.get(str(meta.get("kind") or "").lower(), "long_term"),
                             title=title, content=text[:60000],
                             tags=" ".join([t for t in [str(tags), "obsidian", v.name] if t]).strip(),
                             created=parse_iso(meta.get("created") or meta.get("date")) or st.st_ctime,
                             updated=parse_iso(meta.get("updated") or meta.get("modified")) or st.st_mtime,
                             source=self.name, source_path=str(p), source_id=_sha(str(p))[:16],
                             extra={"vault": str(v), "frontmatter_keys": sorted(meta)[:10]})


class MajinMemorySource(Source):
    """MAJIN V2/V5 namespaced memory: `<v5>/memory/<kind>.json` (`majin.v2.memory/v1`)."""

    name = "majin-memory"

    def __init__(self, roots=None, memory_dir: Optional[Path] = None):
        super().__init__(roots)
        self.memory_dir = memory_dir

    def _dir(self) -> Path:
        return self.memory_dir or (self.roots["majin_v5"] / "memory")

    def discover(self) -> list[SourceReport]:
        d = self._dir()
        if not d.is_dir():
            return [SourceReport(self.name, False, str(d), detail="no MAJIN V5 memory directory on this machine")]
        files = sorted(p for p in d.glob("*.json") if p.is_file())
        total, schema = 0, ""
        for f in files:
            try:
                doc = json.loads(f.read_text(encoding="utf-8", errors="replace"))
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(doc, dict) and doc.get("schema"):
                schema = str(doc["schema"])
            if isinstance(doc, dict) and isinstance(doc.get("entries"), list):
                total += len(doc["entries"])
        return [SourceReport(self.name, bool(files), str(d), schema=schema or "unknown",
                             records=total, detail=f"{len(files)} namespace file(s), {total} entries")]

    def records(self) -> Iterable[Record]:
        d = self._dir()
        if not d.is_dir():
            return
        for f in sorted(d.glob("*.json")):
            try:
                doc = json.loads(f.read_text(encoding="utf-8", errors="replace"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(doc, dict) or not isinstance(doc.get("entries"), list):
                continue
            ns = str(doc.get("kind") or f.stem)
            for e in doc["entries"]:
                if not isinstance(e, dict):
                    continue
                if e.get("sensitive") is True:      # MAJIN itself refuses to store these
                    self._withhold_secret()
                    continue
                text = str(e.get("text") or "")
                key = str(e.get("key") or "")
                if not text:
                    continue
                if looks_secret(key, text):
                    self._withhold_secret()
                    continue
                tags = e.get("tags") or []
                yield Record(kind=KIND_MAP.get(ns.lower(), "long_term"), title=key[:300] or ns,
                             content=text[:60000], tags=" ".join([*[str(t) for t in tags], "majin", ns]).strip(),
                             created=parse_iso(e.get("at")), updated=parse_iso(e.get("at")),
                             source=self.name, source_path=str(f), source_id=str(e.get("id") or e.get("key") or ""),
                             extra={"importance": e.get("importance"), "namespace": ns, "meta": _clip(e.get("meta"))})


class MajinProceduresSource(Source):
    """MAJIN V5 learned procedures: `<v5>/learned-procedures.json` (`majin.v5.learning/v1`)."""

    name = "majin-procedures"

    def __init__(self, roots=None, path: Optional[Path] = None):
        super().__init__(roots)
        self.path = path

    def _file(self) -> Path:
        return self.path or (self.roots["majin_v5"] / "learned-procedures.json")

    def _doc(self) -> Optional[dict]:
        p = self._file()
        if not p.is_file():
            return None
        try:
            doc = json.loads(p.read_text(encoding="utf-8", errors="replace"))
        except (OSError, json.JSONDecodeError):
            return None
        return doc if isinstance(doc, dict) else None

    def discover(self) -> list[SourceReport]:
        p, doc = self._file(), self._doc()
        if doc is None:
            return [SourceReport(self.name, False, str(p), detail="no learned-procedures.json on this machine")]
        procs = doc.get("procedures") if isinstance(doc.get("procedures"), list) else []
        avoid = doc.get("scopedAvoidRules") if isinstance(doc.get("scopedAvoidRules"), list) else []
        return [SourceReport(self.name, True, str(p), schema=str(doc.get("schema") or "unknown"),
                             records=len(procs) + len(avoid),
                             detail=f"{len(procs)} procedures, {len(avoid)} avoid-rules")]

    def records(self) -> Iterable[Record]:
        doc = self._doc()
        if not doc:
            return
        p = self._file()
        for proc in doc.get("procedures") or []:
            if not isinstance(proc, dict):
                continue
            blob = json.dumps(proc, ensure_ascii=False, default=str)
            if looks_secret("", blob):
                self._withhold_secret()
                continue
            title = str(proc.get("name") or proc.get("id") or "procedure")
            yield Record(kind="procedural", title=f"majin procedure: {title[:150]}",
                         content=json.dumps({k: v for k, v in proc.items() if k != "name"}, ensure_ascii=False,
                                            indent=1, default=str)[:60000],
                         tags="majin,procedure,legacy", created=parse_iso(proc.get("learnedAt") or proc.get("at")),
                         updated=parse_iso(doc.get("updatedAt")), source=self.name, source_path=str(p),
                         source_id=str(proc.get("id") or title),
                         extra={"skill": proc.get("skillId"), "verified": proc.get("verified")})
        for rule in doc.get("scopedAvoidRules") or []:
            if not isinstance(rule, dict):
                continue
            blob = json.dumps(rule, ensure_ascii=False, default=str)
            if looks_secret("", blob):
                self._withhold_secret()
                continue
            yield Record(kind="fix", title="majin avoid-rule", content=blob[:20000], tags="majin,avoid,legacy",
                         created=parse_iso(rule.get("at")), updated=parse_iso(doc.get("updatedAt")),
                         source=self.name, source_path=str(p), source_id=_sha(blob)[:16])


class MajinV6Source(Source):
    """MAJIN V6 home: job applications, candidate profiles, queue and event log.

    Imported as *history and provenance*. The live data stays where MAJIN owns
    it; Omega gains searchable knowledge of what was applied to and when, so a
    retry can never re-submit an existing application.
    """

    name = "majin-v6"

    def __init__(self, roots=None, home: Optional[Path] = None):
        super().__init__(roots)
        self.home = home

    def _home(self) -> Path:
        return self.home or self.roots["majin_v6"]

    def _read_json(self, rel: str) -> Optional[Any]:
        p = self._home() / rel
        if not p.is_file():
            return None
        try:
            return json.loads(p.read_text(encoding="utf-8", errors="replace"))
        except (OSError, json.JSONDecodeError):
            return None

    def discover(self) -> list[SourceReport]:
        h = self._home()
        if not h.is_dir():
            return [SourceReport(self.name, False, str(h), detail="no MAJIN V6 home on this machine")]
        jobs = self._read_json("jobs/applications.json") or {}
        profiles = self._read_json("jobs/profiles.json") or {}
        apps = jobs.get("applications") if isinstance(jobs, dict) and isinstance(jobs.get("applications"), list) else []
        cands = profiles.get("candidates") if isinstance(profiles, dict) and isinstance(profiles.get("candidates"), list) else []
        events = sum(1 for _ in (h / "events").glob("*.jsonl")) if (h / "events").is_dir() else 0
        schema = str((jobs or {}).get("schema") or "") + ("/" + str((profiles or {}).get("schema")) if profiles else "")
        return [SourceReport(self.name, True, str(h), schema=schema.strip("/") or "unknown",
                             records=len(apps) + len(cands),
                             detail=f"{len(apps)} applications, {len(cands)} candidate profile(s), {events} event log(s)")]

    def records(self) -> Iterable[Record]:
        h = self._home()
        if not h.is_dir():
            return
        jobs = self._read_json("jobs/applications.json")
        if isinstance(jobs, dict):
            for app in jobs.get("applications") or []:
                if not isinstance(app, dict):
                    continue
                blob = json.dumps(app, ensure_ascii=False, default=str)
                if looks_secret("", blob):
                    self._withhold_secret()
                    continue
                job = app.get("job") if isinstance(app.get("job"), dict) else {}
                title = f"application: {job.get('company') or app.get('company') or '?'} — {job.get('title') or app.get('title') or '?'}"
                yield Record(kind="episodic", title=title[:300],
                             content=json.dumps({k: app.get(k) for k in
                                                 ("id", "state", "fingerprint", "candidateId", "url", "evidence",
                                                  "createdAt", "updatedAt", "submittedAt", "receipt")
                                                 if k in app}, ensure_ascii=False, indent=1, default=str)[:40000],
                             tags="majin,job,application,legacy",
                             created=parse_iso(app.get("createdAt")), updated=parse_iso(app.get("updatedAt")),
                             source=self.name, source_path=str(h / "jobs" / "applications.json"),
                             source_id=str(app.get("id") or ""),
                             extra={"state": app.get("state"), "fingerprint": app.get("fingerprint"),
                                    "candidateId": app.get("candidateId")})
        profiles = self._read_json("jobs/profiles.json")
        if isinstance(profiles, dict):
            for c in profiles.get("candidates") or []:
                if not isinstance(c, dict):
                    continue
                # Profiles may point at a CV path; keep the reference, not the
                # document text, and never keep anything credential-shaped.
                safe = {k: v for k, v in c.items() if not looks_secret(str(k), json.dumps(v, default=str))}
                yield Record(kind="preference", title=f"job candidate profile: {c.get('id')}",
                             content=json.dumps(safe, ensure_ascii=False, indent=1, default=str)[:20000],
                             tags="majin,job,candidate,legacy", source=self.name,
                             source_path=str(h / "jobs" / "profiles.json"), source_id=str(c.get("id") or ""),
                             extra={"exclusions": len(c.get("exclusions") or []) if isinstance(c.get("exclusions"), list) else 0})
        ev_dir = h / "events"
        if ev_dir.is_dir():
            for f in sorted(ev_dir.glob("*.jsonl"))[-5:]:
                try:
                    lines = f.read_text(encoding="utf-8", errors="replace").splitlines()
                except OSError:
                    continue
                interesting = []
                for line in lines[-400:]:
                    try:
                        e = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(e, dict) and str(e.get("event") or "").startswith(
                            ("job.", "engine.", "task.completed", "task.failed", "permission.", "verified")):
                        interesting.append(e)
                if interesting:
                    yield Record(kind="episodic", title=f"majin v6 event log: {f.name}",
                                 content=json.dumps(interesting[-120:], ensure_ascii=False, indent=1, default=str)[:60000],
                                 tags="majin,events,legacy", source=self.name, source_path=str(f),
                                 source_id=f.name, extra={"events": len(interesting)})


class MajinWorkspaceSource(Source):
    """MAJIN matrix workspaces: team memory + mission journals (JSONL)."""

    name = "majin-workspace"

    def __init__(self, roots=None, search: Optional[list[Path]] = None):
        super().__init__(roots)
        self.search = search

    def _roots(self) -> list[Path]:
        if self.search is not None:
            return [p for p in self.search if p.is_dir()]
        out = []
        for base in (self.roots["repo"], self.roots["majin_v5"], self.roots["home"]):
            if not base or not base.is_dir():
                continue
            try:
                out += [p for p in base.glob(".majin-matrix-ws-*") if p.is_dir()][:20]
                out += [p for p in base.glob("*/.majin-matrix-ws-*") if p.is_dir()][:20]
            except OSError:
                continue
        return out

    def discover(self) -> list[SourceReport]:
        ws = self._roots()
        if not ws:
            return [SourceReport(self.name, False, "", detail="no .majin-matrix-ws-* workspace found")]
        n = 0
        for w in ws:
            n += sum(1 for _ in w.rglob("memory.jsonl")) + sum(1 for _ in w.rglob("journal.jsonl"))
        return [SourceReport(self.name, True, str(ws[0].parent), schema="jsonl journal/memory",
                             records=n, detail=f"{len(ws)} workspace(s), {n} journal/memory file(s)")]

    def records(self) -> Iterable[Record]:
        for w in self._roots():
            for pattern in ("**/memory.jsonl", "**/journal.jsonl"):
                for f in sorted(w.glob(pattern)):
                    try:
                        lines = f.read_text(encoding="utf-8", errors="replace").splitlines()
                    except OSError:
                        continue
                    items = []
                    for line in lines[:2000]:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            items.append(json.loads(line))
                        except json.JSONDecodeError:
                            continue
                    if not items:
                        continue
                    blob = json.dumps(items, ensure_ascii=False, default=str)
                    if looks_secret("", blob[:20000]):
                        self._withhold_secret()
                        continue
                    yield Record(kind="episodic", title=f"majin workspace {f.parent.name}: {f.name}",
                                 content=blob[:60000], tags="majin,workspace,legacy",
                                 source=self.name, source_path=str(f), source_id=_sha(str(f))[:16],
                                 extra={"entries": len(items)})


def _table_counts(conn: sqlite3.Connection) -> dict:
    out = {}
    for (name,) in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"):
        try:
            out[name] = int(conn.execute(f"SELECT COUNT(*) FROM '{name}'").fetchone()[0])
        except sqlite3.Error:
            return {}
    return out


def consistent_sqlite_snapshot(src_path: Path, dest_path: Path) -> tuple[bool, str]:
    """Copy a live SQLite database (possibly in WAL mode) into a consistent file.

    Three strategies are tried in order and the result is *verified by comparing
    every table's row count against the source*. Nothing is trusted because an
    API exists:

      1. `Connection.backup()` — the online backup API. Not every CPython build
         returns a usable backup object (some return None and copy nothing), so
         it is verified rather than assumed.
      2. `Connection.iterdump()` — a pure-Python SQL dump. Slower, but it works
         everywhere and produces a self-contained database.
      3. File copy of the database plus its `-wal`/`-shm` sidecars, then a
         `wal_checkpoint(TRUNCATE)` inside the copy so the sidecars are folded
         in and removed. A bare file copy without the sidecars would silently
         lose the most recent writes, which is exactly what a pre-migration
         backup must not do.

    Returns (ok, method). On failure the destination is removed.
    """
    dest_path = Path(dest_path)
    with _suppress_ctx():
        if dest_path.exists():
            dest_path.unlink()
    try:
        src = sqlite3.connect(f"file:{Path(src_path).as_posix()}?mode=ro", uri=True, timeout=15)
        src.execute("SELECT count(*) FROM sqlite_master")
    except sqlite3.Error as e:
        return False, f"source unreadable: {e}"
    try:
        expected = _table_counts(src)
        if not expected and src.execute("SELECT count(*) FROM sqlite_master").fetchone()[0] > 0:
            return False, "source tables could not be counted"

        # 1. online backup API
        try:
            dst = sqlite3.connect(str(dest_path))
            try:
                bk = src.backup(dst)
                if bk is not None:
                    with _suppress_ctx():
                        bk.close()
                dst.commit()
            finally:
                dst.close()
            if _verify_snapshot(dest_path, expected):
                return True, "sqlite-backup-api"
        except sqlite3.Error:
            pass
        with _suppress_ctx():
            dest_path.unlink()

        # 2. pure-Python SQL dump
        try:
            dst = sqlite3.connect(str(dest_path))
            try:
                dst.executescript("\n".join(src.iterdump()))
                dst.commit()
            finally:
                dst.close()
            if _verify_snapshot(dest_path, expected):
                return True, "sqlite-iterdump"
        except sqlite3.Error:
            pass
        with _suppress_ctx():
            dest_path.unlink()
    finally:
        src.close()

    # 3. file copy including the WAL sidecars, then checkpoint inside the copy
    try:
        shutil.copy2(src_path, dest_path)
        for suffix in ("-wal", "-shm"):
            side = Path(str(src_path) + suffix)
            if side.is_file():
                shutil.copy2(side, Path(str(dest_path) + suffix))
        conn = sqlite3.connect(str(dest_path), timeout=15)
        try:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            conn.commit()
        finally:
            conn.close()
        for suffix in ("-wal", "-shm"):
            with _suppress_ctx():
                Path(str(dest_path) + suffix).unlink()
        src2 = sqlite3.connect(f"file:{Path(src_path).as_posix()}?mode=ro", uri=True, timeout=15)
        try:
            expected = _table_counts(src2)
        finally:
            src2.close()
        if _verify_snapshot(dest_path, expected):
            return True, "file-copy+wal-checkpoint"
    except (OSError, sqlite3.Error):
        pass
    with _suppress_ctx():
        dest_path.unlink()
    return False, "no strategy produced a verified snapshot"


def _verify_snapshot(dest_path: Path, expected: dict) -> bool:
    if not Path(dest_path).is_file():
        return False
    try:
        conn = sqlite3.connect(f"file:{Path(dest_path).as_posix()}?mode=ro", uri=True, timeout=10)
    except sqlite3.Error:
        return False
    try:
        actual = _table_counts(conn)
    finally:
        conn.close()
    if not actual:
        return False
    return all(actual.get(t) == n for t, n in expected.items())


def _clip(value: Any, n: int = 400) -> Any:
    if value is None:
        return None
    s = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    return s if len(s) <= n else s[: n - 1] + "…"


def default_sources(roots: Optional[dict] = None) -> list[Source]:
    return [OmegaDbSource(roots), StuddyDbSource(roots), ObsidianSource(roots), MajinMemorySource(roots),
            MajinProceduresSource(roots), MajinV6Source(roots), MajinWorkspaceSource(roots)]


# ════════════════════════════════════════════════════════════════════════════
# The migrator
# ════════════════════════════════════════════════════════════════════════════
@dataclass
class MigrationReport:
    started: float = field(default_factory=_now)
    finished: Optional[float] = None
    dry_run: bool = True
    sources: list[SourceReport] = field(default_factory=list)
    read: int = 0
    imported: int = 0
    duplicates: int = 0
    skipped_secret: int = 0
    skipped_empty: int = 0
    errors: list[str] = field(default_factory=list)
    backup: str = ""
    backup_sha256: str = ""
    target_count_before: int = 0
    target_count_after: int = 0
    retrieval_check: dict = field(default_factory=dict)
    rolled_back: bool = False
    by_kind: dict = field(default_factory=dict)
    by_source: dict = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.errors and self.target_count_after == self.target_count_before + self.imported

    def to_dict(self) -> dict:
        d = {k: v for k, v in self.__dict__.items()}
        d["sources"] = [s.__dict__ for s in self.sources]
        d["ok"] = self.ok
        d["started_iso"], d["finished_iso"] = _iso(self.started), _iso(self.finished or _now())
        return d

    def render(self) -> str:
        lines = [f"MIGRATION {'(dry run — nothing was written)' if self.dry_run else ''}",
                 "", "  SOURCES"]
        for s in self.sources:
            mark = "found " if s.found else "absent"
            lines.append(f"    {mark} {s.name:<18} {s.path}")
            if s.found:
                lines.append(f"           schema: {s.schema or 'unknown'}   records: {s.records}")
                if s.detail:
                    lines.append(f"           {s.detail}")
                if s.error:
                    lines.append(f"           ERROR: {s.error}")
            else:
                lines.append(f"           {s.detail}")
        lines += ["", "  RESULT",
                  f"    read               {self.read}",
                  f"    imported           {self.imported}",
                  f"    duplicates skipped {self.duplicates}",
                  f"    secrets skipped    {self.skipped_secret}",
                  f"    empty skipped      {self.skipped_empty}",
                  f"    target rows        {self.target_count_before} → {self.target_count_after}",
                  f"    backup             {self.backup or '(none needed)'}"]
        if self.backup_sha256:
            lines.append(f"    backup sha256      {self.backup_sha256[:32]}…")
        if self.by_kind:
            lines.append("    by kind            " + ", ".join(f"{k}={v}" for k, v in sorted(self.by_kind.items())))
        if self.by_source:
            lines.append("    by source          " + ", ".join(f"{k}={v}" for k, v in sorted(self.by_source.items())))
        if self.retrieval_check:
            rc = self.retrieval_check
            lines.append(f"    retrieval check    {rc.get('status', '?')} — {rc.get('detail', '')}")
        for e in self.errors:
            lines.append(f"    ERROR              {e}")
        lines += ["", f"  {'OK' if self.ok else 'NOT OK'}   (imported records are status='migrated', tagged 'legacy' — "
                  "legacy knowledge is never auto-promoted to verified fact)"]
        return "\n".join(lines)


class Migrator:
    """Discover → inspect → back up → import → dedupe → validate → prove → rollback."""

    def __init__(self, sink: Sink, sources: Optional[list[Source]] = None, roots: Optional[dict] = None,
                 log: Optional[Callable[[str, dict], None]] = None):
        self.roots = roots or discover_roots()
        self.sources = sources if sources is not None else default_sources(self.roots)
        self.sink = sink
        self._log = log or (lambda event, payload=None: None)
        self.last_report: Optional[MigrationReport] = None
        self.state_file: Optional[Path] = None
        self._imported_sample: list[Record] = []

    # ── 1/2. discovery + schema inspection ─────────────────────────────────
    def scan(self) -> list[SourceReport]:
        """One report per source name.

        A source may have several candidate locations (e.g. the old Study Buddy
        wrote to `%APPDATA%\\StuddyBuddy` on Windows and `$XDG_DATA_HOME`
        elsewhere). If any candidate is found the absent ones are noise and are
        dropped; if none is found they are merged into a single honest "looked
        here, here and here" report.
        """
        reports: list[SourceReport] = []
        for src in self.sources:
            try:
                found = src.discover()
            except Exception as e:  # a broken legacy install must not abort the scan
                reports.append(SourceReport(src.name, True, "", error=f"{type(e).__name__}: {e}"))
                continue
            kept = [r for r in found if r.found]
            if kept:
                reports += kept
            elif found:
                merged = SourceReport(src.name, False, " | ".join(dict.fromkeys(r.path for r in found if r.path)),
                                      detail=found[0].detail, error=found[0].error)
                reports.append(merged)
        self._log("migration.scan", {"sources": len(reports), "found": sum(1 for r in reports if r.found)})
        return reports

    # ── 3. verified backup ─────────────────────────────────────────────────
    def backup_target(self, backup_dir: Optional[Path] = None) -> tuple[str, str]:
        """A consistent, verified copy of the target taken *before* any import.

        Omega's database runs in WAL mode, so a plain file copy can miss the
        writes still sitting in `-wal`. `consistent_sqlite_snapshot` handles that
        and verifies the result table by table; if no strategy can be verified
        the migration refuses to import rather than proceeding without a way
        back.
        """
        target = self.sink.snapshot_path()
        if target is None or not target.is_file():
            return "", ""
        backup_dir = backup_dir or (target.parent / "backups")
        backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        dest = backup_dir / f"{target.stem}-pre-migration-{stamp}.db"
        ok, method = consistent_sqlite_snapshot(target, dest)
        if not ok:
            raise RuntimeError(f"backup of {target} could not be verified ({method}); refusing to import")
        sha = file_sha256(dest) or ""
        self._log("migration.backup", {"target": str(target), "backup": str(dest), "sha256": sha,
                                       "method": method, "size": dest.stat().st_size if dest.is_file() else 0})
        return str(dest), sha

    def rollback(self, backup_path: str) -> bool:
        """Restore the pre-migration database.

        The sink is closed first: replacing a database file underneath a live
        connection leaves that connection talking to the old inode, so the
        rollback would look successful and change nothing. Callers that keep a
        long-lived connection (the agent itself) must reopen it afterwards —
        `Store.reopen()` in buddy.py does exactly that.
        """
        target = self.sink.snapshot_path()
        backup = Path(backup_path)
        if not target or not backup.is_file():
            return False
        if file_sha256(backup) is None:
            return False
        with _suppress_ctx():
            close = getattr(self.sink, "close", None)
            if callable(close):
                close()
        tmp = target.with_name(target.name + ".rollback-tmp")
        shutil.copy2(backup, tmp)
        os.replace(tmp, target)
        # WAL/SHM sidecars from the rolled-back database must not survive: they
        # belong to the state we are undoing and would replay it on next open.
        for suffix in ("-wal", "-shm"):
            sidecar = Path(str(target) + suffix)
            if sidecar.is_file():
                with _suppress_ctx():
                    sidecar.unlink()
        self._log("migration.rollback", {"restored": str(backup), "target": str(target)})
        return True

    # ── 4–8. import, dedupe, validate ──────────────────────────────────────
    def run(self, dry_run: bool = True, only: Optional[list[str]] = None, limit: Optional[int] = None,
            backup_dir: Optional[Path] = None, retrieval_probe: str = "") -> MigrationReport:
        rep = MigrationReport(dry_run=dry_run)
        rep.sources = self.scan()
        self._imported_sample = []
        wanted = set(only or [])

        # Rule 3 before anything else: a verified backup of the target must exist
        # before the sink is opened for writing or its schema is touched.
        if not dry_run:
            try:
                rep.backup, rep.backup_sha256 = self.backup_target(backup_dir)
            except Exception as e:
                rep.errors.append(f"backup failed, refusing to import: {e}")
                rep.finished = _now()
                self.last_report = rep
                return rep

        existing = set(self.sink.existing_keys())
        rep.target_count_before = self.sink.count()
        seen: set[str] = set(existing)

        for src in self.sources:
            if wanted and src.name not in wanted:
                continue
            try:
                stream = src.records()
            except Exception as e:
                rep.errors.append(f"{src.name}: cannot read ({type(e).__name__}: {e})")
                continue
            before_withholds = getattr(src, "secret_skips", 0)
            for rec in stream:
                if limit is not None and rep.read >= limit:
                    break
                rep.read += 1
                if not (rec.title or "").strip() and not (rec.content or "").strip():
                    rep.skipped_empty += 1
                    continue
                if looks_secret(rec.title, rec.content[:4000]):
                    rep.skipped_secret += 1
                    self._log("migration.skip.secret", {"source": src.name, "title": _clip(rec.title, 80)})
                    continue
                key = rec.dedupe_key
                if key in seen:
                    rep.duplicates += 1
                    continue
                seen.add(key)
                # Legacy knowledge arrives untrusted: it must never be silently
                # promoted to a verified current fact.
                rec.status = "migrated"
                tags = [t for t in re.split(r"[\s,]+", rec.tags or "") if t]
                for extra_tag in ("legacy", f"src:{src.name}"):
                    if extra_tag not in tags:
                        tags.append(extra_tag)
                rec.tags = " ".join(tags)
                rec.content = redact_text(rec.content)
                rec.title = redact_text(rec.title)[:300] or "untitled"
                rec.extra["provenance"] = rec.provenance()
                if not dry_run:
                    try:
                        self.sink.save(rec)
                    except Exception as e:
                        rep.errors.append(f"{src.name}: save failed ({type(e).__name__}: {e})")
                        continue
                rep.imported += 1
                if len(self._imported_sample) < 200:
                    self._imported_sample.append(rec)
                rep.by_kind[rec.kind] = rep.by_kind.get(rec.kind, 0) + 1
                rep.by_source[src.name] = rep.by_source.get(src.name, 0) + 1
            rep.skipped_secret += max(0, getattr(src, "secret_skips", 0) - before_withholds)

        rep.target_count_after = self.sink.count() if not dry_run else rep.target_count_before + rep.imported
        # 8/9. count validation + retrieval proof
        expected = rep.target_count_before + rep.imported
        if not dry_run and rep.target_count_after != expected:
            rep.errors.append(f"record count validation failed: expected {expected}, found {rep.target_count_after}")
        if not dry_run and rep.imported:
            rep.retrieval_check = self.verify_retrieval(retrieval_probe or self._auto_probe())
            if rep.retrieval_check.get("status") != "PASS":
                rep.errors.append(f"retrieval check did not pass: {rep.retrieval_check.get('detail')}")
        rep.finished = _now()
        self.last_report = rep
        self._log("migration.run", {"dry_run": dry_run, "imported": rep.imported, "duplicates": rep.duplicates,
                                    "secrets_skipped": rep.skipped_secret, "errors": len(rep.errors)})
        return rep

    def _auto_probe(self) -> str:
        """Pick a probe term from data this run actually imported.

        Never a synthetic word: the point of rule 9 is to prove the *owner's*
        imported knowledge is retrievable, so the probe has to come from it.
        """
        stop = {"legacy", "migrated", "untitled", "obsidian", "majin", "omega", "studdy",
                "application", "procedure", "summary", "concept", "preference"}
        for rec in self._imported_sample:
            for word in re.findall(r"[A-Za-zÅÄÖåäö]{5,}", f"{rec.title} {rec.content[:300]}"):
                if word.lower() not in stop:
                    return word
        return ""

    def verify_retrieval(self, probe: str) -> dict:
        """9. Prove the imported knowledge is actually retrievable."""
        if not probe:
            return {"status": "NOT TESTED", "detail": "no probe term available (nothing imported?)", "probe": ""}
        try:
            hits = self.sink.search(probe, limit=5)
        except Exception as e:
            return {"status": "FAIL", "detail": f"search raised {type(e).__name__}: {e}", "probe": probe}
        return {"status": "PASS" if hits else "FAIL", "probe": probe, "hits": len(hits),
                "detail": f"{len(hits)} hit(s) for '{probe}'" + ("" if hits else " — imported records are not retrievable")}


# ════════════════════════════════════════════════════════════════════════════
# CLI
# ════════════════════════════════════════════════════════════════════════════
def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(prog="buddy migrate", description="Discover and import legacy Study Buddy / MAJIN / Obsidian / Omega memory")
    ap.add_argument("action", nargs="?", default="scan", choices=["scan", "plan", "run", "verify", "rollback"])
    ap.add_argument("--yes", action="store_true", help="actually write (default is a dry run)")
    ap.add_argument("--only", default="", help="comma-separated source names")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--db", default="", help="target buddy.db (default: the real Omega home)")
    ap.add_argument("--backup", default="", help="backup path for rollback")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)

    only = [s.strip() for s in a.only.split(",") if s.strip()] or None
    sink: Sink
    if a.db:
        sink = SqliteSink(Path(a.db).expanduser())
    else:
        try:
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            import buddy  # type: ignore
            sink = SqliteSink(buddy.HOME / "buddy.db")
        except Exception:
            sink = SqliteSink(Path(os.environ.get("BUDDY_HOME") or Path.home() / ".studdybuddy") / "buddy.db")

    mig = Migrator(sink)
    if a.action == "scan":
        reports = mig.scan()
        if a.json:
            print(json.dumps([r.__dict__ for r in reports], indent=2, ensure_ascii=False))
        else:
            print("\nLEGACY MEMORY SCAN — what actually exists on this machine\n")
            for r in reports:
                print(f"  {'FOUND ' if r.found else 'absent'} {r.name:<18} {r.path}")
                print(f"         {(r.schema or 'no schema')} · {r.records} record(s) · {r.detail}{(' · ERROR: ' + r.error) if r.error else ''}")
            found = [r for r in reports if r.found and r.records]
            print(f"\n  {len(found)} source(s) hold data. Run `buddy migrate plan` for a dry-run import plan.")
        return 0
    if a.action == "rollback":
        if not a.backup:
            print("rollback needs --backup <path from the migration report>")
            return 2
        ok = mig.rollback(a.backup)
        print("rollback restored the pre-migration database" if ok else "rollback FAILED (backup missing or target unreadable)")
        return 0 if ok else 1

    rep = mig.run(dry_run=not a.yes, only=only, limit=a.limit)
    if a.action == "verify":
        rep = mig.run(dry_run=False, only=only, limit=a.limit)
    if a.json:
        print(json.dumps(rep.to_dict(), indent=2, ensure_ascii=False, default=str))
    else:
        print("\n" + rep.render() + "\n")
        if not rep.dry_run and rep.backup:
            print(f"  To undo everything: buddy migrate rollback --backup \"{rep.backup}\"\n")
    return 0 if rep.ok or rep.dry_run else 1


class SqliteSink(Sink):
    """Writes into the real Omega `memories` table, preserving provenance.

    The database file is created **lazily, on the first write**. A dry run or a
    `plan` therefore never materialises a target that did not exist — creating
    an empty database during a dry run would be a side effect the owner did not
    ask for.
    """

    SCHEMA = """CREATE TABLE IF NOT EXISTS memories(
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, title TEXT, content TEXT, tags TEXT,
        status TEXT DEFAULT 'active', source_run TEXT, created REAL, updated REAL, uses INTEGER DEFAULT 0,
        provenance TEXT, dedupe TEXT)"""

    def __init__(self, path: Path):
        self.path = Path(path)
        self._db: Optional[sqlite3.Connection] = None
        self._mem: Optional[sqlite3.Connection] = None
        self._columns: Optional[set[str]] = None

    # `db` stays a public attribute because tests and the CLI read it directly.
    @property
    def db(self) -> sqlite3.Connection:
        conn = self._connect(write=True)
        return conn

    def _connect(self, write: bool) -> sqlite3.Connection:
        if self._db is not None:
            return self._db
        if not self.path.is_file():
            if not write:
                # Reading a database that does not exist yet must not create it.
                # An empty in-memory stand-in answers every read with "nothing".
                if self._mem is None:
                    self._mem = sqlite3.connect(":memory:")
                    self._mem.row_factory = sqlite3.Row
                    self._mem.execute(self.SCHEMA)
                return self._mem
            self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.path), timeout=15)
        conn.row_factory = sqlite3.Row
        conn.execute(self.SCHEMA)
        self._ensure_columns(conn)
        conn.commit()
        self._db = conn
        self._mem = None
        return conn

    def close(self) -> None:
        for attr in ("_db", "_mem"):
            conn = getattr(self, attr, None)
            if conn is not None:
                with _suppress_ctx():
                    conn.close()
                setattr(self, attr, None)

    @staticmethod
    def _ensure_columns(conn: sqlite3.Connection) -> None:
        """Additively upgrade a *real, pre-existing* Omega database.

        Omega's own `memories` table has no `provenance`/`dedupe` columns. Without
        them a second migration run could not recognise records it had already
        imported, so dedupe (rule 6) would silently fail on the owner's real
        database. Both columns are added with ALTER TABLE — never a rewrite,
        never a drop — and the target was backed up before we got here.
        """
        cols = {r[1] for r in conn.execute("PRAGMA table_info(memories)")}
        for name in ("provenance", "dedupe"):
            if name not in cols:
                with _suppress_ctx():
                    conn.execute(f"ALTER TABLE memories ADD COLUMN {name} TEXT")
        with _suppress_ctx():
            conn.execute("CREATE INDEX IF NOT EXISTS idx_mem_dedupe ON memories(dedupe)")

    def _cols(self) -> set[str]:
        if self._columns is None:
            self._columns = {r[1] for r in self._connect(write=False).execute("PRAGMA table_info(memories)")}
        return self._columns

    def snapshot_path(self) -> Optional[Path]:
        return self.path if self.path.is_file() else None

    def existing_keys(self) -> set[str]:
        conn = self._connect(write=False)
        try:
            if "dedupe" not in self._cols():
                return set()
            return {r[0] for r in conn.execute("SELECT dedupe FROM memories WHERE dedupe IS NOT NULL")}
        except sqlite3.Error:
            return set()

    def count(self) -> int:
        try:
            return self._connect(write=False).execute("SELECT COUNT(*) FROM memories").fetchone()[0]
        except sqlite3.Error:
            return 0

    def save(self, rec: Record) -> int:
        conn = self._connect(write=True)
        cols = {r[1] for r in conn.execute("PRAGMA table_info(memories)")}
        self._columns = cols
        values: dict[str, Any] = {
            "kind": rec.kind, "title": rec.title, "content": rec.content, "tags": rec.tags,
            "status": rec.status, "source_run": f"migration:{rec.source}",
            "created": rec.created or _now(), "updated": rec.updated or rec.created or _now(),
        }
        if "provenance" in cols:
            values["provenance"] = json.dumps(rec.provenance(), ensure_ascii=False, default=str)
        if "dedupe" in cols:
            values["dedupe"] = rec.dedupe_key
        q = f"INSERT INTO memories ({','.join(values)}) VALUES ({','.join('?' * len(values))})"
        cur = conn.execute(q, tuple(values.values()))
        conn.commit()
        return int(cur.lastrowid or 0)

    def search(self, query: str, limit: int = 5) -> list[dict]:
        like = f"%{query}%"
        rows = self._connect(write=False).execute(
            "SELECT id, kind, title, substr(content,1,200) AS snippet, tags, status FROM memories "
            "WHERE title LIKE ? OR content LIKE ? OR tags LIKE ? ORDER BY updated DESC LIMIT ?",
            (like, like, like, int(limit))).fetchall()
        return [dict(r) for r in rows]


class _suppress_ctx:
    def __enter__(self): ...
    def __exit__(self, *a): return True


if __name__ == "__main__":
    sys.exit(main())
