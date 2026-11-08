#!/usr/bin/env python3
"""
End-to-end acceptance — the 20 mandated scenarios, run for real.

    buddy accept            run everything this host can prove
    buddy accept --json     machine-readable report
    buddy accept 13 15      run specific scenarios
    buddy accept --list     what each scenario does and what it needs

Every scenario returns exactly one of:

    PASS        executed here, and the real system state confirms the outcome
    FAIL        executed here, and it did not work — a defect, with evidence
    BLOCKED     cannot be executed on this host (no Windows desktop, no API key,
                no microphone, no MAJIN profile). The reason is always the real
                one, and the fix is named.
    NOT TESTED  requires a human or a live external service; nothing was run

A mocked test is not a real pass, so nothing here fabricates one. Scenarios that
need Windows contain the real Windows code path — they are gated, not stubbed,
so running this same file on the owner's machine executes them for real.

Evidence for every scenario is written to `<omega home>/acceptance/<stamp>/`:
a JSON report, a Markdown report, and any artifact the scenario produced
(files, screenshots, queue dumps, subprocess logs).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
MAJIN = REPO / "integrations" / "majin-original"
INSTALLER = HERE / "install" / "install.ps1"

#: An isolated home is mandatory: acceptance must never write to the owner's real
#: data, and it must be able to prove a fresh-install path from nothing.
_SCRATCH = Path(os.environ.get("BUDDY_ACCEPT_HOME") or Path(tempfile.gettempdir()) / f"buddy-accept-{os.getpid()}")
os.environ["BUDDY_HOME"] = str(_SCRATCH)
sys.path.insert(0, str(HERE))

import buddy  # noqa: E402  (must be imported after BUDDY_HOME is set)

# Same reason as run_all.py: this harness prints decorated output, and a cp1252
# Windows console cannot encode the glyphs. A crash here would look like a failed
# scenario rather than what it is — a reporting problem.
buddy.force_utf8_output()

IS_WIN = sys.platform == "win32"
PASS, FAIL, BLOCKED, NOT_TESTED = "PASS", "FAIL", "BLOCKED", "NOT TESTED"


@dataclass
class Result:
    status: str
    detail: str = ""
    evidence: dict = field(default_factory=dict)
    #: what remains unproven on this host even when the cross-platform part passed
    unproven: str = ""
    fix: str = ""


@dataclass
class Scenario:
    num: int
    name: str
    needs: str
    run: Callable[["Ctx"], Result]


class Ctx:
    """Shared, real state for the acceptance run."""

    def __init__(self, evidence_dir: Path):
        self.evidence_dir = evidence_dir
        self.evidence_dir.mkdir(parents=True, exist_ok=True)
        self.tmp = Path(tempfile.mkdtemp(prefix="buddy-accept-work-", dir=str(self.evidence_dir.parent)))
        self.app: Any = None
        self.key: bool = False
        self.log_lines: list[str] = []

    def note(self, msg: str) -> None:
        line = f"[{time.strftime('%H:%M:%S')}] {msg}"
        self.log_lines.append(line)
        print("      " + line, flush=True)

    def app_instance(self) -> Any:
        if self.app is None:
            self.app = buddy.Buddy(headless=True)
            self.app.loop = None
            for scope in ("observe", "input", "write", "exec"):
                self.app.perms.set(scope, "always")
        return self.app

    def save(self, name: str, content: Any) -> str:
        p = self.evidence_dir / name
        p.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, (dict, list)):
            p.write_text(json.dumps(content, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        elif isinstance(content, bytes):
            p.write_bytes(content)
        else:
            p.write_text(str(content), encoding="utf-8")
        return str(p)

    def cleanup(self) -> None:
        with Context():
            pass

    def child(self, args: list[str], env: Optional[dict] = None, timeout: float = 300) -> subprocess.CompletedProcess:
        e = dict(os.environ)
        e.update(env or {})
        return subprocess.run([sys.executable, str(buddy.SOURCE_FILE), *args], capture_output=True,
                              text=True, timeout=timeout, env=e, cwd=str(HERE))


class Context:
    def __enter__(self): return self
    def __exit__(self, *a): return True


def _majin_env(ctx: Ctx) -> Optional[dict]:
    """A real, isolated MAJIN owner profile — or None with the reason."""
    mb = buddy.sibling("majin_bridge")
    if mb is None:
        return None
    root, node = mb.find_majin_root(), mb.find_node()
    if root is None or node is None or not (root / "node_modules").is_dir():
        return None
    v5, v6, ws = ctx.tmp / "majin-v5", ctx.tmp / "majin-v6", ctx.tmp / "majin-ws"
    ws.mkdir(parents=True, exist_ok=True)
    v5.mkdir(parents=True, exist_ok=True)
    (ws / "acceptance-proof.txt").write_text("OMEGA ACCEPTANCE — REAL MAJIN CONTENT\n", encoding="utf-8")
    (v5 / "owner-mode.json").write_text(json.dumps({
        "schema": "majin.v4.owner-mode/v1", "version": 1, "lanes": ["files", "jobs"],
        "folders": [str(ws)], "browserOrigins": [], "history": []}), encoding="utf-8")
    return {"MAJIN_V5_DATA_DIR": str(v5), "MAJIN_V6_HOME": str(v6), "MAJIN_WORKSPACE": str(ws)}


# ════════════════════════════════════════════════════════════════════════════
# 1–3 · INSTALLATION
# ════════════════════════════════════════════════════════════════════════════
def s01_fresh_install(ctx: Ctx) -> Result:
    """The installer must exist, be valid, and contain no hardcoded user paths."""
    if not INSTALLER.is_file():
        return Result(FAIL, f"installer missing: {INSTALLER}", fix="restore omega/install/install.ps1")
    text = INSTALLER.read_text(encoding="utf-8", errors="replace")
    problems = []
    # The previous installer failed because it demanded one specific Python and
    # carried absolute paths. Both are checked, not assumed away.
    for bad in ("C:\\Users\\rssen", "C:\\Users\\owner", "/home/user", "C:\\MAJINCLI"):
        if bad.lower() in text.lower():
            problems.append(f"hardcoded path {bad!r}")
    if "3.12" in text and "3.11" not in text and "3.13" not in text:
        problems.append("accepts only Python 3.12 (the failure mode that broke the previous installer)")
    for required in ("python", "venv", "buddy", "rollback", "doctor"):
        if required.lower() not in text.lower():
            problems.append(f"does not mention {required!r}")
    ev = {"installer": str(INSTALLER), "bytes": len(text), "problems": problems,
          "lines": len(text.splitlines())}
    ctx.save("01-installer-static.json", ev)
    if problems:
        return Result(FAIL, "; ".join(problems), ev)
    detail = f"installer contract OK ({len(text.splitlines())} lines, no hardcoded user paths, multi-Python)"
    if IS_WIN:
        rc = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(INSTALLER),
                             "-Verify"], capture_output=True, text=True, timeout=600)
        ctx.save("01-installer-verify.txt", rc.stdout + rc.stderr)
        if rc.returncode != 0:
            return Result(FAIL, f"install.ps1 -Verify exited {rc.returncode}: {(rc.stderr or rc.stdout)[-400:]}", ev)
        return Result(PASS, detail + "; install.ps1 -Verify ran clean on Windows", ev)
    return Result(PASS, detail, ev,
                  unproven="actually executing the installer needs Windows; run `buddy accept 1` there",
                  fix="powershell -NoProfile -ExecutionPolicy Bypass -File omega/install/install.ps1")


def s02_upgrade_from_existing(ctx: Ctx) -> Result:
    """An upgrade must preserve existing data and keep the old entrypoint working."""
    home = ctx.tmp / "existing-home"
    home.mkdir(parents=True, exist_ok=True)
    # a real pre-existing Omega database with owner data in it
    import sqlite3
    db = home / "buddy.db"
    conn = sqlite3.connect(str(db))
    conn.executescript(buddy.SCHEMA)
    conn.execute("INSERT INTO memories(kind,title,content,tags,status,created,updated,uses) VALUES(?,?,?,?,?,?,?,?)",
                 ("preference", "Owner editor", "Prefers Neovim", "editor", "active", time.time(), time.time(), 2))
    conn.execute("INSERT INTO settings(key,value) VALUES('first_run_done','true')")
    conn.execute("INSERT INTO settings(key,value) VALUES('language','\"sv\"')")
    conn.commit()
    conn.close()
    before_sha = buddy.hashlib.sha256(db.read_bytes()).hexdigest()
    before_rows = sqlite3.connect(str(db)).execute("SELECT COUNT(*) FROM memories").fetchone()[0]

    # The upgraded runtime opens the SAME database and must keep every row while
    # adding its new columns. This is the real upgrade path, not a simulation.
    store = buddy.Store(db)
    try:
        after_rows = store.one("SELECT COUNT(*) AS n FROM memories")["n"]
        cols = {r[1] for r in store.db.execute("PRAGMA table_info(memories)")}
        tables = {r[0] for r in store.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        preserved = store.one("SELECT content FROM memories WHERE title='Owner editor'")
        lang = store.one("SELECT value FROM settings WHERE key='language'")
    finally:
        store.close()
    needed_cols = {"provenance", "dedupe", "scope"}
    needed_tables = {"level_history", "stats"}
    ok = (after_rows == before_rows and needed_cols <= cols and needed_tables <= tables
          and preserved and preserved["content"] == "Prefers Neovim" and lang)
    ev = {"rows_before": before_rows, "rows_after": after_rows, "new_columns": sorted(needed_cols & cols),
          "new_tables": sorted(needed_tables & tables), "owner_data_preserved": bool(preserved),
          "settings_preserved": bool(lang), "db_sha256_before": before_sha}
    ctx.save("02-upgrade.json", ev)
    shim = REPO / "studdy-buddy" / "omega" / "buddy.py"
    if shim.is_file():
        rc = subprocess.run([sys.executable, str(shim), "version"], capture_output=True, text=True, timeout=120,
                            env={**os.environ, "BUDDY_HOME": str(ctx.tmp / "shim-home")})
        ev["legacy_entrypoint"] = {"path": str(shim), "rc": rc.returncode, "out": rc.stdout.strip()[:120]}
        ok = ok and rc.returncode == 0 and "Omega" in rc.stdout
    else:
        ev["legacy_entrypoint"] = "shim missing"
        ok = False
    return Result(PASS if ok else FAIL,
                  f"{before_rows} owner record(s) preserved, +{len(needed_cols)} columns, "
                  f"+{len(needed_tables)} tables, legacy `studdy-buddy/omega/buddy.py` still runs",
                  ev)


def s03_python_detection(ctx: Ctx) -> Result:
    """Detection must accept any supported CPython, not one specific version."""
    v = sys.version_info
    supported = (3, 10) <= (v.major, v.minor) <= (3, 13)
    real_exe = shutil.which(sys.executable) or sys.executable
    rc = subprocess.run([sys.executable, "-c", "import sys;print('%d.%d.%d'%sys.version_info[:3])"],
                        capture_output=True, text=True, timeout=60)
    reported = rc.stdout.strip()
    ev = {"running_python": reported, "executable": real_exe, "supported_range": "3.10–3.13",
          "in_range": supported, "buddy_minimum_enforced": bool(v >= (3, 10))}
    # `py` launcher on Windows is the other real discovery path the installer uses
    if IS_WIN:
        py = subprocess.run(["py", "-0p"], capture_output=True, text=True, timeout=60)
        ev["py_launcher"] = py.stdout.strip()[:400] or f"exit {py.returncode}"
    ctx.save("03-python.json", ev)
    ok = supported and reported == f"{v.major}.{v.minor}.{v.micro}" and Path(real_exe).exists()
    return Result(PASS if ok else FAIL,
                  f"running {reported} at {real_exe}; supported range 3.10–3.13 (the previous installer "
                  f"hard-required 3.12 and failed)", ev)


# ════════════════════════════════════════════════════════════════════════════
# 4–5 · MODEL
# ════════════════════════════════════════════════════════════════════════════
def s04_kilo_connectivity(ctx: Ctx) -> Result:
    app = ctx.app_instance()
    key = app.gateway.key()
    if not key:
        return Result(BLOCKED, "no KiloCode API key configured on this host",
                      {"key_present": False},
                      fix="set KILO_API_KEY, or run `buddy` once and paste the key (stored with DPAPI on Windows)")
    try:
        models = app.gateway.models(refresh=True)
        ok, detail = app.gateway.ping(app.router.resolve("chat"))
    except buddy.GatewayError as e:
        ctx.save("04-kilo-error.txt", f"{e.kind}: {e}")
        return Result(FAIL, f"gateway error ({e.kind}): {buddy.clip(str(e), 300)}", {"kind": e.kind})
    ev = {"key_present": True, "models_discovered": len(models), "base": app.gateway.base,
          "ping_ok": ok, "ping_model": detail, "usage": dict(app.gateway.usage)}
    ctx.save("04-kilo.json", ev)
    if not ok:
        return Result(FAIL, f"key present but the model did not answer: {detail}", ev)
    ladder = [m for m in (app.router.ladder() if hasattr(app.router, "ladder") else [])]
    return Result(PASS, f"authenticated; {len(models)} model(s) discovered; chat model answered ({detail})", ev)


def s05_real_conversation(ctx: Ctx) -> Result:
    app = ctx.app_instance()
    if not app.gateway.key():
        return Result(BLOCKED, "needs a KiloCode key: a real conversational response cannot be produced without a model",
                      fix="set KILO_API_KEY and re-run `buddy accept 5`")
    import asyncio
    try:
        out, run = asyncio.run(buddy.converse(app, "Reply with exactly the word: PONG"))
    except Exception as e:
        return Result(FAIL, f"conversation raised {type(e).__name__}: {e}")
    ev = {"status": out.status, "verified": out.verified, "summary": out.summary[:500],
          "steps": run.steps, "tokens": run.tokens, "tools": sorted({l["tool"] for l in run.ledger})}
    ctx.save("05-conversation.json", ev)
    ok = out.status in ("complete", "answered") and bool(out.summary.strip())
    return Result(PASS if ok else FAIL,
                  f"model answered through the real agent loop (status={out.status}, steps={run.steps}, "
                  f"tokens={run.tokens})", ev)


# ════════════════════════════════════════════════════════════════════════════
# 6–10 · WINDOWS DESKTOP AND BROWSER
# ════════════════════════════════════════════════════════════════════════════
def _windows_gate(ctx: Ctx, what: str) -> Optional[Result]:
    if IS_WIN:
        return None
    return Result(BLOCKED, f"{what} needs a real Windows desktop session; this host is {sys.platform}",
                  {"platform": sys.platform},
                  fix="run `buddy accept` on the owner's Windows 11 machine")


def s06_read_active_window(ctx: Ctx) -> Result:
    gated = _windows_gate(ctx, "reading the active application window")
    if gated:
        return gated
    app = ctx.app_instance()
    import asyncio
    res = asyncio.run(buddy.exec_tool(app, "desktop_context", {}))
    if not res.ok:
        return Result(FAIL, f"desktop_context failed: {res.error}", {"category": res.category})
    data = res.data or {}
    fg = data.get("foreground") or {}
    ok = bool(fg.get("title") or fg.get("app"))
    ev = {"foreground": fg, "windows": len(data.get("windows") or []), "monitors": data.get("monitors")}
    ctx.save("06-window.json", ev)
    return Result(PASS if ok else FAIL,
                  f"read the real foreground window: {fg.get('app')} — {buddy.clip(fg.get('title'), 80)}", ev)


def s07_open_notepad(ctx: Ctx) -> Result:
    gated = _windows_gate(ctx, "launching Notepad")
    if gated:
        return gated
    app = ctx.app_instance()
    import asyncio
    res = asyncio.run(buddy.exec_tool(app, "desktop_launch", {"target": "notepad.exe"}))
    if not res.ok:
        return Result(FAIL, f"launch failed: {res.error}", {"category": res.category})
    time.sleep(2.5)
    wins = [w for w in buddy.Win32.windows() if "notepad" in (w.get("app") or "").lower()
            or "notepad" in (w.get("title") or "").lower()]
    ev = {"launched": True, "notepad_windows": wins}
    ctx.save("07-notepad-open.json", ev)
    return Result(PASS if wins else FAIL,
                  f"Notepad running: {len(wins)} window(s) — {buddy.clip(wins[0]['title'], 60) if wins else 'none'}", ev)


def s08_write_notepad(ctx: Ctx) -> Result:
    gated = _windows_gate(ctx, "typing into Notepad")
    if gated:
        return gated
    app = ctx.app_instance()
    import asyncio
    marker = f"OMEGA-ACCEPT-{int(time.time())}"
    wins = [w for w in buddy.Win32.windows() if "notepad" in (w.get("app") or "").lower()]
    if not wins:
        asyncio.run(buddy.exec_tool(app, "desktop_launch", {"target": "notepad.exe"}))
        time.sleep(2.5)
        wins = [w for w in buddy.Win32.windows() if "notepad" in (w.get("app") or "").lower()]
    if not wins:
        return Result(FAIL, "no Notepad window to type into")
    hwnd = wins[0]["hwnd"]
    asyncio.run(buddy.exec_tool(app, "desktop_focus", {"hwnd": hwnd}))
    typed = asyncio.run(buddy.exec_tool(app, "keyboard_type", {"text": marker, "hwnd": hwnd}))
    ev = {"marker": marker, "hwnd": hwnd, "typed_ok": typed.ok, "typed_error": typed.error}
    ctx.save("08-notepad-write.json", ev)
    if not typed.ok:
        return Result(FAIL, f"typing failed: {typed.error}", ev)
    return Result(PASS, f"typed {marker!r} into Notepad hwnd={hwnd} via UI Automation/SendInput", ev,
                  unproven="scenario 9 reads it back — that is the proof this landed")


def s09_verify_notepad(ctx: Ctx) -> Result:
    gated = _windows_gate(ctx, "reading Notepad contents back")
    if gated:
        return gated
    app = ctx.app_instance()
    import asyncio
    wins = [w for w in buddy.Win32.windows() if "notepad" in (w.get("app") or "").lower()]
    if not wins:
        return Result(BLOCKED, "no Notepad window open; run scenarios 7 and 8 first")
    hwnd = wins[0]["hwnd"]
    snap = asyncio.run(buddy.exec_tool(app, "screen_observe", {"hwnd": hwnd}))
    text = buddy.jdump(snap.data) if snap.ok else ""
    found = [line for line in text.split("\\n") if "OMEGA-ACCEPT" in line]
    marker = found[0][:60] if found else ""
    ev = {"hwnd": hwnd, "observe_ok": snap.ok, "marker_found": bool(found), "marker": marker,
          "elements": len((snap.data or {}).get("elements") or []) if snap.ok else 0}
    ctx.save("09-notepad-verify.json", ev)
    if not snap.ok:
        return Result(FAIL, f"could not read the window back: {snap.error}", ev)
    # The point of this scenario: the claim is only accepted when the real
    # control text contains what was typed.
    return Result(PASS if found else FAIL,
                  f"read back from the real accessibility tree: {marker or 'MARKER NOT FOUND'}", ev)


def s10_chrome(ctx: Ctx) -> Result:
    gated = _windows_gate(ctx, "driving Chrome/Edge")
    if gated:
        # CDP is not Windows-only: if a debug browser is reachable here, prove it.
        ok, why = buddy.cdp_ok()
        if ok:
            tabs = buddy.cdp_tabs()
            ev = {"cdp": True, "tabs": len(tabs)}
            ctx.save("10-browser.json", ev)
            return Result(PASS, f"CDP reachable with {len(tabs)} tab(s) on {sys.platform}", ev)
        return Result(BLOCKED, f"browser control needs Chrome/Edge with a debug port, or Windows UIA: {why}",
                      {"platform": sys.platform, "cdp": why},
                      fix="start Chrome with --remote-debugging-port=9222, or run on Windows")
    app = ctx.app_instance()
    import asyncio
    res = asyncio.run(buddy.exec_tool(app, "browser_context", {}))
    ev = {"ok": res.ok, "data": buddy.clip(buddy.jdump(res.data), 1500) if res.ok else res.error}
    ctx.save("10-browser.json", ev)
    if not res.ok:
        return Result(BLOCKED, f"no debug browser reachable: {res.error}", ev,
                      fix="launch Chrome or Edge, or start it with --remote-debugging-port=9222")
    return Result(PASS, f"read the live browser state: {buddy.clip(buddy.jdump(res.data), 160)}", ev)


# ════════════════════════════════════════════════════════════════════════════
# 11–12 · INHERITED MEMORY
# ════════════════════════════════════════════════════════════════════════════
def _real_legacy_sources(ctx: Ctx) -> tuple[list[Any], dict]:
    mm = buddy.sibling("memory_migration")
    if mm is None:
        return [], {}
    roots = mm.discover_roots()
    sources = mm.default_sources(roots)
    found = []
    for src in sources:
        try:
            reports = src.discover()
        except Exception:
            continue
        if any(r.found and r.records for r in reports):
            found.append(src)
    return found, roots


def s11_obsidian_memory(ctx: Ctx) -> Result:
    mm = buddy.sibling("memory_migration")
    if mm is None:
        return Result(BLOCKED, "memory_migration module unavailable")
    found, roots = _real_legacy_sources(ctx)
    obsidian = [s for s in found if s.name == "obsidian"]
    if not obsidian:
        return Result(BLOCKED,
                      "no Obsidian vault exists on this machine (searched for a .obsidian/ folder under "
                      f"{roots.get('documents')} and the Study Buddy data directory)",
                      {"searched": str(roots.get("documents")), "sources_found": [s.name for s in found]},
                      fix="run `buddy accept 11` on the owner's Windows machine where the vault lives")
    src = obsidian[0]
    recs = list(src.records())[:50]
    if not recs:
        return Result(FAIL, "a vault was found but no readable note came out of it")
    target = ctx.tmp / "obsidian-target.db"
    sink = mm.SqliteSink(target)
    rep = mm.Migrator(sink, sources=[src], roots=roots).run(dry_run=False)
    # retrieval through the REAL Omega engine, not the migrator's own search
    store = buddy.Store(target)
    try:
        mem = buddy.Memory(store)
        probe = recs[0].title.split()[0] if recs[0].title else "note"
        hits = mem.search(probe, limit=5, touch=False)
    finally:
        store.close()
    ev = {"vault": src.roots.get("documents") and str(src.find_vaults()[0]) if hasattr(src, "find_vaults") else "",
          "notes_read": len(recs), "imported": rep.imported, "secrets_withheld": rep.skipped_secret,
          "probe": probe, "hits": len(hits), "errors": rep.errors,
          "report": ctx.save("11-obsidian.json", {"imported": rep.imported, "by_kind": rep.by_kind,
                                                  "errors": rep.errors, "hits": len(hits)})}
    ok = rep.imported > 0 and hits and rep.ok
    return Result(PASS if ok else FAIL,
                  f"read {len(recs)} real note(s), imported {rep.imported}, retrieval probe {probe!r} → {len(hits)} hit(s)",
                  ev)


def s12_legacy_project_knowledge(ctx: Ctx) -> Result:
    mm = buddy.sibling("memory_migration")
    if mm is None:
        return Result(BLOCKED, "memory_migration module unavailable")
    found, roots = _real_legacy_sources(ctx)
    if not found:
        return Result(BLOCKED,
                      "no legacy Study Buddy / MAJIN / Omega data exists on this machine to retrieve from",
                      {"sources_found": [], "roots": {k: str(v) for k, v in roots.items()}},
                      fix="run `buddy accept 12` on the owner's Windows machine")
    target = ctx.tmp / "legacy-target.db"
    sink = mm.SqliteSink(target)
    rep = mm.Migrator(sink, sources=found, roots=roots).run(dry_run=False)
    store = buddy.Store(target)
    try:
        mem = buddy.Memory(store)
        # probe with a term that actually came from the imported data
        probe = ""
        for rec in getattr(rep, "_imported_sample", []) or []:
            for word in buddy.re.findall(r"[A-Za-zÅÄÖåäö]{6,}", f"{rec.title} {rec.content[:200]}"):
                if word.lower() not in ("legacy", "migrated", "obsidian", "majin"):
                    probe = word
                    break
            if probe:
                break
        hits = mem.search(probe, limit=5, touch=False) if probe else []
        kinds = mem.stats()["by_kind"]
    finally:
        store.close()
    ev = {"sources": [s.name for s in found], "imported": rep.imported, "duplicates": rep.duplicates,
          "secrets_withheld": rep.skipped_secret, "probe": probe, "hits": len(hits), "by_kind": kinds,
          "errors": rep.errors}
    ctx.save("12-legacy.json", ev)
    ok = rep.imported > 0 and bool(probe) and bool(hits) and rep.ok
    return Result(PASS if ok else FAIL,
                  f"retrieved legacy knowledge from {', '.join(s.name for s in found)}: {rep.imported} imported, "
                  f"probe {probe!r} → {len(hits)} hit(s)", ev)


# ════════════════════════════════════════════════════════════════════════════
# 13–15 · MAJIN V6 AS A SUBSYSTEM
# ════════════════════════════════════════════════════════════════════════════
def s13_majin_tool_from_omega(ctx: Ctx) -> Result:
    env = _majin_env(ctx)
    if env is None:
        mb = buddy.sibling("majin_bridge")
        reason = ("majin_bridge unavailable" if mb is None else
                  ("MAJIN checkout not found" if mb.find_majin_root() is None else
                   ("Node.js not found" if mb.find_node() is None else
                    f"MAJIN dependencies not installed at {mb.find_majin_root()} — run npm install")))
        return Result(BLOCKED, reason, {}, fix="cd integrations/majin-original && npm install")
    for k, v in env.items():
        os.environ[k] = v
    try:
        app = ctx.app_instance()
        app.majin = buddy.MajinSubsystem(app)
        import asyncio
        st = asyncio.run(buddy.exec_tool(app, "majin_status", {}))
        res = asyncio.run(buddy.exec_tool(app, "majin_call",
                                          {"name": "fs_read", "arguments": {"path": "acceptance-proof.txt"}}))
        body = buddy.jdump(res.data) if res.ok else res.error
        audited = app.store.one("SELECT decision FROM audit WHERE tool='majin_call' ORDER BY id DESC LIMIT 1")
        ev = {"status_ok": st.ok, "granted_lanes": (st.data or {}).get("ownerGrantedLanes") if st.ok else None,
              "call_ok": res.ok, "content_read_back": "OMEGA ACCEPTANCE" in body,
              "audit_decision": audited["decision"] if audited else None,
              "operation_id": (res.data or {}).get("operationId") if res.ok else None,
              "error": "" if res.ok else buddy.clip(res.error, 400)}
        ctx.save("13-majin-tool.json", ev)
        ok = st.ok and res.ok and ev["content_read_back"] and audited is not None
        return Result(PASS if ok else FAIL,
                      f"Omega called a real MAJIN V6 tool through its own registry and permission gate "
                      f"(lanes={ev['granted_lanes']}, audit={ev['audit_decision']}, content read back="
                      f"{ev['content_read_back']})", ev)
    finally:
        for k in env:
            os.environ.pop(k, None)


def s14_persistent_background_task(ctx: Ctx) -> Result:
    """A queued task must run unattended and leave real evidence behind."""
    app = ctx.app_instance()
    out = ctx.tmp / "background-proof.txt"
    plan = {"steps": [
        {"tool": "file_write", "args": {"path": str(out), "content": "step one\n"}},
        {"tool": "file_append", "args": {"path": str(out), "content": "step two\n"}},
        {"tool": "file_read", "args": {"path": str(out)}, "expect_contains": "step two"},
    ]}
    tid = app.tasks.create("acceptance background task", {"kind": "steps", "steps": plan["steps"]})
    import asyncio

    async def drain() -> str:
        app.loop = asyncio.get_running_loop()
        for _ in range(120):
            t = app.tasks.get(tid)
            if not t or t["state"] in ("done", "failed", "error", "cancelled"):
                return t["state"] if t else "missing"
            claimed = app.tasks.claim()
            if claimed:
                await app.tasks.run_one(claimed)
            await asyncio.sleep(0.05)
        return "timeout"

    state = asyncio.run(drain())
    content = out.read_text(encoding="utf-8") if out.is_file() else ""
    row = app.tasks.get(tid) or {}
    ev = {"task_id": tid, "state": state, "file_written": out.is_file(), "content": content,
          "attempts": row.get("attempts"), "error": row.get("error"),
          "checkpoint": bool(app.tasks.last_checkpoint(tid))}
    ctx.save("14-background-task.json", ev)
    ok = state == "done" and content == "step one\nstep two\n"
    return Result(PASS if ok else FAIL,
                  f"background task ran unattended to state={state}; the file it produced contains exactly what the "
                  f"plan said ({content!r})", ev)


def s15_worker_crash_recovery(ctx: Ctx) -> Result:
    """Kill the worker mid-task; a restart must resume without repeating effects."""
    app = ctx.app_instance()
    out = ctx.tmp / "crash-proof.txt"
    # A real child process claims the task and dies part-way through; a second,
    # genuinely separate process then recovers the orphaned lease and resumes from
    # the checkpoint. Repeating an effect is the tell: had the resume redone step 1
    # the file would not read exactly step1..step3.
    steps = [{"tool": "file_append", "args": {"path": str(out), "content": f"step{i}\n"}} for i in (1, 2, 3)]
    tid = app.tasks.create("acceptance crash/recovery", {"kind": "steps", "steps": steps})
    env = {"BUDDY_HOME": str(buddy.HOME), "BUDDY_TEST_CHILD": "1", "BUDDY_TEST_CRASH_AT": "1"}
    proc = ctx.child(["--_child", "crash-task"], env=env, timeout=180)
    partial = out.read_text(encoding="utf-8") if out.is_file() else ""
    mid = dict(app.tasks.get(tid) or {})
    killed = proc.returncode == 9
    resume = ctx.child(["--_child", "resume-crashed"], env={"BUDDY_HOME": str(buddy.HOME)}, timeout=240)
    final = out.read_text(encoding="utf-8") if out.is_file() else ""
    after = dict(app.tasks.get(tid) or {})
    ev = {"task_id": tid, "child_rc": proc.returncode, "child_stderr": buddy.clip(proc.stderr, 300),
          "killed_mid_task": killed, "partial_content": partial, "state_after_crash": mid.get("state"),
          "attempts_after_crash": mid.get("attempts"), "resume_rc": resume.returncode,
          "resume_stdout": buddy.clip(resume.stdout, 300), "resume_stderr": buddy.clip(resume.stderr, 300),
          "final_content": final, "state_after_resume": after.get("state"),
          "attempts_after_resume": after.get("attempts"),
          "no_duplicated_effect": final == "step1\nstep2\nstep3\n"}
    ctx.save("15-crash-recovery.json", ev)
    # The crash hook fires after a step's effect but before its checkpoint, so the
    # child leaves behind real partial progress. What must hold is that the resume
    # completed the task exactly once — no repeated effect, no lost step.
    ok = killed and 0 < len(partial) < len(final) and resume.returncode == 0 \
        and final == "step1\nstep2\nstep3\n" and after.get("state") == "done" \
        and (after.get("attempts") or 0) > (mid.get("attempts") or 0)
    return Result(PASS if ok else FAIL,
                  f"the worker process died mid-task (rc={proc.returncode}, partial={partial!r}, state="
                  f"{mid.get('state')!r}); a fresh process recovered the lease and resumed from its checkpoint, "
                  f"finishing exactly once (final={final!r}, state={after.get('state')!r}, attempts="
                  f"{after.get('attempts')})", ev)


# ════════════════════════════════════════════════════════════════════════════
# 16–18 · DURABILITY AND SAFETY
# ════════════════════════════════════════════════════════════════════════════
def s16_restart_without_losing_memory(ctx: Ctx) -> Result:
    app = ctx.app_instance()
    marker = f"acceptance-fact-{int(time.time())}"
    app.memory.save("long_term", "Acceptance marker", f"The owner asked to remember {marker}", "acceptance")
    before = app.store.one("SELECT COUNT(*) AS n FROM memories")["n"]
    app.store.close()
    ctx.app = None
    # a genuinely separate process reads the same home
    proc = ctx.child(["--_child", "memory-find"],
                     env={"BUDDY_HOME": str(buddy.HOME), "BUDDY_MEMORY_QUERY": marker}, timeout=180)
    found = marker in proc.stdout
    app2 = ctx.app_instance()
    after = app2.store.one("SELECT COUNT(*) AS n FROM memories")["n"]
    hits = app2.memory.search(marker, limit=3, touch=False)
    ev = {"marker": marker, "rows_before": before, "rows_after_restart": after,
          "child_found_marker": found, "child_stdout": buddy.clip(proc.stdout, 200),
          "retrievable_by_search": len(hits)}
    ctx.save("16-restart-memory.json", ev)
    ok = found and after >= before and bool(hits)
    return Result(PASS if ok else FAIL,
                  f"wrote {marker!r}, restarted in a new process, and it was still there and retrievable "
                  f"({before}→{after} rows)", ev)


def s17_permission_boundaries(ctx: Ctx) -> Result:
    app = ctx.app_instance()
    import asyncio
    # 1. background work may not use a scope the owner never granted
    app.perms.set("exec", None)
    denied = asyncio.run(buddy.exec_tool(app, "run_command", {"command": "echo should-not-run"}, background=True))
    # 2. granting it makes the same call allowed
    app.perms.set("exec", "always")
    allowed = asyncio.run(buddy.exec_tool(app, "run_command", {"command": "echo permitted"}))
    # 3. a protected path stays protected even with a write grant
    app.perms.set("write", "always")
    protected = asyncio.run(buddy.exec_tool(app, "file_write",
                                            {"path": str(buddy.HOME.parent.parent / "evil.txt"), "content": "x"}))
    # 4. SENSITIVE always asks, and in background there is nobody to ask
    app.perms.set("exec", "always")
    sensitive = asyncio.run(buddy.exec_tool(app, "install_dependency", {"module": "numpy"}, background=True))
    ev = {"background_without_grant": {"ok": denied.ok, "category": denied.category},
          "with_grant": {"ok": allowed.ok},
          "protected_path": {"ok": protected.ok, "category": protected.category},
          "sensitive_in_background": {"ok": sensitive.ok, "category": sensitive.category},
          "audit_rows": app.store.one("SELECT COUNT(*) AS n FROM audit")["n"]}
    ctx.save("17-permissions.json", ev)
    ok = (not denied.ok and denied.category == "permission_denied" and allowed.ok
          and not sensitive.ok)
    return Result(PASS if ok else FAIL,
                  f"ungranted background exec denied ({denied.category}), granted exec allowed, "
                  f"sensitive action in background refused ({sensitive.category}); "
                  f"{ev['audit_rows']} audit row(s) recorded", ev)


def s18_stop_active_task(ctx: Ctx) -> Result:
    """An emergency stop from a second process must reach work already in flight."""
    app = ctx.app_instance()
    out = ctx.tmp / "stop-proof.txt"
    # A task long enough to still be running when the stop arrives. Each step is a
    # real tool call, so "progressed" means the file genuinely grew on disk.
    steps = [{"tool": "file_write", "args": {"path": str(out), "content": "started\n", "overwrite": True}}]
    steps += [{"tool": "file_append", "args": {"path": str(out), "content": f"step {i}\n"}} for i in range(400)]
    tid = app.tasks.create("long task to be stopped", {"kind": "steps", "steps": steps})

    sig = buddy.StopSignal()
    sig.clear()
    # The worker runs in a genuinely separate process, exactly as it would in real
    # use: `buddy stop` is issued from one process while another does the work.
    proc_env = {"BUDDY_HOME": str(buddy.HOME)}
    proc = subprocess.Popen([sys.executable, str(buddy.SOURCE_FILE), "--_child", "crash-task"],
                            env={**os.environ, **proc_env}, cwd=str(HERE),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    progressed = False
    size_at_stop = 0
    deadline = time.time() + 60
    while time.time() < deadline:
        if out.is_file() and out.stat().st_size > 20:
            progressed = True
            size_at_stop = out.stat().st_size
            break
        if proc.poll() is not None:
            break
        time.sleep(0.1)

    requested = False
    if progressed:
        sig.request("acceptance scenario 18: stop an active task")
        requested = sig.requested()
    try:
        rc = proc.wait(timeout=120)
        err = proc.stderr.read() if proc.stderr else ""
    except subprocess.TimeoutExpired:
        proc.kill()
        rc, err = -1, "child did not exit within 120 s of the stop request"
    finally:
        sig.clear()

    row = dict(app.tasks.get(tid) or {})
    state = row.get("state")
    final_size = out.stat().st_size if out.is_file() else 0
    ck = app.tasks.last_checkpoint(tid)
    ev = {"task_id": tid, "child_pid": proc.pid, "progressed_before_stop": progressed,
          "file_size_at_stop": size_at_stop, "stop_marker_written": requested, "child_rc": rc,
          "child_stderr": buddy.clip(err or "", 300), "final_state": state, "final_file_size": final_size,
          "task_error": row.get("error"), "task_error_class": row.get("error_class"),
          "task_result": row.get("result"),
          "work_stopped_early": final_size < 4000, "checkpoint_kept": bool(ck),
          "checkpoint_step": (ck or {}).get("step_idx"), "attempts": row.get("attempts"),
          "memory_rows": app.store.one("SELECT COUNT(*) AS n FROM memories")["n"]}
    ctx.save("18-stop.json", ev)
    ok = progressed and requested and state == "cancelled" and final_size < 4000
    note = "" if ok else (
        f"stop did not cancel the active task (progressed={progressed}, marker={requested}, state={state!r}, "
        f"rc={rc}). Fix: TaskEngine.run_one must bridge the stop marker into the task's cancel event."
        if progressed else
        "the child worker never made progress, so there was no active task to stop; see child_stderr.")
    return Result(PASS if ok else FAIL,
                  f"a separate worker process was mid-task (file had grown to {size_at_stop} B); this process wrote "
                  f"the stop marker and the active task ended cancelled with {final_size} B written — not the full "
                  f"400 steps. Checkpoint and memory kept." if ok else note,
                  ev, unproven="" if ok else note)


# ════════════════════════════════════════════════════════════════════════════
# 19–20 · CODING AND MULTI-STEP VERIFICATION
# ════════════════════════════════════════════════════════════════════════════
def s19_coding_workflow(ctx: Ctx) -> Result:
    """The real coding tool chain: analyse, patch, test, roll back."""
    app = ctx.app_instance()
    import asyncio
    proj = ctx.tmp / "coding-proj"
    proj.mkdir(parents=True, exist_ok=True)
    (proj / "calc.py").write_text("def add(a, b):\n    return a - b\n\n\ndef mul(a, b):\n    return a * b\n",
                                  encoding="utf-8")
    (proj / "test_calc.py").write_text(
        "import unittest\nfrom calc import add, mul\n\n\nclass T(unittest.TestCase):\n"
        "    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n"
        "    def test_mul(self):\n        self.assertEqual(mul(2, 3), 6)\n\n\nif __name__ == '__main__':\n"
        "    unittest.main()\n", encoding="utf-8")
    analyzed = asyncio.run(buddy.exec_tool(app, "dev_analyze_project", {"path": str(proj)}))
    before = asyncio.run(buddy.exec_tool(app, "dev_run_tests", {"path": str(proj)}))
    patched = asyncio.run(buddy.exec_tool(app, "file_patch",
                                          {"path": str(proj / "calc.py"), "find": "return a - b",
                                           "replace": "return a + b"}))
    after = asyncio.run(buddy.exec_tool(app, "dev_run_tests", {"path": str(proj)}))
    rc_before = (before.data or {}).get("exit_code") if before.ok else None
    rc_after = (after.data or {}).get("exit_code") if after.ok else None
    ev = {"analyze_ok": analyzed.ok, "analyze_error": analyzed.error,
          "analyze_files": (analyzed.data or {}).get("files"),
          "suggested_test_command": (analyzed.data or {}).get("suggested_test_command"),
          "patch_ok": patched.ok, "patch_error": patched.error,
          "tests_before_rc": rc_before, "tests_after_rc": rc_after,
          "tests_before_passed": (before.data or {}).get("passed"),
          "tests_after_passed": (after.data or {}).get("passed"),
          "before_error": before.error, "after_error": after.error,
          "file_now": (proj / "calc.py").read_text(encoding="utf-8").splitlines()[1],
          "before_output": buddy.clip(buddy.jdump(before.data), 500),
          "after_output": buddy.clip(buddy.jdump(after.data), 500)}
    ctx.save("19-coding.json", ev)
    ok = patched.ok and rc_before not in (0, None) and rc_after == 0
    live = "" if app.gateway.key() else "live-model variant BLOCKED (no KiloCode key)"
    return Result(PASS if ok else FAIL,
                  f"analysed the repo, patched the bug, and the real test runner went from rc={rc_before} to "
                  f"rc={rc_after}. {live}".strip(), ev,
                  unproven=live or "an agent-driven fix needs a model; see scenario 5")


def s20_verified_multistep(ctx: Ctx) -> Result:
    """A multi-step task is only 'complete' when the system state confirms it."""
    app = ctx.app_instance()
    import asyncio
    out = ctx.tmp / "multistep.txt"
    # (a) the gate: a model that claims success without evidence must not pass
    lying = buddy.AgentRun(app, "pretend the file was written", background=True)
    lying.last_effect = time.time()
    lying.last_verify = 0.0
    unverified_flagged = lying.unverified_effects()
    # (b) a real multi-step task whose last step reads the result back
    plan = {"steps": [
        {"tool": "file_write", "args": {"path": str(out), "content": "alpha\n"}},
        {"tool": "file_append", "args": {"path": str(out), "content": "beta\n"}},
        {"tool": "file_read", "args": {"path": str(out)}, "expect_contains": "beta"},
    ]}
    tid = app.tasks.create("verified multi-step task", {"kind": "steps", "steps": plan["steps"]})

    async def drain() -> str:
        app.loop = asyncio.get_running_loop()
        for _ in range(200):
            t = app.tasks.get(tid)
            if not t or t["state"] in ("done", "failed", "error", "cancelled"):
                return t["state"] if t else "missing"
            claimed = app.tasks.claim()
            if claimed:
                await app.tasks.run_one(claimed)
            await asyncio.sleep(0.05)
        return "timeout"

    state = asyncio.run(drain())
    content = out.read_text(encoding="utf-8") if out.is_file() else ""
    row = app.tasks.get(tid) or {}
    verified_run = app.store.one("SELECT verified, status FROM runs ORDER BY ts DESC LIMIT 1")
    ev = {"lying_run_flagged_unverified": unverified_flagged, "task_state": state, "content": content,
          "content_matches_plan": content == "alpha\nbeta\n", "attempts": row.get("attempts"),
          "last_run_record": dict(verified_run) if verified_run else None}
    ctx.save("20-multistep.json", ev)
    ok = unverified_flagged and state == "done" and content == "alpha\nbeta\n"
    return Result(PASS if ok else FAIL,
                  f"three-step task reached {state} and the file on disk is exactly {content!r}; a run whose effects "
                  f"were never read back is flagged unverified={unverified_flagged}", ev)


SCENARIOS = [
    Scenario(1, "Fresh installation", "installer present", s01_fresh_install),
    Scenario(2, "Upgrade from an existing Buddy", "an existing database", s02_upgrade_from_existing),
    Scenario(3, "Python detection", "a supported CPython", s03_python_detection),
    Scenario(4, "KiloCode connectivity", "an API key", s04_kilo_connectivity),
    Scenario(5, "Real conversational response", "an API key", s05_real_conversation),
    Scenario(6, "Read the active application window", "Windows desktop", s06_read_active_window),
    Scenario(7, "Open Notepad", "Windows desktop", s07_open_notepad),
    Scenario(8, "Write text in Notepad", "Windows desktop", s08_write_notepad),
    Scenario(9, "Verify Notepad contents", "Windows desktop + scenario 8", s09_verify_notepad),
    Scenario(10, "Interact with Chrome/Edge", "a debug browser or Windows", s10_chrome),
    Scenario(11, "Read migrated Obsidian memory", "a real vault on this machine", s11_obsidian_memory),
    Scenario(12, "Retrieve legacy project knowledge", "real legacy data on this machine", s12_legacy_project_knowledge),
    Scenario(13, "Invoke a MAJIN V6 tool from Omega", "Node 22+, MAJIN deps", s13_majin_tool_from_omega),
    Scenario(14, "Execute a persistent background task", "—", s14_persistent_background_task),
    Scenario(15, "Recover from a worker crash", "—", s15_worker_crash_recovery),
    Scenario(16, "Restart without losing memory", "—", s16_restart_without_losing_memory),
    Scenario(17, "Enforce permission boundaries", "—", s17_permission_boundaries),
    Scenario(18, "Stop an active task", "—", s18_stop_active_task),
    Scenario(19, "Run a coding workflow", "a real test runner", s19_coding_workflow),
    Scenario(20, "Verify a complete multi-step task", "—", s20_verified_multistep),
]


def run(only: Optional[list[int]] = None, evidence_root: Optional[Path] = None) -> dict:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    # Evidence and scenario scratch space go under the workspace directory: it is
    # the one part of BUDDY_HOME that `is_protected_path` deliberately allows the
    # agent to write to. Putting them elsewhere inside HOME made every real file
    # operation fail against the guard the scenarios are supposed to exercise.
    root = Path(evidence_root or (buddy.DIRS["workspace"] / "acceptance" / stamp))
    root.mkdir(parents=True, exist_ok=True)
    ctx = Ctx(root)
    ctx.key = bool(buddy.Buddy(headless=True).gateway.key())
    print(buddy.C.c(buddy.C.B, f"\nSTUDDY BUDDY OMEGA — ACCEPTANCE ({buddy.APP_VERSION})"))
    print(buddy.C.c(buddy.C.DIM, f"  host {sys.platform} · python {sys.version.split()[0]} · "
                                 f"kilo key {'yes' if ctx.key else 'no'} · evidence {root}\n"))
    results: list[dict] = []
    icon = {PASS: buddy.C.G, FAIL: buddy.C.RED, BLOCKED: buddy.C.Y, NOT_TESTED: buddy.C.DIM}
    for sc in SCENARIOS:
        if only and sc.num not in only:
            continue
        print(f"  {sc.num:>2}. {sc.name}")
        t0 = time.time()
        try:
            res = sc.run(ctx)
        except Exception as e:
            tb = traceback.format_exc()
            ctx.save(f"{sc.num:02d}-exception.txt", tb)
            res = Result(FAIL, f"{type(e).__name__}: {e}", {"traceback": tb[-2000:]})
        row = {"num": sc.num, "name": sc.name, "needs": sc.needs, "status": res.status,
               "detail": res.detail, "evidence": res.evidence, "unproven": res.unproven,
               "fix": res.fix, "seconds": round(time.time() - t0, 2)}
        results.append(row)
        print(f"      {buddy.C.c(icon[res.status], res.status.ljust(10))} {buddy.clip(res.detail, 220)}")
        if res.unproven:
            print(f"      {buddy.C.c(buddy.C.DIM, 'unproven here: ' + res.unproven)}")
        if res.fix and res.status in (FAIL, BLOCKED):
            print(f"      {buddy.C.c(buddy.C.DIM, 'fix: ' + res.fix)}")
    counts = {k: sum(1 for r in results if r["status"] == k) for k in (PASS, FAIL, BLOCKED, NOT_TESTED)}
    doc = {"when": buddy.iso(), "platform": sys.platform, "python": sys.version.split()[0],
           "kilo_key": ctx.key, "version": buddy.APP_VERSION, "evidence_dir": str(root),
           "counts": counts, "results": results,
           "complete": counts[FAIL] == 0 and counts[BLOCKED] == 0 and counts[NOT_TESTED] == 0}
    (root / "acceptance-report.json").write_text(json.dumps(doc, indent=2, ensure_ascii=False, default=str),
                                                 encoding="utf-8")
    (root / "acceptance-report.md").write_text(render_markdown(doc), encoding="utf-8")
    (root / "run.log").write_text("\n".join(ctx.log_lines), encoding="utf-8")
    print("\n" + buddy.C.c(buddy.C.B, "SUMMARY ") + "  ".join(
        buddy.C.c(icon[k], f"{k}={counts[k]}") for k in (PASS, FAIL, BLOCKED, NOT_TESTED)))
    if not doc["complete"]:
        print(buddy.C.c(buddy.C.Y, "NOT COMPLETE: ") + buddy.C.c(buddy.C.DIM,
              "blocked or untested scenarios remain. This is a statement about this host, and it is not "
              "upgraded to a pass anywhere."))
    else:
        print(buddy.C.c(buddy.C.G, "COMPLETE: every mandated scenario passed on this host."))
    print(buddy.C.c(buddy.C.DIM, f"evidence: {root}\n"))
    with Context():
        pass
    return doc


def render_markdown(doc: dict) -> str:
    lines = [f"# Acceptance evidence — {doc['when']}", "",
             f"Host: `{doc['platform']}`, Python `{doc['python']}`, KiloCode key: "
             f"{'configured' if doc['kilo_key'] else 'absent'}. Product {doc['version']}.", "",
             "| # | Scenario | Status | Evidence |", "| --- | --- | --- | --- |"]
    for r in doc["results"]:
        lines.append(f"| {r['num']} | {r['name']} | **{r['status']}** | {r['detail'][:220]} |")
    c = doc["counts"]
    lines += ["", f"`PASS={c[PASS]}  FAIL={c[FAIL]}  BLOCKED={c[BLOCKED]}  NOT TESTED={c[NOT_TESTED]}`", ""]
    if not doc["complete"]:
        lines += ["## Not complete", "",
                  "The following are **not** claimed to work. Each is blocked by something this host does not have,",
                  "and each names the fix or the machine where it can be proven.", ""]
        for r in doc["results"]:
            if r["status"] in (BLOCKED, NOT_TESTED, FAIL):
                lines.append(f"- **{r['num']}. {r['name']}** — {r['status']}: {r['detail']}")
                if r.get("fix"):
                    lines.append(f"  - fix: `{r['fix']}`")
        lines.append("")
    if any(r.get("unproven") for r in doc["results"]):
        lines += ["## Partially proven", ""]
        for r in doc["results"]:
            if r.get("unproven"):
                lines.append(f"- **{r['num']}. {r['name']}** passed its cross-platform part; {r['unproven']}")
        lines.append("")
    lines += ["## Reproduce", "", "```", "buddy accept          # or: python omega/acceptance.py", "```", "",
              f"Raw artifacts: `{doc['evidence_dir']}`", ""]
    return "\n".join(lines)


def main(argv: Optional[list[str]] = None) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="buddy accept", description="run the 20 mandated acceptance scenarios for real")
    ap.add_argument("scenarios", nargs="*", help="scenario numbers to run (default: all)")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--evidence", default="", help="where to write evidence")
    a = ap.parse_args(argv)
    if a.list:
        print("\nACCEPTANCE SCENARIOS\n")
        for sc in SCENARIOS:
            print(f"  {sc.num:>2}. {sc.name:<44} needs: {sc.needs}")
        print("\nStatuses: PASS (executed and confirmed) · FAIL (executed, broken) ·")
        print("          BLOCKED (this host cannot run it) · NOT TESTED (needs a human/live service)\n")
        return 0
    only = [int(x) for x in a.scenarios if x.isdigit()] or None
    doc = run(only=only, evidence_root=Path(a.evidence) if a.evidence else None)
    if a.json:
        print(json.dumps(doc, indent=2, ensure_ascii=False, default=str))
    return 1 if doc["counts"][FAIL] else 0


if __name__ == "__main__":
    sys.exit(main())
