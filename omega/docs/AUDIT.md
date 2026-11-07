# PHASE 1 — Complete codebase audit and capability adjudication

Audited at commit `2fe4ee0` of `main`, branch `arena/c543ec4e-ai-teammates`.
Every row below was established by reading the source and, where possible, by
executing the existing test suite in this environment (Linux, Python 3.11.2,
Node v22.22.3). Nothing here is inferred from documentation alone.

## 0. What actually exists

| Codebase | Location | Size | Language | Executed here |
| --- | --- | --- | --- | --- |
| Omega single-file agent | `studdy-buddy/omega/buddy.py` → now `omega/buddy.py` | 4 942 lines | Python 3.10+ | `--self-test`: **PASS 11 / FAIL 0 / BLOCKED 8 / NOT TESTED 4** |
| Study Buddy TS packages | `studdy-buddy/packages/*` (core, cli, agent-core, ai-router, voice-engine, learning-engine, database, curriculum, quiz-engine, packet-tracer, shared) | 11 packages | TypeScript | not run (no `node_modules`; root `package.json` is a different Next.js app) |
| Study Buddy Electron desktop | `studdy-buddy/archive/electron-desktop/` | archived | TS/Electron | archived by the team's own decision (`BUILD_STATUS.md`) — **not resurrected** |
| Browser extension | `studdy-buddy/apps/browser-extension/` | MV3 | JS | static only |
| MAJIN V1–V5 | `integrations/majin-original/src/{core,v2,v3,v4,v5}`, `bin/majin*.mjs` | ~823 source files | Node 22 ESM | parse-checked; full suite needs `npm install` |
| **MAJIN V6** | `integrations/majin-original/src/v6/` (+ `jobs/`) | 4 112 lines, 22 modules | Node 22 ESM | `node --test test/v6/*.test.js` → **48 pass / 0 fail** after `npm install` (31/36 without deps; the 5 failures were `ERR_MODULE_NOT_FOUND: zod`, i.e. missing install, not defects) |
| MAJIN desktop/tests/CI | `desktop/`, `test/` (266 files), `.github/workflows/` (70+) | — | — | not run |
| Repo root Next.js app | `app/`, `components/`, `db/`, `queries/`, `trigger/` | — | TS | unrelated to the companion product; **left untouched** |

Important negative finding: the local legacy data the owner wants migrated
(Obsidian vault, MAJIN V5 profile, V6 home, previous Omega home, old Study
Buddy state) **does not exist in this repository**. Only four empty-ish
`.majin-matrix-ws-*` test workspaces are committed. Migration must therefore be
a *discovery-driven utility that runs on the owner's Windows machine*, not a
data import performed here. Claiming otherwise would be a fabrication.

## 1. Capability-by-capability adjudication

"Strongest" = the implementation that is (a) real, (b) tested, (c) closest to
the required behaviour. The loser is **not deleted**; it stays in the tree as an
archive/reference and is simply not on the runtime path.

| Capability | Omega `buddy.py` | Study Buddy TS | MAJIN V6 | Winner & why |
| --- | --- | --- | --- | --- |
| Agent orchestration loop | `AgentRun` UNDERSTAND→DISCOVER→PLAN→OBSERVE→ACT→VERIFY→RECOVER→COMPLETE, `_compact`, `_footer`, `_handle_finish` | `packages/agent-core/loop.ts` | supervisor runs queued tasks, no model loop | **Omega** — only one with a verification gate that refuses a lying model (test `K`) |
| Tool registry / discovery | `Registry` + `ToolSpec` + `search()`, 61 tools, lazy activation (`tool_search`) | tool lists | `filterCatalog` over the V5 driver catalog (157 entries, 93 available) | **Omega** for the host registry; **MAJIN** for its own catalog, exposed *through* Omega |
| Permission system | `Permissions` (scopes, standing grants, audit rows), `Risk` levels, `is_protected_path`, confirm callbacks | `agent-core/permissions.ts` | `policy.js` lanes + `owner-mode.json` grants, fail-closed on revoke | **Both, layered** — Omega gates the call, MAJIN re-checks its own lane. Neither is bypassed |
| Windows control (Win32) | `Win32`: windows, foreground, focus, monitors, SendInput type/press/click/scroll, screenshot, launch | `core/windows.ts` via `agent-desktop` binary | none | **Omega** — direct ctypes, no helper binary to install |
| UI Automation / a11y tree | `UIA`: snapshot with depth/node/time budgets, ref resolution, read/click/set_text/find | `windows-app-catalog.ts` | none | **Omega** |
| Browser automation | CDP client (`cdp_tabs`/`cdp_call`), `browser_context`, navigate, DOM read, DOM click/type, eval + SSRF guard | `browser-bridge.ts` | `browser_*` tools through the V5 driver (semantic + shadow + recovery, heavily tested) | **Omega CDP** as the primary path (no extra deps); **MAJIN browser tools** reachable as ordinary tools for owner-granted portal work |
| Command execution | `run_command`, PowerShell tool, `run_proc` with budgets + `kill` | pty in cli | driver `shell` lane | **Omega** |
| File operations | list/read/info/search/write/append/patch/copy/move/trash, protected-path guard, backups | fs tools | `fs_*` driver tools | **Omega** |
| Coding tools | `dev_analyze`, `dev_run_tests` (+ test-framework detection), `dev_install`, rollback | — | — | **Omega** |
| Voice | `Voice`: VAD, faster-whisper STT (sv+en), SAPI/edge-tts playback, barge-in, device diagnostics | `voice-engine` | `node-edge-tts` | **Omega** — only one with mic diagnostics + interruption handling |
| Memory | `Memory` on SQLite: kinds, tags, status, run verification, FTS-ish keyword search, recency touch, conversation summarization, Obsidian export | `obsidian-memory.ts`, `study-vault.ts` | **not implemented** (V6 ACCEPTANCE row 9) | **Omega** — and it is the target of the migration |
| Obsidian | `export_obsidian` (write) | `obsidian-memory.ts` (read/write vault) | none | **Omega** for runtime; **Study Buddy's vault layout** informs the migration reader |
| Gmail | none | `gmail-connector.ts` | `gmail.js` OAuth2 read-only client + verifier classifier, permission-checked, masked, tested with fixtures; live BLOCKED | **MAJIN** |
| GitHub | none | `debug-sync.ts` | `sync.js` private-repo telemetry push, verifies `private: true` before upload, no `gh` dependency | **MAJIN** |
| MCP | none | none | `mcp.js` real JSON-RPC 2.0 stdio server, 11 tools, protocol negotiation, idempotent `operationId` receipts | **MAJIN** — and Omega becomes an MCP *client* of it |
| Job search & applications | none | none | `jobs/hunter.js` + `store.js` + `state.js`: discovery, candidate separation, exclusions, canonical-URL dedupe, CV scoring, lifecycle state machine, evidence rules, quota; portal submit adapter NOT_IMPLEMENTED | **MAJIN** (only implementation) |
| Persistent tasks / queues | `TaskEngine`: SQLite queue, deps, claim/lease, checkpoints, `recover(stale_after)`, retries, cancel | — | `queue.js` (500 lines) JSONL durable queue: leases, heartbeats, dedupe keys, budgets, deps, irreversible-effect ledger | **Both, different jobs** — Omega's for agent turns, MAJIN's for long detached worker runs. Omega can hand work to MAJIN's queue |
| Workers / job queues | in-process background runs | — | `supervisor.js` + `worker-state.js` + watchdog + STOP marker + crash recovery | **MAJIN** |
| Model routing | `Gateway` (Kilo, dual base-URL probing, typed network errors) + `Router` (roles, ladder, escalate, rejects unlisted ids) | `ai-router/*` (provider, keychain, explanation) | none (OpenCode owns the model) | **Omega** |
| Autopilot / scheduling | `TaskEngine.create(run_at=...)` + self-test `L` proves an unattended run | — | scheduled automation via queue | **Omega**, with MAJIN queue as the durable backend for long jobs |
| Watchdogs | task `recover()` on stale leases | `live-observer` staleness | supervisor watchdog + heartbeat files + stall events | **MAJIN** for workers, **Omega** for agent tasks |
| Skills | `Skills`: propose → isolated run → test → approve → register; tamper + unapproved refused (test `T6`) | `verified-skills.ts` | V6 row 10 NOT_IMPLEMENTED | **Omega** |
| Error recovery / self-repair | `classify_error`, `ToolError`/`Unavailable`/`Stale`, retry blocking, recovery strategies in the run loop | — | `ToolInvocationError` with `uncertain`/`retryable`, permanent-code set | **Both** — the `uncertain` concept is imported into Omega's recovery vocabulary |
| Diagnostics | `Doctor` with honest PASS/FAIL/BLOCKED + `print_report` | `capability-proof.ts`, `live-proof.ts` | `majin-v6 doctor --json` (16 checks) | **Omega** as the aggregator; MAJIN doctor becomes one section |
| Installation | none (previous installer failed on missing Python 3.12) | `auto-setup.ts`, `Install-Latest-Windows.ps1` (archived) | `install.ps1`, `scripts/v6/start-v6.ps1`, `build-installer.mjs` | **New** — `omega/install/install.ps1` built from the failure analysis in §3 |
| Level 1–100 progression | none | none | MAJIN_100_STATUS / backlog docs (concept only) | **New** — `omega/level.py`, measured |

## 2. Runtime topology decided (PHASE 2)

One product, one command, one agent engine, two runtimes:

```
            owner types:  buddy
                              │
                    omega/launcher/buddy.cmd  (PATH shim, no logic)
                              │
                    omega/buddy.py            ← THE agent: CLI, loop, memory,
                              │                  permissions, tools, voice,
                              │                  tasks, skills, level, doctor
                              │
              ┌───────────────┼────────────────────────┐
              │               │                        │
        native Python    omega/majin_bridge.py    omega/memory_migration.py
        Win32/UIA/CDP     │  (persistent child)   omega/level.py
                          │                       omega/acceptance.py
                    node bin/majin-v6.mjs mcp
                    (JSON-RPC 2.0 over stdio)
                          │
              MAJIN V6: queue · supervisor · workers · leases ·
                        heartbeats · dedupe · job hunter · Gmail ·
                        sync · V5 driver tool catalog (157 tools)
```

Rules that keep this from becoming three competing engines:

1. **One model runtime.** Only Omega talks to Kilo. MAJIN V6 keeps its designed
   property of adding no provider — the bridge never asks it to.
2. **One host registry.** MAJIN tools appear inside Omega's `Registry` as
   ordinary `ToolSpec`s, so Omega's permission gate, risk classification, audit
   log, verification footer and compaction apply to them unchanged. MAJIN's own
   lane policy still runs *inside* MAJIN — a grant in Omega never widens MAJIN.
3. **Lazy discovery, not a tool dump.** The model gets `majin_search` /
   `majin_schema` / `majin_call` plus the durable-work tools; the 157-entry
   catalog is searched, never pasted into context.
4. **No copying.** MAJIN is executed in place from
   `integrations/majin-original`. Nothing is vendored, nothing is rewritten.
5. **Absent MAJIN is not fatal.** No Node, no `npm install`, no V5 profile →
   the bridge reports BLOCKED with the real reason and Omega keeps full native
   capability.

## 3. Why the previous installer failed, and the fix

Observed cause: the installer assumed a specific Python (3.12) and hard-failed
when it was missing, and `buddy.py` itself exits unless `>= 3.10`.

Fix implemented in `omega/install/install.ps1`:
accept **any** CPython 3.10–3.13 found on `PATH`, in the `py` launcher, or in
the usual install roots; only if none qualifies, install one (winget →
python.org fallback) *for the current user*, no admin required; then build an
isolated venv, pin deps, detect Node ≥ 22 for the MAJIN bridge (optional,
degrades to BLOCKED), preserve `%APPDATA%\StuddyBuddy`, offer the memory
migration, write a `buddy` shim to a user PATH directory, and keep a
timestamped rollback of the previous release. `buddy doctor` re-verifies the
whole chain afterwards.

## 4. Verification baseline before this work

| Suite | Command | Result in this environment |
| --- | --- | --- |
| Omega engine | `python omega/buddy.py --self-test` | PASS 11 · FAIL 0 · BLOCKED 8 · NOT TESTED 4 |
| MAJIN V6 | `node --test test/v6/*.test.js` (after `npm install`) | 48 pass · 0 fail |
| Windows desktop / voice / Notepad / live model | — | **BLOCKED**: this host is Linux with no desktop session, no microphone and no Kilo key |

The BLOCKED set is carried forward unchanged into `omega/docs/ACCEPTANCE.md`
and is *not* reported as passing anywhere in this repository.
