# MAJIN V4 — test evidence

All commands were run in this workspace. Nothing below is a plan; each block is a
result that was actually observed.

## Environment

```
Node v22.22.3 · npm 10.9.8 · Linux x86_64 sandbox
Host: no Windows machine, no public tunnel, no model credentials
```

Consequence: every Windows- or device-dependent criterion is `NOT_STARTED` or
`BLOCKED` in the matrix. No Playwright browser binary is available here, so
UI verification is static-contract plus real HTTP asset tests, not screenshots.

## 1. V4 suite

```
$ npm run v4:test
# tests 441
# pass 440
# skipped 1
# fail 0
# skipped 0
```

| File | Tests | Covers |
|---|---:|---|
| `test/v4/security.test.js` | 22 | pairing, sessions, expiry, revocation, CSRF, origin, host allowlist, rate limit, body caps, CSP, traversal, overwrite, static escape |
| `test/v4/conversation.test.js` | 12 | streaming, persistence, idempotent replay, cancellation, scoping, deletion, goal states, receipts with SHA-256, crash reconciliation |
| `test/v4/models.test.js` | 16 | V1 config discovery, V1 live catalog reuse, cache TTL, timeout, secret-free projection, unknown model refusal, per-conversation scope, broken config, demo labelling |
| `test/v4/ui.test.js` | 12 | manifest/icons, safe areas, responsive, a11y, SW policy, asset content types, voice policy units |
| `test/v4/kernel.test.js` | 10 | manifest validation, declared permissions, rollback, opt-in, allowlist, flags |
| `test/v4/progress.test.js` | 9 | matrix structure, weights = 100, evidence required, derived score, PROGRESS.md agreement |
| `test/v4/sandbox.test.js` | 9 | env stripping, child-process tools, crash/hang containment, quarantine, permission refusal, honest tool errors |
| `test/v4/resume.test.js` | 9 | resume against recorded hashes, deleted/tampered artifacts stay BLOCKED, correction lineage, cross-device read |
| `test/v4/agent-failures.test.js` | 9 | throwing/schema-breaking/hanging tools, budget stop, strict-policy pause, prompt-injection corpus |
| `test/v4/benchmark.test.js` | 3 | benchmark pass rate, duplicate replay, refusal is FAILED |
| `test/v4/client.test.js` | 9 | conversation continuity across turns, delta assembly, tool card states, replay, cancellation, SSE parser edge cases |
| `test/v4/voice-server.test.js` | 13 | auth/CSRF, verified WAV from the V2 lane, temp cleanup, input limits, honest capabilities, a **real local subprocess** for TTS and STT, pipeline refusal, missing-binary failure |
| `test/v4/turns.test.js` | 9 | sequence ids, replay from a cursor, bounded buffer, reattach after a dropped socket, work survives a hang-up |
| `test/v4/e2e.browser.test.js` | 0 run | real-browser acceptance on 5 viewports — **skips** here, no browser binary (see below) |
| `test/v4/supervisor.test.js` | 6 | real child process: healthy start, crash → restart, crash loop gives up loudly, never-healthy host, health-failure restart, window expiry |
| `test/v4/accept.test.js` | 4 | the acceptance runner reports every real gate, refuses to claim a model without one, and its exit code follows the failures |
| `test/v4/backup.test.js` | 11 | round trip of a real data dir, tampering, missing/unlisted files, key leakage, unknown schema refused, dry run, overwrite refusal, version guard |
| `test/v4/upgrade.test.js` | 8 | clean upgrade, up-to-date, rollback on a failed gate, escalation when rollback fails, fetch/checkout classification |
| `test/v4/leaks.test.js` | 7 | bounded rate limiter and conversation cache, cache eviction loses nothing, bounded listing, abort-key collision, truncated replay |
| `test/v4/leaks2.test.js` | 3 | bounded goal cache, evicted goals reload from disk intact, in-flight goals are never evicted |
| `test/v4/mcp.test.js` | 27 | handshake, tool listing, calls, server-side errors, a server that dies, a hung server cut off by timeout, noisy stdout tolerated, stop() leaves nothing, env scrubbing, config validation, one bad server does not stop the others, MCP tools through the V2 runner, held tier needs consent, real schema passthrough, and the host: lane off by default, grant connects, revoke disconnects, broken server contained, shell string refused |
| `test/v4/updater.test.js` | 21 | signature verification, wrong key, tampered manifest, changed version, unsigned refused when a key is pinned, canonical form stability, downgrade refused, no-op, numeric version compare, hash mismatch never written, missing file aborts, atomic swap and rollback, hashTree manifest, successful run, unhealthy rollback, throwing restart treated as unhealthy, key pinning round trip |
| `test/v4/release-flow.test.js` | 7 | `v4:release` builds and self-verifies a signed manifest with no tests or node_modules, refuses without a key; `v4:setup --check` changes nothing; a real setup issues one pairing code, seeds Owner Mode, is idempotent, pins a release key; `v4:update` refuses without a channel |
| `test/v4/extract.test.js` | 18 | real ZIP parsing, DOCX text with paragraphs/tabs/entities, XLSX shared strings, PDF Flate and uncompressed streams, TJ arrays and escapes, encrypted PDF refused, scan reported as NO_TEXT_LAYER, dispatcher by extension or magic bytes, and the CV scenario end to end through an upload + `document_read` |
| `test/v4/owner-mode.test.js` | 21 | nothing granted by default, grants persist, 0600 file, folder implies files, files inert without a folder, drive roots refused (portable across platforms), inside-only path check, immediate revoke, per-lane revoke, unknown lanes refused, audit history, corrupt file degrades to nothing, live grant/revoke through the API without a restart, grant survives restart |
| `test/v4/skills.test.js` | 15 | shipped skills well formed, withheld without required lanes, withheld without required tools, degraded (not hidden) when a preferred tool is missing, bounded prompt section, malformed skill skipped, directory/name mismatch, oversized body capped, experimental hidden, phone view explains every block, `prefers` never widens access |
| `test/v4/uploads.test.js` | 16 | leaf names, executable types refused, real PNG stored with a hash, lying payloads refused, size enforced, collisions suffixed, `data:` URLs accepted, traversal impossible, sandbox headers for HTML/SVG, session + CSRF required, a photo lands in the workspace, an agent-written page is served sandboxed |
| `test/v4/tool-exposure.test.js` | 8 | a tool registered after startup reaches the model; host tools are offered when enabled; the list is bounded and every entry is valid JSON Schema; an unconvertible schema is skipped; a host tool is actually callable; with host tools ON the model sees >5 tools (the reported bug); with them OFF it sees exactly the workspace five; the capability report and the model list agree |
| `test/v4/host-tools.test.js` | 23 | lane discovery, absent lanes register nothing, tiers drive approval, held shell needs consent, a real file read, allowlist narrowing, structured V1 failures classified, protected-path refusal classified, the `v4:tools` CLI |
| `test/v4/upgrade-git.test.js` | 5 | real `git` with a real bare origin: a clean tree upgrades; uncommitted tracked changes stop it before anything moves; untracked files do not block; a failing gate rolls the real checkout back; an up-to-date repo is a no-op |
| `test/v4/crash.test.js` | 8 | every interrupted state is reconciled through legal hops (WAITING_FOR_TOOL, WAITING_FOR_APPROVAL, RUNNING, VERIFYING, PLANNING), a pre-execution goal is cancelled, a completed goal is untouched, orphaned approvals are cleared, a reconciled goal is resumable, and the boot banner announces it |
| `test/v4/journal-live.test.js` | 6 | a running turn survives the TTL, a finished one expires, ten newer turns do not evict a live one, finished turns are still bounded, a live burst is bounded generously, and a client can reattach to a turn that outlived the TTL |
| `test/v4/timeout.test.js` | 3 | a cooperative tool is told about its deadline and stops before the effect lands; a tool that ignores the signal never earns a success receipt and is recorded as TIMEOUT; a plugin worker is stopped at its call deadline |
| `test/v4/cancel.test.js` | 6 | a long tool receives a signal and stops; a template-ignoring tool still finishes as before; a cancelled turn records CANCELLED with no success receipt; a plugin worker is stopped on abort; logout stops the revoked session's turns and leaves another device running; a revoked session cannot reattach |
| `test/v4/integration.test.js` | 5 | a resumed goal appears in the conversation the user reopens (success and failure); the reopened conversation shows the live goal state; a chosen model survives a reload; telemetry records one row per finish |
| `test/v4/memory.test.js` | 8 | a saved preference reaches the model on the next turn; irrelevant memories are not injected; relevance beats noise; the section is framed as data not instructions; no empty section; a broken store cannot fail a turn; end to end across two conversations |
| `test/v4/telemetry.test.js` | 7 | a real turn records goal.start/model.call/task.result/verification/goal.finish; message text, file names and absolute paths never reach the ledger; the serializer drops unknown fields; unknown event names are refused; aggregate reads V4 data; the CLI summarises and reports "no data"; a broken ledger cannot take a turn down |
| `test/v4/context.test.js` | 8 | history is trimmed to the token budget, the newest message always survives, the system prompt is never trimmed, an oversized message is truncated with a visible marker, and the packer's own edge cases |
| `test/v4/recovery.test.js` | 4 | a flaky read tool recovers; a write tool is attempted exactly once; the retry budget is the advisor's, not a loop; a human-only failure class executes nothing and surfaces the advice |
| `test/v4/cli.test.js` | 11 | the commands the owner types, spawned as real subprocesses: doctor (text + JSON), progress, backup → verify → restore round trip, overwrite refusal, tamper detection, plugin list/quarantine, upgrade --dry, bench, unknown command |
| `test/v4/windows-installer.test.js` | 9 | the Windows task runs on battery, has no 72-hour limit, restarts on failure, changes nothing machine-wide, has a clean uninstall, refuses old Node, and does not collide with V1's task |
| `test/v4/client-dom.test.js` | 9 | **the real `app.js` executed in a real DOM (jsdom)** against a real host: boots and shows the gate, pairs, sends a message, renders a verified tool card, keeps one conversation across two messages, restores the composer, and the three failure paths — unreachable host, expired session, and a connection lost *after* `open` that is picked back up with the real answer |

## 2. Repository gates

```
$ npm run check
506/506 files parse cleanly.

$ npm run i18n
0 Swedish string literal(s) in 286 files

$ npm run v4:progress --check
67.5/100 verified points, matrix valid (exit 0)
```

## 3. Live smoke (manual, observed)

```
$ MAJIN_HOME=/tmp/majin-v4-smoke npm run v4 -- --port 7399
  MAJIN V4 / lyssnar http://127.0.0.1:7399 / modell Demo

$ curl -s localhost:7399/api/health     → 200 {"ok":true,"app":"majin"}
$ curl -s localhost:7399/api/state      → 401 UNAUTHORIZED (no session)
$ curl -s localhost:7399/              → 200 text/html (7.6 kB)

POST /api/auth/pair  (valid code)      → 200 + Set-Cookie: HttpOnly; SameSite=Strict
POST /api/chat  "Skriv filen valkomst.txt med innehåll: Hej från MAJIN"
  → tool_start workspace_write → tool_result {ok:true, verified:true}
  → goal COMPLETED, receipt sha256 44e095c7…, 26 bytes on disk
```

## 3.1 Bugs the tests found (fixed, not hidden)

| Bug | How it was caught | Fix |
|---|---|---|
| UI dropped the server's conversation id → every message started a new conversation | `client.test.js` driving real SSE bytes through the client model | client state extracted to `src/v4/ui/session.js`, server is authoritative for the id |
| Resume compared a file against its own hash → tampering was undetectable | `resume.test.js` | compare against the SHA-256 recorded when the work was done |
| Approval wait skipped a legal state hop → goal stuck in WAITING_FOR_TOOL | `agent-failures.test.js` | explicit RUNNING → WAITING_FOR_APPROVAL |
| A turn could end COMPLETED after an unrecovered tool failure | `agent-failures.test.js` | last tool outcome gates completion |
| CRLF-separated SSE stalled the client parser | `client.test.js` | line endings normalised before framing |
| Rate limiter grew one permanent entry per client address, forever | `leaks.test.js` | per-window sweep + hard cap of 10 000 buckets |
| Conversation cache kept every conversation in memory for the process lifetime | `leaks.test.js` | LRU with 200 entries; the file on disk is the truth |
| `list()` scanned and returned every conversation file | `leaks.test.js` | bounded to the 100 most recent |
| First message of two devices shared the abort key `'new'`, so one cancelled the other | `leaks.test.js` | one unique key per turn; a known conversation still supersedes its own turn |
| Pressing stop no longer stopped the turn (the journal made it outlive the socket) | `turns.test.js` | stop sends `turnId` to `/api/cancel`; the API accepts a turn id or a conversation id |
| A repeated request whose answer had been truncated replayed an empty message | `leaks.test.js` | explicit `already_handled` status instead of a blank answer; tools still never re-run |
| The goal store kept every goal object in memory for the process lifetime | `leaks2.test.js` | bounded cache that only evicts goals which are not actively executing |
| Conversation history was a fixed `slice(-30)` with no token budget, so a long chat could exceed a small model's window and fail the turn | `context.test.js` | budget-aware packing with a visible marker; the newest message and the system prompt always survive |
| The host had no telemetry at all — an always-on box with no logs cannot be debugged | `telemetry.test.js` | V2's ledger wired in: fixed field allowlist per event, so nothing the user typed can land in it |
| Memory was write-only: saved preferences never reached a new conversation | `memory.test.js` | per-turn retrieval injected as a labelled prompt section, bounded and framed as data |
| Resuming a blocked goal left no record in the conversation and no telemetry row | `integration.test.js` | the resume writes a message and a `goal.finish` row; the conversation is resolved from the message that references the goal |
| Cancelling a turn left the running tool working, and its effect landed with no receipt | `cancel.test.js` | the tool receives an AbortSignal through a per-call registry facade; plugin calls stop their worker on abort |
| A tool that overran its deadline kept running and its effect landed after the goal was failed | `timeout.test.js` | the same facade fires on the deadline too; overruns are recorded as TIMEOUT and never as success |
| The turn journal pruned and evicted turns that were still running, so a phone reconnecting to a long turn got 404 | `journal-live.test.js` | only finished turns expire or are evicted; live turns have a separate ceiling |
| Crash reconciliation attempted an illegal `VERIFYING → BLOCKED` hop and swallowed the throw, so VERIFYING and WAITING_FOR_TOOL goals were never recovered | `crash.test.js` | `interruptPath()` uses hops the state machine allows; unreconciled goals are named on the boot banner, orphaned approvals cleared |
| `upgrade` never checked `git status`, so uncommitted work could be carried across or lost | `upgrade-git.test.js` | stops before anything moves, names the files, suggests `git stash`; untracked files are still allowed |
| An `UpgradeError` in the CLI surfaced as an unhandled rejection | `cli.test.js` | printed as `STOPPED (code)` with exit 1 |
| Logging out left the turn running to completion | `cancel.test.js` | turns record their owning session; logout aborts that session's turns |

## 3.2 Browser attempt, documented

Three routes were tried for a real browser and all failed for environmental reasons:

1. `@sparticuz/chromium` (npm) — binary extracts fine but links `libnss3` with `NSS_3.30`.
2. `kaleido==0.2.1` (pypi) — bundles Chromium **and** NSS, but its NSS is 3.9 and its binary
   rejects any argv that is not its own scope JSON.
3. `electron` (npm → GitHub releases) — the downloader fails TLS verification, and the release
   asset redirects to `objects.githubusercontent.com`, which is blocked.

The portable test therefore skips with a clear reason and the exact command to run it
elsewhere. That is the honest outcome; a screenshot from a phone is not something this
sandbox can produce.

## 3.3 Acceptance runner output (this machine, demo lane)

```
$ npm run v4:accept
  PASS  host.health                  200 4.0.0-alpha
  PASS  auth.refuses_anonymous       unauthenticated /api/state -> 401
  PASS  auth.pairing_works           pair -> 200
  PASS  auth.cookie_hardened         Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000
  PASS  auth.csrf_required           chat without CSRF -> 403
  PASS  auth.cross_origin_refused    cross-origin -> 403
  PASS  chat.streams                 19 events in 72ms
  PASS  goal.tool_verified           tool result carried verified:true
  PASS  chat.completes               status completed
  PASS  goal.file_on_disk            "acceptanskörning"
  PASS  chat.conversation_id         conv_…
  PASS  persist.conversation_reloads 2 messages
  PASS  restart.goal_survives        1 goal(s) after restart
  PASS  restart.file_survives        <tmp>/workspace/accept.txt
  FAIL  model.configured             no provider configured (running the demo brain)
  PASS  tunnel.skipped               no --url given; public access not checked
  15/16 checks passed — exit 1
```

That `FAIL` is the honest state of the model lane here, and it is why `A7` keeps its
`BLOCKED` status.

## 4. What is NOT tested here

| Claim | Why not | Where it is tracked |
|---|---|---|
| Real model inference | no provider key/endpoint | matrix `A7` (BLOCKED) |
| iPhone/Android device run | no device | matrix `M10`, `H4` |
| Real-browser viewport/visual regression (layout, paint, touch) | no browser binary can be obtained here (CDN, Google storage and objects.githubusercontent are blocked; npm Chromium needs NSS ≥ 3.30) | matrix `M11`, `npm run v4:e2e` on the host |
| The client's *behaviour* (boot, pairing, send, render, conversation continuity) | — **now tested** — `test/v4/client-dom.test.js` runs the shipped `app.js` in jsdom against a real host; what it cannot prove is layout and paint | — |
| Windows logon task + restart persistence | no Windows host | matrix `H1`, `H2`, `H5` |
| Tunnel HTTPS URL | owner action required | matrix `H3` |
| Voice latency / barge-in | no device, browser-only voice | matrix `V6` |

Reproduce locally:

```
npm ci
npm run v4:test
npm run v4:progress
npm run v4:doctor
npm run v4
```

## 5. Universal-agent and updater evidence — 2026-10-23

The suite grew from 441 to 455 tests. The numbers below are from the run in this
workspace, after the fixes listed in `PROGRESS.md` were applied.

```
$ node --test --test-concurrency=1 test/v4/*.test.js
# tests 455
# pass 454
# fail 0
# skipped 1        (e2e.browser.test.js — no browser binary in this sandbox)

$ node scripts/parse-all.js
554/554 files parse cleanly.

$ node scripts/i18n-check.mjs
0 Swedish string literal(s) in 291 files

$ node scripts/v4/inventory.mjs
V1  26 modules, 139 tools: 109 integrated, 30 excluded with a reason
V2  18/51 components imported by V4
V3  0/4 components imported by V4
V4  8 built-ins, 107 tools registered on linux
every V1 module and every V2/V3 component has a recorded decision
```

### What the new tests actually run

| Test file | What is executed | What is asserted |
|---|---|---|
| `universal-agent.test.js` | real HTTP SSE provider + real V4 server + real registry, filesystem and verifier | `tools_search` → `tools_activate` → `sys_info` (absent from round 1, present from round 3) → file write → read-back; goal `COMPLETED`; `tool:workspace_write` verified with SHA-256 |
| `universal-agent.test.js` | parent turn + delegated subagent | child prompt is a subagent prompt; `agent_delegate` is not offered to the child; the child's answer reaches the parent's persisted message |
| `update-auto.test.js` | real `release.mjs` signing, real static HTTP release, real `setup.mjs` (key + channel), real `update.mjs apply` in a throwaway repo copy | install from `update.json` without env; `node_modules` survives; log line `[updated]`; unhealthy release → previous version restored; exit codes |
| `updater.test.js` | overlay activation, rollback, journal recovery | replaced files restored byte-for-byte; added files removed; dependencies untouched; interrupted update rolled back on the next run |
| `inventory.test.js` | the inventory generator itself | no undecided V1 module; totals add up; every excluded module has a real reason |
| `host-tools.test.js` | capability detection and real adapter calls | unavailable lanes register nothing; browser tools withheld without a runtime; consent still required for held tools |
| `mcp.test.js` | a real stdio MCP fixture server | handshake, tool list, call, server JSON Schema preserved in the model list, child killed on shutdown |

### Bugs found by running, not by reading

The same pass fixed: DNS lookups that always threw (`net.dns`), an unclassified
network crash (`net.http`), ignored required parameters in the adapter, a frozen
context in `agent.plan`, a lying `ok:true` from `agent.delegate`, MCP schemas lost
in the exposure layer, and two updater defects that made a successful update
unable to boot (directory swap deleting `node_modules`) or unable to download
(`files/` path mismatch). Details in `PROGRESS.md`.

### Still not executed here

Windows desktop control, the browser lane, Task Scheduler firing the update task,
`npm ci` on a real dependency change, a physical phone, and real model inference.
Each has the exact command that would settle it in `STATUS.md`.

## 6. File access, shared history and UI — 2026-10-23

```
$ node --test --test-concurrency=1 test/v4/*.test.js
# tests 479
# pass 478
# fail 0
# skipped 1        (e2e.browser.test.js — no browser binary in this sandbox)

$ node scripts/parse-all.js        558/558 files parse cleanly
$ node scripts/i18n-check.mjs      0 Swedish string literals in 293 files
$ node scripts/v4/inventory.mjs    every V1 module and V2/V3 component has a decision
$ node scripts/v4/accept.mjs         23/24 checks passed; the only FAIL is model.configured
                                     (no provider key in this environment)
```

### What is executed, not asserted

| Area | Real input | Result |
|---|---|---|
| Granted folder | `/tmp/.../Documents/Privat/CV Anders 2026.pdf`, a real PDF built byte by byte | `fs_find` returns exactly that hit; `document_read` returns `confidence: "text"` and the text |
| Denial | a real file outside every grant | `PERMISSION_DENIED` naming the path and the rule |
| Traversal | `Privat/../../Secret/losenord.txt` | refused |
| Symlink | a link inside the workspace pointing outside it | refused (judged on the real target) |
| Revocation | the same call before/after removing the folder | allowed, then refused |
| Prompt | the agent's first model call | contains the exact granted path and `fs_find` |
| Two devices | two sessions, one host | same conversation id, continued transcript, `since` delta, tombstone after delete |
| Restart | server closed with `keep: true`, started again | title, messages and archive state intact |
| Import | two V1 JSONL transcripts + `chats-index.json` | dry run writes nothing; apply creates 2; second apply creates 0; source files byte-identical |
| Growing V1 log | one line appended between two imports | merged (+1), no duplicate conversation |
| Delete while running | a registered turn in the agent | `409 TURN_RUNNING`, then `200` with `cancelled: true` |
| UI | the real `app.js` in jsdom against the real server | drawer lists/opens, search filters, rename, archive, restore, confirm-delete, reload restores the chat |

### Not executed here

Anything that requires Windows: the real filesystem paths (`C:\Users\…`), Windows junctions, the
desktop lanes, Task Scheduler, and the phone. The same code path is exercised on Linux with real
files; the Windows check is one command on the host (`npm run v4:accept -- --url …`) and is listed
under BLOCKED in `STATUS.md` until that output exists.

## 7. Multi-agent orchestration — 2026-10-23

The architect's review said V4 had approximated V1's teams and V2's scheduler
instead of replacing them. This pass reuses both engines unchanged and executes
their leaves with V4 subagents. `test/v4/orchestration.test.js` drives the real
chain (scripted OpenAI-compatible provider → real V4 server → real registry):

| Assertion | Evidence |
|---|---|
| Dependencies respected: three graph steps, `b` depends on `a` | all three child runs observed, `b` executed after `a` |
| Results flow forward: `b` receives `a`'s answer | `b`'s task text contains `Results from earlier steps` and `[a]` |
| Artifacts verified and lifted onto the parent goal | file on disk is byte-exact; parent goal carries a verified `subagent.verify` |
| Roster/blackboard persist in V1's layout | `workspace/teams/demo/roster.json`, `memory.jsonl` |
| Checkpoint and resume: no repeated work | second `team_run` with `runId` reports `skipped: [g1,g2]` and spawns no member |
| Budget breach is loud, not a silent truncation | `ok:false`, `failCount >= 1`, and the model is told |

### A defect found in the reused budget logic

`runTeam` checks `teamStepCap` before launching a node. Two nodes starting in the
same tick both pass. Measured on this code: `teamStepCap: 1`, `spent: 2`,
`status: complete`. V4's worker now reserves `member.maxSteps` before its first
`await` and releases the unused part afterwards, so the sum of in-flight
reservations cannot exceed the cap. The V1 check remains as the outer guard; no
V1 file was changed.


## 8. Learned skills — 2026-10-24

```
$ node --test --test-concurrency=1 test/v4/learning.test.js
# tests 15
# pass 15
# fail 0
```

| Assertion | Evidence |
|---|---|
| Sanitising removes secrets, personal paths and CSS selectors | a string with a provider key, a GitHub token, a bearer token, `C:\Users\…`, an e-mail, `#id .class > div:nth-child(2)` |
| No extraction without independent verification | `FAILED` goal, empty receipts and a tool-less turn all refused with a reason |
| Procedures store argument names, never values | the serialised skill contains no absolute path and no file name |
| Promotion is evidence-driven | 1 success → EXPERIMENTAL, 2 → VERIFIED, 3 across 2 scenarios → REUSABLE, failures lead → FAILED |
| Retrieval matches a related goal | "Hitta ett dokument som liknar mitt CV" ranks the CV procedure and excludes an unrelated and a FAILED one |
| **A–H** | real host: `workspace_read` fails → `fs_find` in the granted folder → `fs_read` → skill stored on disk → **host restarted with `keep`** → related task → the learned section and the skill name are in the system prompt → `fs_find` followed → the failed action is not executed again |
| The avoid guard refuses, and explains | a seeded skill's `avoid` entry blocks `fs_grep` locally with `LEARNED_AVOID` and a `learning` SSE event |
| Environment change makes it STALE, not trusted | a stored foreign fingerprint flips the state; the prompt says "revalidate" |
| Learning cannot claim an ungranted lane | a workspace-only environment yields `requires` that a granted-lane check accepts |

### Not executed here

The mandatory real-provider (Go) A–H run. `npm run v4:learn-accept` refuses to
start without a configured provider instead of falling back to the demo brain,
and writes `docs/v4/evidence/learned-skills-<stamp>.json` when it does run.


## 9. Self-improvement additions — 2026-10-24

`test/v4/learning.test.js` grew from 15 to 17 tests. The new ones cover the
pieces the external-repo survey showed were missing:

| Assertion | Evidence |
|---|---|
| A procedure is a template with bindable slots (AWM) | `induceSlots` yields `fs_find.name`, `fs_find.path`, `fs_read.path`; the rendered prompt names what to supply; no value is stored |
| A failure is attributed to ONE step (SkillAdaptor) | step index 1 is blamed, step 0 untouched; the procedure is preserved |
| Repeated step failure escalates to STALE | first failure → still VERIFIED, second → STALE with a `revalidate-step` revision |
| A transient failure never becomes permanent | a TIMEOUT is marked transient and not attributable |
| A context-dependent failure is not a blanket avoid (ExpeL) | the same action succeeding elsewhere yields a contextual note, not an `avoid` entry |
| An out-of-band edit is visible | changing the stored procedure changes the integrity hash |
| The failure path is wired end to end | a real host whose granted file was deleted: turn 1 records `failure-observed` (VERIFIED), a real restart, turn 2 → STALE on disk and in `GET /api/learning` |


## 10. Learned-skill A–H against the REAL provider — 2026-10-24

Run on GitHub Actions with the repository's existing `OPENCODE_API_KEY` secret,
model `glm-5.3-flash` (OpenCode Go). Verbatim output:
`docs/v4/evidence/learned-skills-real-go.txt`.

```
14/14 checks passed
  PASS  turn.A.failed_first_attempt    a real failure was observed
  PASS  turn.A.independent_verification at least one receipt was verified
  PASS  D.skill_stored                 learn-files-955cc0
  PASS  turn.A.cost                    4 model call(s), 16796 in / 309 out, $0.002674
  PASS  E.skill_survives_restart       1 learned skill(s) after restart
  PASS  G.skill_retrieved              the learned section and the skill name reached the prompt
  PASS  H.failed_strategy_not_repeated the failed action was not executed again
```

The first three attempts failed, and each failure was a real defect rather than a
flaky test:

1. **Zero model calls.** The V4 env route had no way to send extra headers, and
   OpenCode Go rejects a request that does not identify as its own client. Added
   `MAJIN_V4_EXTRA_HEADERS` (validated JSON, never logged).
2. **`400 Request is missing x-opencode-session`.** The provider requires a session
   identifier on every request; the repository's existing Go smoke test sends one.
3. **12/14, then 13/14.** The real model solved the task on its first strategy, so
   the mandatory "initially fails" step never happened, and the retrieval check was
   a tool-name proxy. The task now names the file the way a person writes it, and
   retrieval is measured from the system prompt the host actually sent.

### A defect the real model exposed in the learning engine

An action was recorded as "abandoned" whenever more than one tool succeeded, even if
that same tool later succeeded in the run. With the real model this put `fs_read` in
the "do not repeat" list after it failed once on a wrong path and then worked — the
skill discouraged the correct step. Fixed and pinned by a test.

### Honest scope

One task, one model, one environment. The skill it produced is EXPERIMENTAL by the
engine's own rule; broader reliability needs repeated verified runs across varied
tasks. Nothing here proves the Windows host, the phone, or a browser lane.
