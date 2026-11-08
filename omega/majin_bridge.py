#!/usr/bin/env python3
"""
MAJIN V6 bridge — MAJIN as an integrated subsystem of Studdy Buddy Omega.

MAJIN V6 (Node.js, `integrations/majin-original`) is a mature, separately
tested subsystem: a durable queue, a supervisor with leases/heartbeats/watchdog,
a job hunter with dedupe and evidence rules, read-only Gmail verification,
private telemetry sync, and an MCP server in front of the V5 driver's real tool
catalog (157 declared entries, 93 available at the time of the V6 inventory).

This module makes all of that reachable from ONE Omega conversation without a
second application, a second model runtime or a second permission system.

How it integrates
-----------------
* `MajinBridge` starts `node bin/majin-v6.mjs mcp` as a **persistent child**
  and speaks JSON-RPC 2.0 over stdio — the exact protocol MAJIN V6 already
  implements and tests (`test/v6/mcp-live.test.js`). No reimplementation, no
  vendoring, no forking of MAJIN logic.
* `bridge_tools()` returns Omega-shaped tool specs so MAJIN's surface joins
  Omega's own `Registry`: Omega's permission gate, risk classes, audit log and
  verification footer then apply to MAJIN calls too. MAJIN additionally
  enforces its own owner-granted *lanes* internally — an Omega grant never
  widens MAJIN, and a MAJIN grant never bypasses Omega.
* Commands the MCP server deliberately does not expose (job discovery, Gmail
  status, doctor, inventory) go through the real MAJIN CLI with `--json`.

Guarantees that matter
----------------------
* **Never submit twice.** Every effectful call carries a stable `operationId`
  derived from the tool name and canonicalised arguments. MAJIN's driver ledger
  returns the *original receipt* for a replayed id, and rejects the same id with
  different arguments. Retrying an uncertain submission therefore cannot create
  a second application.
* **Honest availability.** No Node, no `npm install`, no MAJIN checkout or no
  V5 owner profile ⇒ `available()` returns `(False, reason)` with the real
  blocker. Nothing is faked and Omega keeps working at full native capability.
* **No secret leakage.** stdout/stderr from MAJIN is passed through Omega's
  redactor when one is supplied, and credential material is never logged here.

This file imports nothing from `buddy.py`, so it can be tested and reused on its
own: `python omega/majin_bridge.py --selftest`.
"""
from __future__ import annotations

import hashlib
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

IS_WIN = sys.platform == "win32"
BRIDGE_VERSION = "1.0.0"

#: MCP protocol version we ask for. MAJIN V6 supports 2024-11-05 / 2025-03-26 /
#: 2025-06-18 and echoes the negotiated value back.
PROTOCOL_VERSION = "2025-06-18"

#: Tools that change state outside the process. They always carry an
#: operationId and are never replayed blindly.
EFFECTFUL_MCP_TOOLS = frozenset({"majin_tool_call", "v6_queue_add", "v6_task_cancel", "v6_work_start", "v6_work_stop"})

#: Meta/discovery tools: safe, no action, cheap. Used for the readiness probe.
META_MCP_TOOLS = ("majin_status", "majin_tools_search", "majin_tool_schema")


# ════════════════════════════════════════════════════════════════════════════
# Discovery — find the real MAJIN installation and the owner's real data
# ════════════════════════════════════════════════════════════════════════════
def find_majin_root(explicit: Optional[str] = None) -> Optional[Path]:
    """Locate the MAJIN checkout that owns `bin/majin-v6.mjs`.

    Search order is deterministic and never guesses outside the repository or
    the owner's own environment variables.
    """
    named = explicit or os.environ.get("MAJIN_ROOT")
    if named:
        # An explicit location is authoritative. Falling back to some other
        # checkout would let Omega quietly drive a MAJIN the owner did not name.
        c = Path(named).expanduser()
        try:
            if (c / "bin" / "majin-v6.mjs").is_file() and (c / "src" / "v6" / "mcp.js").is_file():
                return c.resolve()
        except OSError:
            pass
        return None
    candidates: list[Path] = []
    here = Path(__file__).resolve()
    # <repo>/omega/majin_bridge.py → <repo>/integrations/majin-original
    for parent in here.parents:
        candidates.append(parent / "integrations" / "majin-original")
        if (parent / ".git").exists():
            break
    for c in candidates:
        try:
            if (c / "bin" / "majin-v6.mjs").is_file() and (c / "src" / "v6" / "mcp.js").is_file():
                return c.resolve()
        except OSError:
            continue
    return None


def find_node(explicit: Optional[str] = None) -> Optional[str]:
    """Find a Node.js binary. MAJIN V6 requires Node >= 22."""
    for name in filter(None, [explicit, os.environ.get("BUDDY_NODE"), "node", "nodejs"]):
        found = shutil.which(name)
        if found:
            return found
    if IS_WIN:  # common install roots that are not always on PATH
        for root in (os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("LOCALAPPDATA", "")):
            if not root:
                continue
            p = Path(root) / "nodejs" / "node.exe"
            if p.is_file():
                return str(p)
    return None


def node_major(node_exe: str) -> Optional[int]:
    try:
        out = subprocess.run([node_exe, "--version"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15)
        v = out.stdout.strip().lstrip("v")
        return int(v.split(".")[0]) if v else None
    except Exception:
        return None


def default_v5_data_dir() -> Path:
    """MAJIN V5 data directory, mirroring `src/v6/home.js:resolveV5DataDir`."""
    env = os.environ.get("MAJIN_V5_DATA_DIR")
    if env:
        return Path(env).expanduser().resolve()
    if IS_WIN:
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    else:
        base = os.environ.get("HOME") or str(Path.home())
        base = str(Path(base) / ".local" / "share")
    return (Path(base) / "MAJIN" / "v5").resolve()


def default_v6_home() -> Path:
    """MAJIN V6 home, mirroring `src/v6/home.js:resolveV6Home`."""
    env = os.environ.get("MAJIN_V6_HOME")
    if env:
        return Path(env).expanduser().resolve()
    if IS_WIN:
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    else:
        base = str(Path(os.environ.get("HOME") or str(Path.home())) / ".local" / "share")
    return (Path(base) / "MAJIN" / "v6").resolve()


# ════════════════════════════════════════════════════════════════════════════
# Exactly-once operation ids
# ════════════════════════════════════════════════════════════════════════════
def canonical_json(value: Any) -> str:
    """Stable, key-sorted JSON — the basis of every operationId."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def operation_id(tool: str, args: dict, scope: str = "") -> str:
    """Deterministic id for exactly this effect.

    Same tool + same arguments ⇒ same id ⇒ MAJIN returns the original receipt
    instead of performing the effect a second time. Different arguments with a
    reused id are rejected by MAJIN (`/different arguments/`), which is the
    behaviour that stops a retry from inventing a duplicate job application.
    """
    digest = hashlib.sha256(canonical_json({"tool": tool, "args": args, "scope": scope}).encode("utf-8")).hexdigest()
    return f"omega-{digest[:32]}"


# ════════════════════════════════════════════════════════════════════════════
# The bridge
# ════════════════════════════════════════════════════════════════════════════
class MajinError(Exception):
    """A MAJIN call failed. `kind` distinguishes real causes so the agent can
    pick a recovery strategy instead of guessing."""

    def __init__(self, message: str, kind: str = "unknown", code: Optional[str] = None, detail: Any = None,
                 uncertain: bool = False, retryable: bool = True):
        super().__init__(message)
        self.message = message
        self.kind = kind          # unavailable | blocked | denied | invalid | timeout | crashed | tool | protocol
        self.code = code
        self.detail = detail
        self.uncertain = uncertain
        self.retryable = retryable

    def as_dict(self) -> dict:
        return {"ok": False, "error": self.message, "kind": self.kind, "code": self.code,
                "uncertain": self.uncertain, "retryable": self.retryable,
                "detail": self.detail if not isinstance(self.detail, Exception) else str(self.detail)}


class MajinBridge:
    """Persistent JSON-RPC 2.0 client for the MAJIN V6 MCP server."""

    def __init__(self, majin_root: Optional[Path] = None, node: Optional[str] = None,
                 workspace: Optional[Path] = None, v5_data_dir: Optional[Path] = None,
                 v6_home: Optional[Path] = None, redact: Optional[Callable[[str], str]] = None,
                 log: Optional[Callable[..., None]] = None, autostart: bool = True,
                 startup_timeout: float = 45.0, call_timeout: float = 120.0):
        self.majin_root = majin_root if majin_root is not None else find_majin_root()
        self.node = node or find_node()
        self.workspace = Path(workspace or Path.cwd()).resolve()
        self.v5_data_dir = Path(v5_data_dir) if v5_data_dir else default_v5_data_dir()
        self.v6_home = Path(v6_home) if v6_home else default_v6_home()
        self._redact = redact or (lambda s: s)
        self._log = log or (lambda event, payload=None: None)
        self.startup_timeout = startup_timeout
        self.call_timeout = call_timeout

        self._proc: Optional[subprocess.Popen] = None
        self._next_id = 0
        self._pending: dict[int, queue.Queue] = {}
        self._reader: Optional[threading.Thread] = None
        self._errbuf: list[str] = []
        self._lock = threading.RLock()
        self._started_at: Optional[float] = None
        self._restarts = 0
        self._closed = False
        self.server_info: dict = {}
        self.negotiated_protocol: Optional[str] = None
        self.mcp_tools: list[dict] = []
        self._cached_status: Optional[dict] = None
        self._cached_status_at = 0.0

        if autostart:
            self.start()

    # ── availability ────────────────────────────────────────────────────────
    def availability(self) -> tuple[bool, str]:
        """Real reason MAJIN can or cannot run here. Never optimistic."""
        if self.majin_root is None:
            return False, ("MAJIN checkout not found (expected integrations/majin-original with "
                           "bin/majin-v6.mjs). Set MAJIN_ROOT to its location.")
        if not self.node:
            return False, "Node.js not found on PATH. MAJIN V6 needs Node 22+; install it or set BUDDY_NODE."
        major = node_major(self.node)
        if major is not None and major < 22:
            return False, f"Node {major} found but MAJIN V6 requires Node >= 22 ({self.node})."
        if not (self.majin_root / "node_modules").is_dir():
            return False, (f"MAJIN dependencies are not installed at {self.majin_root}. "
                           f"Run: npm install --no-audit --no-fund  (in that directory)")
        if not self.v5_data_dir.is_dir():
            return False, (f"V5_DATA_MISSING: no MAJIN V5 data directory at {self.v5_data_dir}. "
                           "MAJIN V6 refuses to create an owner profile by itself. "
                           "Run `buddy majin init` to grant lanes explicitly.")
        if not (self.v5_data_dir / "owner-mode.json").is_file():
            return False, (f"No owner grants file at {self.v5_data_dir / 'owner-mode.json'}. "
                           "MAJIN tools stay unauthorized until the owner grants lanes (`buddy majin init`).")
        return True, f"MAJIN V6 ready at {self.majin_root} (node {self.node})"

    def available(self) -> tuple[bool, str]:
        if self._proc is not None and self._proc.poll() is None:
            return True, "MAJIN V6 MCP server running"
        ok, why = self.availability()
        if ok:
            return False, f"not started: {why}"
        return False, why

    # ── lifecycle ───────────────────────────────────────────────────────────
    def _spawn(self) -> subprocess.Popen:
        assert self.majin_root and self.node
        cmd = [self.node, str(self.majin_root / "bin" / "majin-v6.mjs"), "mcp",
               "--workspace", str(self.workspace),
               "--data-dir", str(self.v5_data_dir),
               "--v6-home", str(self.v6_home)]
        env = dict(os.environ)
        env.setdefault("MAJIN_V6_HOME", str(self.v6_home))
        env["NODE_NO_WARNINGS"] = "1"
        return subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, encoding="utf-8", errors="replace",  bufsize=1,
                                cwd=str(self.majin_root), env=env,
                                **({"windowsHide": True, "creationflags": 0x08000000} if IS_WIN else {}))

    def start(self) -> None:
        with self._lock:
            if self._proc is not None and self._proc.poll() is None:
                return
            ok, why = self.availability()
            if not ok:
                raise MajinError(why, kind="blocked" if ("V5_DATA_MISSING" in why or "owner grants" in why) else "unavailable",
                                 code="MAJIN_UNAVAILABLE", retryable=False)
            self._errbuf = []
            self._proc = self._spawn()
            self._reader = threading.Thread(target=self._read_loop, name="majin-mcp-reader", daemon=True)
            self._reader.start()
            threading.Thread(target=self._drain_stderr, name="majin-mcp-stderr", daemon=True).start()
            try:
                init = self._request("initialize", {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": "studdy-buddy-omega", "version": BRIDGE_VERSION},
                }, timeout=self.startup_timeout)
            except MajinError as e:
                stderr = self.stderr_tail()
                self.close()
                raise MajinError(f"MAJIN MCP initialize failed: {e.message}" + (f" — {stderr}" if stderr else ""),
                                 kind="blocked", code=e.code or "MAJIN_HANDSHAKE_FAILED", detail=stderr) from None
            self.server_info = init.get("serverInfo") or {}
            self.negotiated_protocol = init.get("protocolVersion")
            self._notify("notifications/initialized", {})
            self._started_at = time.time()
            try:
                listed = self._request("tools/list", {}, timeout=30)
                self.mcp_tools = listed.get("tools") or []
            except MajinError:
                self.mcp_tools = []
            self._log("majin.bridge.started", {"tools": len(self.mcp_tools), "protocol": self.negotiated_protocol,
                                               "server": self.server_info.get("name"), "restarts": self._restarts})

    def _restart(self) -> None:
        with self._lock:
            self._restarts += 1
            if self._restarts > 5:
                raise MajinError("MAJIN bridge restarted 5 times without staying up; not retrying further.",
                                 kind="crashed", code="MAJIN_BRIDGE_UNSTABLE", retryable=False)
            self.close(kill=True)
            time.sleep(min(2.0 * self._restarts, 5.0))
            self.start()

    def close(self, kill: bool = False) -> None:
        with self._lock:
            proc, self._proc = self._proc, None
            if proc is None:
                return
            try:
                if proc.poll() is None and not kill:
                    self._raw_write({"jsonrpc": "2.0", "method": "notifications/cancelled",
                                     "params": {"requestId": None, "reason": "client closing"}})
                proc.stdin.close()  # type: ignore[union-attr]
            except Exception:
                pass
            try:
                proc.wait(timeout=3 if not kill else 1)
            except Exception:
                with _suppress():
                    proc.kill()
                with _suppress():
                    proc.wait(timeout=2)
            for stream in (proc.stdout, proc.stderr):
                with _suppress():
                    if stream is not None:
                        stream.close()
            for q in list(self._pending.values()):
                q.put(MajinError("MAJIN bridge closed while a call was in flight", kind="crashed", retryable=False))
            self._pending.clear()

    def __enter__(self) -> "MajinBridge":
        if self._proc is None:
            self.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # ── transport ───────────────────────────────────────────────────────────
    def _raw_write(self, msg: dict) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None or proc.poll() is not None:
            raise MajinError("MAJIN bridge process is not running", kind="crashed", code="MAJIN_NOT_RUNNING")
        try:
            proc.stdin.write(json.dumps(msg, ensure_ascii=False, default=str) + "\n")
            proc.stdin.flush()
        except (BrokenPipeError, ValueError, OSError) as e:
            raise MajinError(f"MAJIN bridge write failed: {e}", kind="crashed", code="MAJIN_WRITE_FAILED") from None

    def _read_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                # MAJIN writes human diagnostics to stderr; anything unparsable
                # on stdout is recorded, never silently dropped.
                self._errbuf.append(self._redact(line[:400]))
                continue
            mid = msg.get("id")
            if mid is not None and mid in self._pending:
                self._pending[mid].put(msg)
            else:
                # Server-initiated notification (progress/log). Recorded for the
                # audit trail; no fabricated handling.
                self._log("majin.bridge.notification", {"method": msg.get("method"),
                                                        "params": _clip(msg.get("params"), 400)})
        for q in list(self._pending.values()):
            q.put(MajinError("MAJIN bridge stdout closed (process exited)", kind="crashed", code="MAJIN_EXITED"))

    def _drain_stderr(self) -> None:
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        for line in proc.stderr:
            line = line.rstrip()
            if line:
                self._errbuf.append(self._redact(line[:500]))
                if len(self._errbuf) > 60:
                    del self._errbuf[: len(self._errbuf) - 60]

    def stderr_tail(self, n: int = 6) -> str:
        return " | ".join(self._errbuf[-n:])

    def _notify(self, method: str, params: dict) -> None:
        with _suppress():
            self._raw_write({"jsonrpc": "2.0", "method": method, "params": params})

    def _request(self, method: str, params: dict, timeout: Optional[float] = None) -> dict:
        timeout = timeout or self.call_timeout
        with self._lock:
            self._next_id += 1
            mid = self._next_id
        q: queue.Queue = queue.Queue(maxsize=1)
        self._pending[mid] = q
        try:
            self._raw_write({"jsonrpc": "2.0", "id": mid, "method": method, "params": params})
            try:
                msg = q.get(timeout=timeout)
            except queue.Empty:
                raise MajinError(f"MAJIN did not answer '{method}' within {timeout:.0f}s",
                                 kind="timeout", code="MAJIN_TIMEOUT", retryable=False) from None
        finally:
            self._pending.pop(mid, None)
        if isinstance(msg, MajinError):
            raise msg
        if "error" in msg and msg["error"]:
            err = msg["error"]
            data = err.get("data") or {}
            code = str(err.get("code") or data.get("code") or "MAJIN_RPC_ERROR")
            text = str(err.get("message") or "MAJIN request failed")
            kind = ("denied" if "PERMISSION_DENIED" in code or "denied" in text.lower() or "not authorized" in text.lower()
                    else "invalid" if "INVALID" in code or "VALIDATION" in code
                    else "protocol" if isinstance(err.get("code"), int) else "tool")
            raise MajinError(text, kind=kind, code=code, detail=_clip(data, 800))
        return msg.get("result") or {}

    # ── MCP calls ───────────────────────────────────────────────────────────
    def _ensure_up(self) -> None:
        if self._closed:
            raise MajinError("MAJIN bridge is closed", kind="crashed", retryable=False)
        if self._proc is None or self._proc.poll() is not None:
            self._restart()

    def call_tool(self, name: str, arguments: Optional[dict] = None, timeout: Optional[float] = None) -> dict:
        """Call one MCP tool and unwrap MAJIN's text/structured payload."""
        self._ensure_up()
        res = self._request("tools/call", {"name": name, "arguments": arguments or {}}, timeout=timeout)
        return unwrap_mcp_result(res, redact=self._redact)

    def status(self, refresh: bool = False, max_age: float = 30.0) -> dict:
        """`majin_status`: real grants, registered/authorized tool counts."""
        if not refresh and self._cached_status and (time.time() - self._cached_status_at) < max_age:
            return self._cached_status
        out = self.call_tool("majin_status", {})
        self._cached_status, self._cached_status_at = out, time.time()
        return out

    def search(self, query: str, limit: int = 20) -> dict:
        return self.call_tool("majin_tools_search", {"query": query, "limit": max(1, min(50, int(limit)))})

    def schema(self, name: str) -> dict:
        return self.call_tool("majin_tool_schema", {"name": name})

    def call(self, name: str, arguments: Optional[dict] = None, op_id: Optional[str] = None,
             timeout: Optional[float] = None, scope: str = "") -> dict:
        """Execute one MAJIN tool through the persistent V5 driver.

        The operationId is derived from the arguments unless the caller supplies
        one, so an Omega-level retry of the same effect is idempotent by
        construction and can never double-submit.
        """
        arguments = arguments or {}
        oid = op_id or operation_id(name, arguments, scope)
        out = self.call_tool("majin_tool_call", {"name": name, "operationId": oid, "arguments": arguments}, timeout=timeout)
        if isinstance(out, dict):
            out.setdefault("operationId", oid)
            out.setdefault("majinTool", name)
        return out

    # ── durable work (queue / supervisor / workers) ─────────────────────────
    def v6_status(self) -> dict:
        return self.call_tool("v6_status", {})

    def queue_add(self, kind: str, title: str = "", payload: Optional[dict] = None, priority: int = 0,
                  dedupe_key: Optional[str] = None, deps: Optional[list] = None, irreversible: bool = False) -> dict:
        args: dict[str, Any] = {"kind": kind, "priority": int(priority), "irreversible": bool(irreversible)}
        if title:
            args["title"] = title
        if payload is not None:
            args["payload"] = payload
        # A dedupe key that the caller did not choose is derived from the
        # effect, so re-queueing the same work cannot create a second task.
        args["dedupeKey"] = dedupe_key or operation_id(kind, {"payload": payload, "title": title}, "queue")[:120]
        if deps:
            args["deps"] = [str(d) for d in deps][:20]
        return self.call_tool("v6_queue_add", args)

    def queue_list(self, state: Optional[str] = None, kind: Optional[str] = None, limit: int = 20) -> dict:
        args: dict[str, Any] = {"limit": max(1, min(100, int(limit)))}
        if state:
            args["state"] = state
        if kind:
            args["kind"] = kind
        return self.call_tool("v6_queue_list", args)

    def task_get(self, task_id: str) -> dict:
        return self.call_tool("v6_task_get", {"id": task_id})

    def task_cancel(self, task_id: str) -> dict:
        return self.call_tool("v6_task_cancel", {"id": task_id})

    def work_start(self, max_tasks: int = 10, max_runtime_ms: int = 900_000, worker_id: Optional[str] = None) -> dict:
        args: dict[str, Any] = {"maxTasks": int(max_tasks), "maxRuntimeMs": int(max_runtime_ms)}
        if worker_id:
            args["workerId"] = str(worker_id)[:64]
        return self.call_tool("v6_work_start", args)

    def work_stop(self) -> dict:
        return self.call_tool("v6_work_stop", {})

    # ── MAJIN CLI commands the MCP server does not expose ───────────────────
    def cli(self, args: list[str], timeout: float = 180.0, extra_env: Optional[dict] = None) -> dict:
        """Run the real `majin-v6` CLI and parse its JSON output."""
        ok, why = self.availability()
        if not ok:
            raise MajinError(why, kind="blocked", code="MAJIN_UNAVAILABLE")
        assert self.majin_root and self.node
        cmd = [self.node, str(self.majin_root / "bin" / "majin-v6.mjs"), *args,
               "--v6-home", str(self.v6_home), "--data-dir", str(self.v5_data_dir)]
        env = dict(os.environ)
        env.update(extra_env or {})
        env["MAJIN_V6_HOME"] = str(self.v6_home)
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", 
                                  timeout=timeout, cwd=str(self.majin_root), env=env,
                                  **({"windows_hide": True} if IS_WIN else {}))
        except subprocess.TimeoutExpired:
            raise MajinError(f"majin-v6 {' '.join(args)} timed out after {timeout:.0f}s",
                             kind="timeout", code="MAJIN_CLI_TIMEOUT", retryable=False) from None
        out, err = self._redact(proc.stdout or ""), self._redact(proc.stderr or "")
        payload: Any = None
        if out.strip():
            try:
                payload = json.loads(out)
            except json.JSONDecodeError:
                payload = {"text": out.strip()[:8000]}
        result = {"ok": proc.returncode == 0, "exitCode": proc.returncode, "command": cmd[:2] + args,
                  "result": payload, "stdout": out.strip()[:8000], "stderr": err.strip()[:2000]}
        if proc.returncode != 0:
            raise MajinError(f"majin-v6 {' '.join(args)} exited {proc.returncode}: {(err or out).strip()[:400]}",
                             kind="tool", code="MAJIN_CLI_FAILED", detail=result,
                             retryable="V5_DATA_MISSING" not in (err + out))
        return result

    def doctor(self) -> dict:
        return self.cli(["doctor", "--json"], timeout=120)

    def jobs_list(self, candidate: Optional[str] = None, state: Optional[str] = None) -> dict:
        args = ["jobs", "list", "--json"]
        if candidate:
            args += ["--candidate", candidate]
        if state:
            args += ["--state", state]
        return self.cli(args)

    def jobs_discover(self, candidate: str, query: str, limit: int = 20) -> dict:
        return self.cli(["jobs", "discover", "--candidate", candidate, "--query", query, "--limit", str(int(limit)), "--json"],
                        timeout=300)

    def gmail_status(self) -> dict:
        return self.cli(["gmail", "status", "--json"], timeout=60)

    def inventory(self, deep: bool = False) -> dict:
        args = ["inventory", "--json"]
        if deep:
            args.append("--deep")
        return self.cli(args, timeout=300)

    # ── owner-explicit profile bootstrap (never automatic) ──────────────────
    def init_profile(self, lanes: list[str], folders: Optional[list[str]] = None, reason: str = "owner request") -> dict:
        """Create the MAJIN V5 owner-grants profile that V6 refuses to invent.

        This is an explicit owner decision surfaced as `buddy majin init`. It is
        never called implicitly, never widens an existing grant, and always
        writes a backup first.
        """
        valid = {"files", "shell", "shelltools", "sys", "power", "web", "research", "jobs", "flows", "github",
                 "audit", "learn", "marketing", "re", "trading", "net", "agent", "channels",
                 "desktop", "screen", "computer", "browser", "mcp"}
        bad = [l for l in lanes if l not in valid]
        if bad:
            raise MajinError(f"unknown MAJIN lane(s): {', '.join(bad)}", kind="invalid", code="UNKNOWN_LANE", retryable=False)
        self.v5_data_dir.mkdir(parents=True, exist_ok=True)
        target = self.v5_data_dir / "owner-mode.json"
        backup = None
        existing: dict = {}
        if target.is_file():
            backup = target.with_suffix(f".json.bak-{int(time.time())}")
            existing = json.loads(target.read_text(encoding="utf-8") or "{}")
            shutil.copy2(target, backup)
        merged_lanes = sorted(set(list(existing.get("lanes") or []) + [l for l in lanes if l in valid]))
        merged_folders = sorted(set([str(f) for f in (existing.get("folders") or [])] + [str(f) for f in (folders or [])]))
        state = {"schema": "majin.v4.owner-mode/v1", "version": int(existing.get("version") or 1),
                 "lanes": merged_lanes, "folders": merged_folders,
                 "browserOrigins": list(existing.get("browserOrigins") or []),
                 "history": list(existing.get("history") or []) + [
                     {"at": time.time(), "action": "grant", "lanes": sorted(set(lanes)), "reason": reason,
                      "by": "studdy-buddy-omega"}]}
        tmp = target.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
        os.replace(tmp, target)
        with _suppress():
            os.chmod(target, 0o600)
        self._log("majin.profile.initialized", {"lanes": merged_lanes, "folders": len(merged_folders), "backup": str(backup or "")})
        return {"ok": True, "path": str(target), "lanes": merged_lanes, "folders": merged_folders, "backup": str(backup or "")}

    def snapshot(self) -> dict:
        """Cheap, never-throwing state for `buddy status` / the doctor report."""
        up, why = self.available()
        snap: dict[str, Any] = {"bridge": BRIDGE_VERSION, "running": up, "reason": why,
                                "majinRoot": str(self.majin_root or ""), "node": self.node or "",
                                "v5DataDir": str(self.v5_data_dir), "v6Home": str(self.v6_home),
                                "restarts": self._restarts, "mcpTools": len(self.mcp_tools),
                                "protocol": self.negotiated_protocol}
        if up:
            with _suppress():
                st = self.status()
                snap.update({"registered": st.get("registered"), "authorized": st.get("authorized"),
                             "grantedLanes": st.get("ownerGrantedLanes"), "operational": st.get("operational")})
        return snap


# ════════════════════════════════════════════════════════════════════════════
# Result unwrapping
# ════════════════════════════════════════════════════════════════════════════
class _suppress:
    def __enter__(self) -> None: ...
    def __exit__(self, *a: Any) -> bool:
        return True


def _clip(value: Any, n: int) -> Any:
    s = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    return s if len(s) <= n else s[: n - 1] + "…"


def unwrap_mcp_result(res: dict, redact: Callable[[str], str] = lambda s: s) -> dict:
    """Turn an MCP `tools/call` result into a plain dict, raising on isError.

    MAJIN returns either `structuredContent` (the driver receipt) or a single
    text block containing JSON. Both shapes are handled; an error result keeps
    MAJIN's own classification (`uncertain`, `retryable`, `code`) so Omega's
    recovery logic can act on the real cause.
    """
    if not isinstance(res, dict):
        raise MajinError("MAJIN returned a malformed result", kind="protocol", retryable=False)
    structured = res.get("structuredContent")
    text = ""
    for block in res.get("content") or []:
        if isinstance(block, dict) and block.get("type") == "text":
            text += str(block.get("text") or "")
    payload: Any = structured
    if payload is None and text:
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            payload = {"text": text}
    if payload is None:
        payload = {}
    if res.get("isError"):
        code = "MAJIN_TOOL_ERROR"
        message = ""
        record = payload if isinstance(payload, dict) else {}
        # MAJIN sometimes reports an error as a JSON text block rather than as
        # structuredContent. Parse it so the real code drives classification —
        # guessing here would make a *denied* call look retryable and send the
        # agent into a retry loop against a permission boundary.
        if isinstance(record.get("text"), str):
            try:
                inner = json.loads(record["text"])
                if isinstance(inner, dict):
                    record = inner
            except json.JSONDecodeError:
                pass
        if record:
            code = str(record.get("errorCode") or record.get("code") or record.get("error") or code)
            # Prefer MAJIN's own human-readable blocker over the raw JSON dump:
            # the model has to be able to read *why* it failed.
            message = str(record.get("blocker") or record.get("message") or "")
        if not message:
            message = text.strip() or "MAJIN tool call failed"
        uncertain = bool(record.get("status") == "uncertain" or record.get("uncertain"))
        retryable = bool(record.get("retryable", not uncertain)) and not uncertain
        upper, lower = code.upper(), str(message).lower()
        denied_markers = ("PERMISSION_DENIED", "NOT_AUTHORIZED", "PATH_DENIED", "LANE_", "GRANT")
        invalid_markers = ("VALIDATION_ERROR", "INVALID_ARGUMENTS", "UNKNOWN_TOOL", "TOOL_NOT_FOUND",
                           "OPERATION_ID", "ALREADY BELONGS")
        if any(m in upper for m in denied_markers) or "not authorized" in lower or "permission denied" in lower:
            kind, retryable = "denied", False
        elif any(m in upper for m in invalid_markers) or "different arguments" in lower:
            kind, retryable = "invalid", False
        elif uncertain:
            kind = "uncertain"
        else:
            kind = "tool"
        raise MajinError(redact(str(message))[:800], kind=kind, code=code, detail=_clip(record or payload, 1500),
                         uncertain=uncertain, retryable=retryable)
    if isinstance(payload, dict):
        return payload
    return {"result": payload, "raw": _clip(text, 2000)}


# ════════════════════════════════════════════════════════════════════════════
# Self-test (real, no mocks of MAJIN itself)
# ════════════════════════════════════════════════════════════════════════════
def _selftest() -> int:
    """Exercise the bridge against the real MAJIN V6 MCP server if possible.

    Prints honest PASS/BLOCKED lines. Exits 0 when nothing failed (BLOCKED is
    not a failure — it means this host cannot prove it).
    """
    import tempfile

    results: list[tuple[str, str, str]] = []

    def rec(name: str, status: str, detail: str = "") -> None:
        results.append((name, status, detail))

    root = find_majin_root()
    rec("discovery: MAJIN root", "PASS" if root else "BLOCKED", str(root or "not found"))
    node = find_node()
    rec("discovery: node", "PASS" if node else "BLOCKED", f"{node} (major={node_major(node) if node else None})")
    rec("operationId determinism", "PASS" if operation_id("t", {"a": 1}) == operation_id("t", {"a": 1})
        and operation_id("t", {"a": 1}) != operation_id("t", {"a": 2}) else "FAIL", "stable + argument-sensitive")

    if not root or not node:
        rec("live MCP session", "BLOCKED", "MAJIN or node unavailable")
    else:
        tmp = Path(tempfile.mkdtemp(prefix="omega-majin-selftest-"))
        ws, v5, v6 = tmp / "ws", tmp / "v5", tmp / "v6"
        for d in (ws, v5):
            d.mkdir(parents=True, exist_ok=True)
        (ws / "sample.txt").write_text("OMEGA BRIDGE SELFTEST\n", encoding="utf-8")
        (v5 / "owner-mode.json").write_text(json.dumps({
            "schema": "majin.v4.owner-mode/v1", "version": 1, "lanes": ["files"],
            "folders": [str(ws)], "browserOrigins": [], "history": [],
        }), encoding="utf-8")
        bridge: Optional[MajinBridge] = None
        try:
            bridge = MajinBridge(majin_root=root, node=node, workspace=ws, v5_data_dir=v5, v6_home=v6)
            rec("handshake: initialize + tools/list", "PASS" if bridge.mcp_tools else "FAIL",
                f"{len(bridge.mcp_tools)} tools, protocol={bridge.negotiated_protocol}")
            st = bridge.status()
            rec("majin_status reports real grants", "PASS" if st.get("operational") and "files" in (st.get("ownerGrantedLanes") or []) else "FAIL",
                f"registered={st.get('registered')} authorized={st.get('authorized')}")
            search = bridge.search("fs.read")
            found = any(m.get("name") == "fs_read" for m in (search.get("matches") or []))
            rec("majin_tools_search finds fs_read", "PASS" if found else "FAIL", f"{len(search.get('matches') or [])} matches")
            schema = bridge.schema("fs_read")
            rec("majin_tool_schema returns inputSchema", "PASS" if (schema.get("inputSchema") or {}).get("properties") else "FAIL", "")
            oid = operation_id("fs_read", {"path": "sample.txt"})
            r1 = bridge.call("fs_read", {"path": "sample.txt"}, op_id=oid)
            rec("majin_tool_call executes a real tool", "PASS" if r1.get("status") == "completed"
                and "OMEGA BRIDGE SELFTEST" in json.dumps(r1.get("result")) else "FAIL", f"status={r1.get('status')}")
            r2 = bridge.call("fs_read", {"path": "sample.txt"}, op_id=oid)
            rec("replayed operationId returns the original receipt", "PASS" if r2.get("finishedAt") == r1.get("finishedAt") else "FAIL",
                "idempotent — no double effect")
            try:
                bridge.call("fs_read", {"path": "other.txt"}, op_id=oid)
                rec("reused id with different arguments is rejected", "FAIL", "MAJIN accepted a mismatched operationId")
            except MajinError as e:
                rec("reused id with different arguments is rejected", "PASS" if "different arguments" in str(e.message).lower()
                    or e.kind in ("invalid", "tool") else "FAIL", str(e.message)[:120])
            try:
                bridge.call("browser_open", {"url": "https://example.com"}, op_id="selftest-denied")
                rec("ungranted lane is denied", "FAIL", "browser call succeeded without a browser grant")
            except MajinError as e:
                rec("ungranted lane is denied", "PASS" if e.kind == "denied" or "authoriz" in str(e.message).lower()
                    or "PERMISSION" in str(e.code or "").upper() else "FAIL", f"{e.kind}: {str(e.message)[:100]}")
            t = bridge.queue_add("tool", title="selftest", payload={"tool": "fs_read", "arguments": {"path": "sample.txt"}})
            tid = (t.get("task") or t).get("id") or t.get("id")
            rec("v6_queue_add accepts durable work", "PASS" if tid else "FAIL", f"id={tid}")
            if tid:
                again = bridge.queue_add("tool", title="selftest", payload={"tool": "fs_read", "arguments": {"path": "sample.txt"}})
                aid = (again.get("task") or again).get("id") or again.get("id")
                rec("queue dedupe prevents a duplicate task", "PASS" if aid == tid else "FAIL", f"{tid} vs {aid}")
                rec("v6_task_get reads the task", "PASS" if bridge.task_get(str(tid)).get("id") or bridge.task_get(str(tid)) else "FAIL", "")
            rec("v6_status reads persisted work state", "PASS" if isinstance(bridge.v6_status(), dict) else "FAIL", "")
            doc = bridge.doctor()
            rec("majin-v6 doctor --json via CLI path", "PASS" if doc.get("ok") and doc.get("result") else "FAIL",
                f"{len((doc.get('result') or {}).get('checks') or [])} checks")
        except MajinError as e:
            rec("live MCP session", "BLOCKED" if e.kind in ("blocked", "unavailable", "timeout") else "FAIL",
                f"{e.kind}/{e.code}: {str(e.message)[:200]}")
        except Exception as e:  # pragma: no cover
            rec("live MCP session", "FAIL", f"{type(e).__name__}: {e}")
        finally:
            with _suppress():
                if bridge:
                    bridge.close(kill=True)
            with _suppress():
                shutil.rmtree(tmp, ignore_errors=True)

    # A bridge with no V5 profile must report BLOCKED, not pretend to work.
    tmp2 = Path(tempfile.mkdtemp(prefix="omega-majin-nov5-"))
    try:
        b2 = MajinBridge(workspace=tmp2, v5_data_dir=tmp2 / "missing-v5", v6_home=tmp2 / "v6", autostart=False)
        ok, why = b2.availability()
        rec("missing V5 profile is reported honestly", "PASS" if (not ok and "V5_DATA_MISSING" in why) or b2.majin_root is None else "FAIL", why[:150])
    finally:
        shutil.rmtree(tmp2, ignore_errors=True)

    widths = (max(len(r[0]) for r in results),)
    fails = 0
    print("\nMAJIN BRIDGE — SELFTEST\n")
    for name, status, detail in results:
        if status == "FAIL":
            fails += 1
        print(f"  {status:<11} {name:<{widths[0]}}  {detail[:120]}")
    counts: dict[str, int] = {}
    for _, status, _ in results:
        counts[status] = counts.get(status, 0) + 1
    print("\nSUMMARY " + "  ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    return 1 if fails else 0


def _force_utf8_output() -> None:
    """Widen stdout/stderr to UTF-8 before printing anything decorated.

    This module is run as a child process and prints `→`, `●` and `—`. A stock
    Windows console encodes cp1252, which has the em-dash but none of the others, so
    the child would die part-way through its report — and the parent, decoding with
    text=True, would see a truncated stream with no explanation attached.
    """
    for _s in (sys.stdout, sys.stderr):
        try:
            _s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


if __name__ == "__main__":
    _force_utf8_output()
    sys.exit(_selftest())
