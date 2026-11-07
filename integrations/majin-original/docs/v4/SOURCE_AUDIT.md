# MAJIN V4 — source audit (V1 / V2 / V3)

Recorded before the first V4 commit, by reading the code, not the READMEs.

## 0. Baseline SHAs

| Ref | SHA | State |
|---|---|---|
| V1 `main` | `e84b716e79ac4fc3cb443280e56d3f12553c8fc2` | protected, untouched |
| V2 `v2/main` | `1ef253fb1f44406c262a290e170902403f68cceb` | protected, untouched |
| V3 `v3/main` | `df678b21dfb784233da8cea25bdc54722a61236a` | protected, untouched |
| V4 `v4/main` | branched from V3 `df678b2` | this work |

## 1. Capability matrix

Maturity: **proven** = exercised by tests and used here; **usable** = works but
needs a host/credential; **scaffold** = structure without runtime evidence.

### V1 (`main`)

| Area | Module | Maturity | Reuse in V4 |
|---|---|---|---|
| Provider transport (SSE, tool calls, retries) | `src/core/provider/chat.js`, `openai.js`, `anthropic.js` | proven (source) | **used directly** |
| Rate limiting / classification | `src/core/ratelimit.js` | proven | used via `complete()` |
| Live model catalog | `src/core/provider/catalog.js` | proven | **used directly** by `/api/models?refresh=1` |
| Local HTTP server + SSE chat | `src/core/server/index.js` (914 lines) | usable | **not reused** — see §2.1 |
| Config + data dirs | `src/core/config.js`, `paths.js` | proven | path rules re-implemented narrowly; config file read as-is |
| Persona / style | `src/core/config.js` `persona` | text only | replaced by a V4 system prompt (mobile product voice) |
| Agent loop | `src/core/agent.js` (674 lines) | usable | **not reused**: it is CLI/desktop oriented and would drag the whole surface in |
| Tools | `src/core/tools/*`, shell/fs/browser | usable | **reused through lanes** since 2026-10-23 — see §5. 109 of 139 tools are registered through 19 lanes; 30 are excluded with a recorded reason |
| Memory | `src/core/memory.js` | usable | V2 store preferred (cleaner contract) |
| Voice | V1 channels/voice are UI-bound | scaffold | not reused in the browser client |
| Windows install / startup | `install.ps1`, `start-majin.cmd` | usable | **task settings reused** (see below); V4 keeps its own launcher and task name |

### V2 (`v2/main`)

| Area | Module | Maturity | Reuse in V4 |
|---|---|---|---|
| Goal + states + receipts | `runtime/goal.js`, `states.js`, `receipts.js` | proven | **used directly, unmodified** |
| Verifiers (file/http/pixel/dom) | `runtime/verifiers.js` | proven | **used directly** |
| Tool contract + runner | `tools/registry.js`, `runner.js` | proven | **used directly** |
| Approvals | `safety/approvals.js` | proven | **used directly** |
| Memory store | `memory/store.js` | proven | **used directly** |
| DAG / scheduler / orchestrator | `runtime/dag.js`, `scheduler.js`, `orchestrator.js` | usable | not used yet — single-turn execution first (stage 2) |
| Supervisor / roles | `supervisor/*` | scaffold | not used; V4 delegates through its own bounded subagent (§5.4) |
| Recovery advisor | `recover/advisor.js` | proven (pure, no deps) | **used directly** — maps a tool failure class to a bounded retry plan |
| Context packing | `context/engine.js` | proven (pure) | `estimateTokens` **used directly**; `pack()` not used (it flattens roles, see §4) |
| Telemetry ledger | `telemetry/ledger.js` | proven | **used directly** — fixed field allowlist per event |
| Telemetry aggregation | `telemetry/aggregate.js` | proven | `aggregate()` used; `renderReport()` not used (it titles the report for V2) |
| Outer recovery loop | `recover/outer-loop.js` | usable | not used: it drives V2's `runObjective`, which V4 does not run |
| Studio server/page | `studio/server.js` (517 lines) | usable | **not reused**: V4 needs a different trust model (session + tunnel) |
| Voice adapters | `voice/tts.js`, `stt.js` | scaffold (host binaries) | planned for server-side voice (matrix V7) |
| Telemetry / audit | `telemetry/*`, `audit/*` | usable | not wired yet |

### V3 (`v3/main`)

| Area | Module | Maturity | Reuse in V4 |
|---|---|---|---|
| Node 22 runtime floor | `platform/runtime.js` | proven | same rule re-stated in `config.js` |
| Loopback server + origin/host checks | `server.js` | proven | **pattern reused**, extended with auth, sessions and SSE |
| File vertical slice | `runtime/file-deliverable.js` | proven | superseded by the generic goal+tool path |
| Minimal UI | `ui/page.js` | proven | replaced by the mobile PWA |
| Acceptance matrix discipline | `docs/v3/*` | proven | **method kept**, new machine-validated matrix |

## 2. Why the V2 Studio server was not reused

`src/v2/studio/server.js` serves a desktop operator surface on loopback with no
session model. V4 needs: session cookies, CSRF, tunnel-aware origin checks,
SSE streaming, cancellation and idempotency. Bolting those onto Studio would
have changed its contract for existing V2 users. The security primitives were
re-used as patterns; the module stays intact for V2.

## 2.1 The V1 server: why it is not the V4 server

V1 already serves a full UI, `/api/chat` with SSE, `/api/models`, `/api/state`,
tasks, approvals and a WhatsApp webhook. Tempting to reuse wholesale. It is not
reused as the V4 front door because its trust model is *desktop-local*:

- the session secret is a static token that is also accepted in the **URL**
  (`?t=…`), in a cookie **without** `HttpOnly`/`Secure`, and as a bearer header;
- loopback peers are trusted **without any token** (`server.trustLocal`);
- `OPTIONS` answers with `access-control-allow-origin: *`;
- there is no CSRF requirement and no per-device revocation.

Every one of those is a reasonable localhost convenience and a vulnerability the
moment a tunnel publishes the port. Rewriting V1's auth for the internet would
change its contract for existing desktop users, so V4 keeps V1 untouched and
adds a thin, separately tested session layer. What *is* reused from V1 is the
part with no security coupling: the model catalog implementation.

## 3. Duplication ledger

| Built in V4 | Why not reuse |
|---|---|
| `security.js` (limits, host/origin) | V3's checks are one-shot and loopback-only; needed reusable, tested middleware |
| `store.js` (conversations) | No conversation persistence exists in V1–V3 |
| `models.js` (discovery) | V1 has a catalog but no safe, secret-free projection for a remote client — the *fetching* is V1's code, only the projection is new |
| `kernel.js` | No versioned capability contract exists in any prior version |
| `ui/*` | No mobile/PWA surface exists |

## 3.1 Windows autostart: what V1 taught V4

V1's `install.ps1` registers the `MAJIN` task with three settings that are easy to
miss and expensive to discover in production:

| Setting | What happens without it |
|---|---|
| `-AllowStartIfOnBatteries` + `-DontStopIfGoingOnBatteries` | on a laptop, Task Scheduler stops the host the moment the charger is unplugged |
| `-ExecutionTimeLimit ([TimeSpan]::Zero)` | the default limit is 72 hours, so Windows kills the host after three days of uptime |

V4's first installer omitted both. It was fixed by copying V1's choices and adding
`-StartWhenAvailable` plus restart-on-failure, which V1 does not have.
`test/v4/windows-installer.test.js` now fails if either setting disappears, and it
also asserts that V4's task name does not collide with V1's.

Not reused: V1 also writes Start-menu and Desktop shortcuts and copies a payload
into `%LOCALAPPDATA%`; V4 runs from its own checkout and only needs a launcher.

## 3.2 Diagnostics: why V4 has its own doctor

`src/v2/ops/doctor.js` is real but V2-specific — its ten checks cover
`bin/majin-v2.mjs`, the OpenCode key, the GUI runner, whisper and the Studio port.
None of those exist in V4. `scripts/v4/host-doctor.mjs` therefore checks the V4
surface: Node floor, data dir, workspace, HMAC key, pairing record, the V1 config
it reads models from, public origin and proxy trust.

## 4. Limitations found in reused code (not modified)

Reusing a module means inheriting its edges. These were found while wiring V4 to
the V2 voice lane; V2 is left untouched so `v2/main` keeps behaving exactly as
its users expect.

| Module | Limitation | V4 handling |
|---|---|---|
| `src/v2/voice/stt.js` `CommandSttProvider` | strips quotes from **arguments** but uses the executable token verbatim, so a quoted binary path becomes `spawn "C:\Program Files\…" ENOENT` | documented here; V4 tests use an unquoted path and the docs tell operators to use a path without spaces |
| `src/v2/safety/command-preflight.js` | classifies a `|` pipeline as `hold`, not `no` | safe-exec then refuses the pipeline at tokenise time; V4 surfaces `PERMISSION_DENIED`, and a test proves the pipeline never runs |
| `src/v2/tools/runner.js` | throws classified `ToolError`s instead of returning `{ok:false}` | the agent catches them, moves the goal out of `WAITING_FOR_TOOL` and records a failure receipt |
| `src/core/provider/catalog.js` | paginates up to 100 pages with no total cap | V4 bounds the whole call with an 8 s timeout and caches for 6 h |
| `src/v2/runtime/goal.js` | `uncoveredAcceptance()` treats any historical verified receipt as coverage | V4 resume ignores history and re-verifies every item against recorded hashes |

## 4. Risks carried forward

1. V1 config schema is not versioned; a future V1 change could alter
   `providers`/`models.routes`. `models.js` reads defensively and degrades to demo.
2. V2 voice providers need host binaries (whisper/piper). They are not wired to
   the browser, so voice is browser-native only for now.
3. No Windows host is available in this environment: every Windows claim is
   therefore `NOT_STARTED` or `BLOCKED` in the matrix, never assumed.


## 5. Universal-agent integration (2026-10-23)

The owner corrected the goal: MAJIN is a universal agent, not a job-search app.
The CV flow was an example. This section records every reuse decision made while
turning the V4 tool surface from 12 lanes into the union of V1–V4, and the
exclusions that remain.

`npm run v4:inventory` regenerates `docs/v4/CAPABILITY_INVENTORY.{json,md}` from
the code. A V1 module without a decision, or a V2/V3 file that is neither
imported nor explicitly excluded, makes it exit 1. The numbers below come from
that run, not from this text.

### 5.1 V1 lanes: what is reused, and why

| Lane | V1 module | Tools | Why it is a lane |
|---|---|---|---|
| files | `files.js` | 12 | The only way to read/write outside the workspace; folder-scoped by Owner Mode |
| shell | `exec.js` | 5 | Managed long-running executors (`exec.start/wait/cancel/logs`) |
| shelltools | `shell.js` | 5 | One-shot command, background job, job list/stop, env — complements exec.* |
| sys | `sys.js` | 6 | Read-only machine truth (OS, processes, ports, disks, services) the agent needs before acting |
| net | `net.js` (5 of 8) | 5 | DNS/TCP/HTTP/serve. Cross-platform, so it must not be gated as "screen" |
| screen | `net.js` (3 of 8) | 3 | Screenshot, clipboard, toast — Windows interactive session only |
| web | `web.js` | 12 | Search, fetch, download and the `browser.*` lane (registered only with a browser runtime) |
| research | `research.js` | 1 | Full PLAN→SEARCH→FETCH→CROSS-CHECK→VERIFY pipeline over `registry.exec` |
| jobs | `jobs.js` | 9 | Domain tools; kept because they work, not because the product is job search |
| flows | `flows.js` | 6 | Saved trigger→action flows executed through the same runner |
| github | `github.js` | 2 | Verify/research against a repository |
| audit | `audit.js` | 1 | MAJIN interrogates its own source for unsupported claims |
| learn | `learn.js` | 3 | Durable lessons: record a measured failure, verify it with proof |
| marketing | `marketing.js` | 4 | Domain tools; they self-report "not configured" instead of pretending |
| re | `re.js` | 23 | Binary analysis (strings, PE, YARA, entropy, unpack…) — real, local, no network |
| trading | `trading.js` | 2 | Conservative allocation/research; never places an order |
| power | `power.js` | 3 | Dry-run platform-transfer planning with an approval ledger |
| desktop / computer | `wincontrol.js`, `computer.js` | 7 | Win32 window control and the OBSERVE→PLAN→ACT→VERIFY loop (Windows only) |

Two groups are excluded on purpose, with the reason recorded in code
(`src/v4/inventory.js`):

- **replaced by a V4-native implementation**: `agent.js` (`agent.plan/delegate/
  moa/approve` are bound to V1's loop, guard and registry; V4 has
  `agent_delegate`), `meta.js` (`tools.search` needs V1's registry; V4 has
  `tools_search`/`tools_activate` over the live registry), `teams.js` (runs V1
  swarm subagents through V1's loop).
- **excluded because they would be a lie in V4**: `majin.js` (writes V1's config
  and restarts V1's agent), `channels.js` (no V4 channel configuration),
  `heartbeat.js` (V1 scheduler vs. V4 supervisor), `memory-sync.js` (V1 memory
  store), `reset.js` (destructive V1 recovery over a shared data dir).

### 5.2 Bugs found in reused V1 code, and fixed at the source

Reuse without running the code is how a capability becomes a claim. The probe
(`npm run v4:tools -- --probe`) found two real defects that unit tests missed:

1. `net.dns` used the callback API without a callback (`dns.resolve4(host)`),
   which throws `ERR_INVALID_ARG_TYPE` on Node 22. **Every DNS lookup failed, in
   V1 too.** Fixed in `src/core/tools/net.js` by using `node:dns/promises`.
2. `net.http` let a failed `fetch` throw, which the adapter classified as
   `UNKNOWN` and could not retry honestly. It now returns
   `{ok:false,error:{code:'network_failure'}}`; `classifyV1Error` maps it to
   `NETWORK_FAILURE`.

A third gap was in the adapter, not V1: `zodFromV1Params` ignored the `required`
list V1 already computes, so a missing argument reached the tool as a confusing
`ENOENT`. Required parameters are now required in the schema the model sees.

### 5.3 The tool surface: reachability instead of truncation

V1 alone has 139 tools. Sending all of them plus MCP and plugins on every model
request costs tens of thousands of tokens and degrades tool choice; the previous
`schemasFromRegistry(..., {limit: 60})` silently dropped everything past 60.

The new contract (`src/v4/tool-exposure.js`):

- core tools + everything the turn activated + as many others as fit
  (`MAJIN_V4_MAX_VISIBLE_TOOLS`, default 64) are sent;
- `tools_search` is a deterministic, zero-model search over the live registry;
- `tools_activate` puts exact names into the **next** model round's list;
- activation is never permission — every call still goes through the runner and
  the owner's approval policy.

A test with a 4-tool budget proves that a tool outside the list can be found by
its own name, activated, and called in the next round.

### 5.4 Multi-agent: delegation without a second runtime

`agent_delegate` is a V4 engine tool (not V1's `agent.delegate`):

- own context (system prompt + task, no conversation history),
- a tool subset the parent names (empty = all except delegation),
- its own V2 `Goal` for receipts and file verification,
- hard caps: 5 rounds, 6 tool calls, one level deep (a subagent cannot delegate),
- verified artifacts are lifted onto the parent goal as `subagent.verify`
  receipts, so a file written by a subagent is still verified against its hash.

It follows the `agent` Owner Mode lane, so revoking "Delegering" removes it from
the registry and from the model's tool list immediately.

### 5.5 V2/V3 decisions

18 of 51 V2 components are reachable from V4 by import (direct or transitive:
goal/states/receipts, verifiers, registry/runner, approvals, memory store,
recovery advisor, telemetry ledger+aggregate, context estimate, voice adapters,
audit export as a format). The other 33 each carry a written reason in
`src/v4/inventory.js` — mostly V2 orchestration (compiler, scheduler,
supervisor, outer loop), the V2 studio, the V2 executor and the gauntlet.

V3 is 0/4: its four files are a superseded vertical slice (single file
deliverable, static page, loopback server, Node check). The *method* — machine
validated acceptance — is what V4 kept.


## 6. Reuse decisions in the 2026-10-23 pass

| Need | What was reused | Why not new code |
|---|---|---|
| Rename / archive / delete semantics | V1 `src/core/chats.js` (title policy `manual` > `auto` > `fallback`, archive as a reversible flag, delete as a separate confirmed operation) | the vocabulary and the rules already existed and are the ones the owner knows; V4 implements them on its own store instead of V1's JSONL files |
| Chat index shape | V1 `chats-index.json` fields (`title`, `titlePolicy`, `archivedAt`, `lastActivityAt`) | an import can map them one-to-one, and the UI already uses those words |
| Reading a file by name | V1 `fs.find` (new, in `src/core/tools/files.js`, built on the existing `walk`/`globToRe` helpers) | a generic capability for every version, not a CV feature |
| Document text | V4 `src/v4/extract.js` (PDF/DOCX/XLSX, no dependencies) | unchanged; only the path check in front of it is new |
| Path rules | Owner Mode's existing `folders()` / `allowsPath()` | the data model was right; what was missing was enforcement and disclosure |
| Chat persistence | V4 `ConversationStore` (the pre-existing store) | the owner's instruction: no second chat system |

Rejected in this pass, with reasons:

- **V1's `chats-index.json` as V4's storage.** It is keyed to `<id>.jsonl` transcripts and a single
  `dirs.sessions`; V4 needs per-conversation versions and a goal link. Importing the *semantics* is
  reuse; adopting the *files* would fork the store the owner asked to keep.
- **V2/V3 history import.** Neither has a durable chat transcript (V2 kept goals/receipts/telemetry,
  V3 a single-file deliverable). The import endpoint says so instead of inventing conversations.
- **A permanent sidebar.** It would take width from the transcript on a phone; the drawer overlays
  and is closed by default.


## 7. Multi-agent equivalence — 2026-10-23 (after the architect's review)

The review's finding was correct and specific: V4 had approximated V1's standing
teams and V2's scheduler with a two-level delegation, and the inventory counted
only *tool lanes*, which made engine reuse invisible. This pass closes both gaps
by reusing the engines themselves rather than writing equivalents.

| Need | Reused verbatim | V4 supplies |
|---|---|---|
| Standing team: roster, per-member identity, role, instructions, tool allowlist | `src/core/teams.js` — `TeamStore` (roster.json + memory.jsonl blackboard) | — |
| Team run: DAG, critical-path width, retries, blocked propagation, budget | `src/core/swarm.js` — `runSwarm` | — |
| Checkpoint / resume with exactly-once skips | `src/core/teams.js` — `runTeam` | — |
| The actual work of a member | — | `runSubtask` (V4 model, registry, approvals) via `runTeam`'s existing `makeWorker` seam |
| Multi-step dependency graph | `src/v2/runtime/dag.js` (`TaskGraph`), `src/v2/runtime/scheduler.js` (`runGraph`) | `agent_graph` tool + subagent leaf executor |
| Per-task receipts on a goal | `src/v2/runtime/goal.js` (unchanged; `runGraph` already writes them) | child goal so the parent is not mutated mid-call |

### Why `makeWorker` was the whole answer

`runTeam` already accepted `makeWorker(member) => workerFn`. That seam means V4
does not need its own team runtime at all: it passes a worker built on
`runSubtask`, and the roster, blackboard, budget, checkpoint format and resume
semantics stay exactly the code V1 tested. A team member is a bounded V4
subagent wearing a persistent identity.

### A real defect found in the reused budget logic

`runTeam` checks `teamStepCap` at launch. Two nodes starting in the same tick
both pass that check, so a parallel burst could spend more than the cap —
measured: `teamStepCap: 1`, `spent: 2`, `status: complete`. V4's worker now
reserves the worst case (`member.maxSteps`) before its first `await` and releases
the difference afterwards, so the sum of in-flight reservations cannot exceed the
cap. The V1 check stays as the outer guard; no V1 file was modified.

### What is still not equivalent, and will not be faked

- **V2's orchestrator / compiler / supervisor.** They exist to plan and verify
  work for the V2 loop, which V4 does not run. `agent_graph` covers the part that
  actually matters to a user (parallel steps, dependencies, blocked descendants,
  receipts); importing a second planner would create two sources of truth about
  what the current task is.
- **Voice and Windows/mobile verification.** Code exists and is tested; real
  device behaviour cannot be verified from this environment and is reported as
  BLOCKED rather than assumed.


## 8. External repositories for skill learning — evaluated 2026-10-24

The owner asked whether finished GitHub repos exist that can be reused. Five were
checked against the real API (language, licence, activity) before any decision.

| Repo | Language | Licence | Verdict |
|---|---|---|---|
| `zorazrw/agent-workflow-memory` (AWM, ICML 2025) | Python | Apache-2.0 | **design reused** — a Python research harness for mind2web/webarena; cannot be imported into Node |
| `LeapLabTHU/ExpeL` (AAAI 2024) | Python | Apache-2.0 | **design reused** — Python, ALFWorld/WebShop harness |
| `zjunlp/SkillAdaptor` | Python | MIT | **design reused** — Python; step-level attribution is the valuable part |
| `MineDojo/Voyager` | JavaScript | MIT | **rejected as code** — the JavaScript is a Minecraft skill library (mineflayer APIs); none of it addresses Windows tools, files or browsers |
| `OpenLAIR/OpenSkill` | PDDL | Apache-2.0 | **rejected** — "code coming soon"; nothing executable exists |

Conclusion, stated plainly: **there is no drop-in repository.** Every real
implementation of "learn a skill from a verified execution" is Python research
code bound to its own benchmark harness, and MAJIN is a Node.js agent whose
contracts (V2 `ToolDefinition`, zod schemas, approvals, receipts) none of them
speak. Vendoring one would mean a second agent engine — exactly what the
integration rule forbids.

What was reused is the *design*, implemented against MAJIN's own store:

| Idea | Source | Implemented in |
|---|---|---|
| Parameter slots so one workflow serves many tasks | AWM | `induceSlots`, `renderProcedure`, rendered into the prompt |
| Attribute a failure to one step, revise only that step | SkillAdaptor | `attributeFailure`, `LearnedSkillStore.observeFailure` |
| Compare a success against a failure instead of reading one trace | ExpeL | `contrastiveInsight` |
| Verify before commit, bounded rounds | Voyager | already present: the verified-receipt gate |
| Bundle integrity so an out-of-band edit is visible | `snapsynapse/skill-provenance` (MIT) | `skillIntegrity`, hashed on every write |

### A defect this pass found in our own engine

`penalise()` existed but **nothing ever called it**, so a failed turn that had
used a learned skill left no trace at all: a procedure broken by a changed
environment would keep looking healthy forever. That is now closed —
`observeFailure` is wired into the agent's failure path, attributes the failure
to a step, and escalates to `STALE` only when the same step fails repeatedly.
