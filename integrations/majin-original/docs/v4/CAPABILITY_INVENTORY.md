# MAJIN capability inventory (generated)

Generated 2026-10-24T13:44:01.044Z on linux. Every row is computed from the code; a module without a recorded decision fails `npm run v4:inventory`.

## Totals

| Version | Unit | Count |
| --- | --- | --- |
| V1 | tool modules | 26 |
| V1 | tools | 144 |
| V1 | integrated into V4 lanes | 115 |
| V1 | excluded with a recorded reason | 29 |
| V2 | components reused | 29/52 |
| V3 | components reused | 0/4 |
| V4 | built-in tools | 9 |
| V4 | tools registered on this host | 114 |

## Capability domains

| Domain | What exists |
| --- | --- |
| tools | builtin: 9; v1Integrated: 115; registeredOnHost: 114 |
| skills | shipped: ["fix-code","job-search"]; mechanism: src/v4/skills.js — declared required/preferred tools decide visibility, not app code; learned: src/v4/learning.js — procedures extracted from goals that completed with an independently verified receipt; stored in the same skills directory with a `learned` block, so one loader serves both. States: EXPERIMENTAL, VERIFIED, REUSABLE, STALE, FAILED.; learnedAcceptance: npm run v4:learn-accept — the mandatory A–H gate against the real provider |
| mcp | state: configured by the owner in <data>/v4/mcp.json; mechanism: src/v4/mcp.js + mcp-tools.js — stdio JSON-RPC, scrubbed env, tools at process tier |
| agentFunctions | turnEngine: src/v4/agent.js — goal, rounds, receipts, verification, recovery advisor; discovery: tools_search + tools_activate (src/v4/tool-exposure.js); delegation: agent_delegate — bounded subagent, owner-gated; resume: resumeGoal — re-verifies every artifact against the recorded SHA-256 |
| computerControl | lanes: [{"lane":"desktop","available":false,"tools":0,"reason":"Windows-only (this host is linux)"},{"lane":"computer","available":false,"tools":0,"reason":"Windows-only (this host is linux)"},{"lane":"screen","available":false,"tools":0,"reason":"Windows-only (this host is linux)"}]; mechanism: V1 wincontrol.js / computer.js through the V1 lane adapter; Windows interactive session only |
| browser | lane: web; tools: ["browser.open","browser.read","browser.click","browser.form","browser.form_fill","browser.form_submit","browser.fill","browser.shot","browser.upload","browser.verify","browser.elements","browser.clear_marks","browser.close"]; runtime: {"available":false,"reason":"no browser binary found (npx playwright install chromium)"} |
| terminal | lanes: [{"lane":"shell","available":true,"tools":5},{"lane":"shelltools","available":true,"tools":5}]; mechanism: V1 exec.js (managed jobs) and shell.js (command/background) through the V2 runner and approvals |
| memory | tools: ["memory_save","memory_search"]; store: src/v2/memory/store.js (used directly); promptInjection: src/v4/memory.js memoryForPrompt — retrieval, not just writes |
| voice | server: src/v2/voice/{speak,listen,tts,stt}.js imported by src/v4/voice.js; client: browser-native speech + text fallback (src/v4/ui/voice.js); measured: false |
| automation | flows: 6; supervisor: src/v4/supervisor.js — crash recovery and health checks; updater: signed release, overlay activation, journal recovery, daily Windows task; scheduler: Windows Task Scheduler (logon host + daily update) |
| multiAgent | implemented: agent_delegate (1 level), agent_graph (V2 DAG), team_run (V1 standing teams, resumable); teams: V1 TeamStore + runTeam + runSwarm reused unchanged; members executed by V4 subagents; graph: V2 TaskGraph + runGraph reused unchanged, executed by V4 subagents; notUsed: V2 orchestrator/compiler/supervisor (they compile and plan for the V2 loop, which V4 does not run) |

## V1 tool modules

| Module | Tools | Lanes | Decision | Reason |
| --- | --- | --- | --- | --- |
| `agent.js` | 4 | — | replaced | V1 agent.plan/delegate/moa/approve are bound to V1's own loop, registry and guard. V4 provides the same capability natively (agent_delegate) with its own approval policy; running V1's second agent runtime inside V4 would duplicate state and bypass receipts. |
| `audit.js` | 1 | audit | lane | reused through audit |
| `channels.js` | 1 | channels | lane | reused through channels |
| `computer.js` | 2 | computer | lane | reused through computer |
| `exec.js` | 5 | shell | lane | reused through shell |
| `files.js` | 13 | files | lane | reused through files |
| `flows.js` | 6 | flows | lane | reused through flows |
| `github.js` | 2 | github | lane | reused through github |
| `heartbeat.js` | 1 | — | replaced | The existing core Heartbeat engine is reused by src/v4/heartbeat.js with actual V4 goal/approval events, durable queue and shared-history/opt-in push delivery. The old tool wrapper uses V1 journal events and is not a second V4 heartbeat owner. |
| `jobs.js` | 9 | jobs | lane | reused through jobs |
| `learn.js` | 3 | learn | lane | reused through learn |
| `majin.js` | 18 | — | excluded | Self-configuration writes V1's config.json and restarts V1's agent. V4 has its own setup, doctor, owner-mode and updater. Adapting these would let the model edit the wrong configuration while appearing to manage MAJIN. |
| `marketing.js` | 4 | marketing | lane | reused through marketing |
| `memory-sync.js` | 1 | — | replaced | The existing core memory-sync entry point now supports canonical V2 namespaced records. V4 memory_sync uses that engine and MemoryStore with approval, folder checks and tombstones. The old wrapper assumes V1 text facts and is not used to create a shadow V4 store. |
| `meta.js` | 1 | — | replaced | tools.search needs V1's registry.search. V4 ships tools_search/tools_activate over the live V4 registry, which also makes discovered tools callable in the next round. |
| `net.js` | 8 | screen, net | lane | reused through screen, net |
| `power.js` | 3 | power | lane | reused through power |
| `re.js` | 23 | re | lane | reused through re |
| `research.js` | 1 | research | lane | reused through research |
| `reset.js` | 2 | — | excluded | Deletes artifacts measured by V1 recovery inside a shared data dir. V4 reconciles its own goals and must never run destructive V1 recovery on paths it does not own. |
| `shell.js` | 5 | shelltools | lane | reused through shelltools |
| `sys.js` | 6 | sys | lane | reused through sys |
| `teams.js` | 2 | — | replaced | The V1 tool wrapper binds team.run to V1's loop and registry. Its ENGINE (src/core/teams.js: TeamStore, runTeam) and the scheduler behind it (src/core/swarm.js) are reused verbatim by V4's team_run, with V4 subagents as the worker. |
| `trading.js` | 2 | trading | lane | reused through trading |
| `web.js` | 16 | web | lane | reused through web |
| `wincontrol.js` | 5 | desktop | lane | reused through desktop |

## V1 tools

| Tool | Risk | Status | Lane | Requires |
| --- | --- | --- | --- | --- |
| `agent.plan` | read | excluded | — | — |
| `agent.delegate` | read | excluded | — | — |
| `agent.moa` | read | excluded | — | — |
| `agent.approve` | read | excluded | — | — |
| `majin.self_audit` | read | integrated | audit | — |
| `channel.send` | exec | integrated | channels | — |
| `computer.use` | exec | integrated | computer | windows interactive session |
| `cursor.overlay` | exec | integrated | computer | windows interactive session |
| `exec.backends` | read | integrated | shell | — |
| `exec.start` | exec | integrated | shell | — |
| `exec.wait` | exec | integrated | shell | — |
| `exec.cancel` | exec | integrated | shell | — |
| `exec.logs` | read | integrated | shell | — |
| `fs.list` | read | integrated | files | — |
| `fs.read` | read | integrated | files | — |
| `fs.write` | write | integrated | files | — |
| `fs.patch` | write | integrated | files | — |
| `fs.search` | read | integrated | files | — |
| `fs.grep` | read | integrated | files | — |
| `fs.move` | write | integrated | files | — |
| `fs.copy` | write | integrated | files | — |
| `fs.delete` | destructive | integrated | files | — |
| `fs.find` | read | integrated | files | — |
| `fs.stat` | read | integrated | files | — |
| `fs.mkdir` | write | integrated | files | — |
| `fs.tar` | write | integrated | files | — |
| `flows.add` | exec | integrated | flows | — |
| `flows.list` | read | integrated | flows | — |
| `flows.enable` | write | integrated | flows | — |
| `flows.remove` | write | integrated | flows | — |
| `flows.trigger` | exec | integrated | flows | — |
| `flows.webhook.recorded` | write | integrated | flows | — |
| `github.verify` | exec | integrated | github | — |
| `github.research` | read | integrated | github | — |
| `majin.heartbeat` | net | excluded | — | — |
| `jobs.search` | read | integrated | jobs | — |
| `jobs.match` | read | integrated | jobs | — |
| `jobs.list` | read | integrated | jobs | — |
| `jobs.start` | write | integrated | jobs | — |
| `jobs.skip` | write | integrated | jobs | — |
| `jobs.cv.set` | write | integrated | jobs | — |
| `jobs.cv.show` | read | integrated | jobs | — |
| `jobs.prepare` | exec | integrated | jobs | — |
| `jobs.send` | destructive | integrated | jobs | — |
| `ma.learn` | write | integrated | learn | — |
| `ma.verify_lesson` | write | integrated | learn | — |
| `ma.lessons` | read | integrated | learn | — |
| `majin.configure` | write | excluded | — | — |
| `majin.routes` | write | excluded | — | — |
| `majin.provider` | write | excluded | — | — |
| `majin.moa` | write | excluded | — | — |
| `majin.guard` | write | excluded | — | — |
| `majin.memory` | write | excluded | — | — |
| `majin.skill` | write | excluded | — | — |
| `majin.schedule` | write | excluded | — | — |
| `majin.channel` | write | excluded | — | — |
| `majin.status` | read | excluded | — | — |
| `majin.doctor` | read | excluded | — | — |
| `majin.selftest` | read | excluded | — | — |
| `majin.tools` | read | excluded | — | — |
| `majin.backup` | write | excluded | — | — |
| `majin.ui` | read | excluded | — | — |
| `majin.control` | write | excluded | — | — |
| `majin.dataset` | write | excluded | — | — |
| `majin.adapter` | write | excluded | — | — |
| `marketing.channel_report` | read | integrated | marketing | — |
| `marketing.plan` | read | integrated | marketing | — |
| `marketing.status` | read | integrated | marketing | — |
| `marketing.analyze` | read | integrated | marketing | — |
| `memory.sync` | write | excluded | — | — |
| `tools.search` | read | excluded | — | — |
| `net.dns` | read | integrated | net | — |
| `net.tcp` | read | integrated | net | — |
| `net.http` | net | integrated | net | — |
| `net.serve` | exec | integrated | net | — |
| `net.serve_stop` | exec | integrated | net | — |
| `screen.capture` | read | integrated | screen | windows interactive session |
| `screen.claim` | read | integrated | screen | windows interactive session |
| `sys.notify` | read | integrated | screen | windows interactive session |
| `power.propose` | write | integrated | power | — |
| `power.approve` | write | integrated | power | — |
| `power.apply` | exec | integrated | power | — |
| `re.analyze` | read | integrated | re | — |
| `re.strings` | read | integrated | re | — |
| `re.hexdump` | read | integrated | re | — |
| `re.search` | read | integrated | re | — |
| `re.entropy` | read | integrated | re | — |
| `re.sections` | read | integrated | re | — |
| `re.imports` | read | integrated | re | — |
| `re.exports` | read | integrated | re | — |
| `re.yara` | read | integrated | re | — |
| `re.iocs` | read | integrated | re | — |
| `re.overlay` | read | integrated | re | — |
| `re.extract` | write | integrated | re | — |
| `re.apk` | read | integrated | re | — |
| `re.pcap` | read | integrated | re | — |
| `re.diff` | read | integrated | re | — |
| `re.modules` | read | integrated | re | — |
| `re.tool` | exec | integrated | re | — |
| `re.tools` | read | integrated | re | — |
| `re.disasm` | read | integrated | re | — |
| `re.unpack` | write | integrated | re | — |
| `re.hash` | read | integrated | re | — |
| `re.spec` | write | integrated | re | — |
| `re.rules` | read | integrated | re | — |
| `research.run` | read | integrated | research | — |
| `reset.plan` | read | excluded | — | — |
| `reset.apply` | exec | excluded | — | — |
| `shell.run` | exec | integrated | shelltools | — |
| `shell.bg` | exec | integrated | shelltools | — |
| `shell.jobs` | read | integrated | shelltools | — |
| `shell.stop` | exec | integrated | shelltools | — |
| `shell.env` | read | integrated | shelltools | — |
| `sys.info` | read | integrated | sys | — |
| `sys.ps` | read | integrated | sys | — |
| `sys.ports` | read | integrated | sys | — |
| `sys.fs_usage` | read | integrated | sys | — |
| `sys.procs_top` | read | integrated | sys | — |
| `sys.services` | read | integrated | sys | — |
| `team.manage` | write | excluded | — | — |
| `team.run` | exec | excluded | — | — |
| `trading.plan` | read | integrated | trading | — |
| `trading.research` | read | integrated | trading | — |
| `web.search` | read | integrated | web | — |
| `web.fetch` | read | integrated | web | — |
| `web.download` | write | integrated | web | — |
| `browser.open` | exec | integrated | web | browser runtime |
| `browser.read` | read | integrated | web | browser runtime |
| `browser.click` | exec | integrated | web | browser runtime |
| `browser.form` | read | integrated | web | browser runtime |
| `browser.form_fill` | exec | integrated | web | browser runtime |
| `browser.form_submit` | exec | integrated | web | browser runtime |
| `browser.fill` | exec | integrated | web | browser runtime |
| `browser.shot` | read | integrated | web | browser runtime |
| `browser.upload` | exec | integrated | web | browser runtime |
| `browser.verify` | read | integrated | web | browser runtime |
| `browser.elements` | read | integrated | web | browser runtime |
| `browser.clear_marks` | write | integrated | web | browser runtime |
| `browser.close` | write | integrated | web | browser runtime |
| `mouse.move` | exec | integrated | desktop | windows interactive session |
| `control.list_windows` | read | integrated | desktop | windows interactive session |
| `control.type` | exec | integrated | desktop | windows interactive session |
| `control.read` | read | integrated | desktop | windows interactive session |
| `control.click_button` | exec | integrated | desktop | windows interactive session |

## V1 engines reused directly

| Engine | Status | Imported by |
| --- | --- | --- |
| `src/core/browser.js` | reused | src/v4/agent.js |
| `src/core/heartbeat.js` | reused | src/v4/heartbeat.js |
| `src/core/memory-sync.js` | reused | src/v4/tools/memory-sync.js |
| `src/core/presets.js` | reused | src/v4/models.js |
| `src/core/schedule.js` | reused | src/v4/background-tasks.js |
| `src/core/teams.js` | reused | src/v4/server.js, src/v4/teams.js |

## V2 components

| Component | Status | Reason |
| --- | --- | --- |
| `src/v2/audit/anchor.js` | reused | imported by src/v2/audit/export.js, src/v2/audit/index.js, src/v4/audit.js |
| `src/v2/audit/bind.js` | reused | imported by src/v2/audit/index.js |
| `src/v2/audit/chain.js` | reused | imported by src/v2/audit/anchor.js, src/v2/audit/export.js, src/v2/audit/index.js, src/v2/studio/server.js |
| `src/v2/audit/export.js` | reused | imported by src/v2/studio/server.js, src/v4/audit.js |
| `src/v2/audit/index.js` | reused | imported by src/v4/audit.js |
| `src/v2/audit/permissions.js` | reused | imported by src/v2/audit/anchor.js, src/v2/audit/chain.js, src/v4/push.js, src/v4/server.js |
| `src/v2/audit/timestamp.js` | reused | imported by src/v2/audit/export.js |
| `src/v2/compiler/goal-compiler.js` | not-used | Compiles natural language into V2 task graphs; V4 plans inside the conversation turn. |
| `src/v2/compiler/router.js` | not-used | V2 intent compiler targets V2 tool vocabulary and orchestration. |
| `src/v2/config/config.js` | not-used | Trust-gated V2 config loader. V4's configuration is explicit and env-overridable. |
| `src/v2/context/engine.js` | reused | imported by src/v2/supervisor/roles.js, src/v4/context.js, src/v4/memory.js |
| `src/v2/exec/approval-modes.js` | not-used | Execution approval modes for the V2 executor. V4 uses V2's Approvals + runner directly. |
| `src/v2/exec/sandbox.js` | not-used | Sandbox for the V2 executor; V4 does not spawn via the V2 executor. |
| `src/v2/exec/whitelist.js` | not-used | Command whitelisting for the V2 executor; V4's shell tools run through V1's executor and V4 approvals. |
| `src/v2/gauntlet/gauntlet.js` | not-used | V2 test gauntlet, not a runtime capability. |
| `src/v2/gauntlet/scenarios-objectives.js` | not-used | V2 test scenarios, not a runtime capability. |
| `src/v2/gauntlet/scenarios.js` | not-used | V2 test scenarios, not a runtime capability. |
| `src/v2/memory/store.js` | reused | imported by src/v4/backup.js, src/v4/memory.js, src/v4/tools.js, src/v4/tools/memory-sync.js |
| `src/v2/model/profiles.js` | not-used | V2 model profiles; V4 resolves models from V1's provider catalog. |
| `src/v2/model/provider.js` | reused | imported by src/v2/compiler/router.js, src/v2/model/profiles.js, src/v2/model/registry-refresh.js, src/v2/model/registry.js, src/v2/supervisor/roles.js, src/v2/voice/stt.js, src/v2/voice/tts.js |
| `src/v2/model/registry-refresh.js` | not-used | Refreshes the V2 model registry; V4 caches the V1 catalog instead. |
| `src/v2/model/registry.js` | not-used | V2 model failover/circuit registry; V4 uses V1's transport and V4's model cache. |
| `src/v2/ops/doctor.js` | not-used | All checks are V2-specific (V2 binary, OpenCode key, Studio port). |
| `src/v2/recover/advisor.js` | reused | imported by src/v2/recover/outer-loop.js, src/v4/agent.js |
| `src/v2/recover/outer-loop.js` | not-used | Drives V2's runObjective; V4 runs its own loop and reuses only recover/advisor.js. |
| `src/v2/runtime/dag.js` | reused | imported by src/v2/gauntlet/scenarios-objectives.js, src/v2/gauntlet/scenarios.js, src/v2/runtime/scheduler.js, src/v2/supervisor/plan-with-model.js, src/v2/supervisor/supervisor.js, src/v4/graph.js |
| `src/v2/runtime/errors.js` | reused | imported by src/v2/runtime/scheduler.js |
| `src/v2/runtime/events.js` | reused | imported by src/v2/audit/bind.js, src/v2/studio/server.js |
| `src/v2/runtime/goal.js` | reused | imported by src/v2/gauntlet/gauntlet.js, src/v2/runtime/orchestrator.js, src/v3/runtime/file-deliverable.js, src/v4/agent.js, src/v4/graph.js, src/v4/store.js |
| `src/v2/runtime/orchestrator.js` | not-used | Drives V2's compile→plan→schedule→verify pipeline. V4's agent loop owns planning and verification; running it would be a second orchestrator. |
| `src/v2/runtime/receipts.js` | reused | imported by src/v2/runtime/goal.js |
| `src/v2/runtime/scheduler.js` | reused | imported by src/v2/gauntlet/gauntlet.js, src/v2/runtime/orchestrator.js, src/v4/graph.js |
| `src/v2/runtime/states.js` | reused | imported by src/v2/runtime/goal.js, src/v4/agent.js, src/v4/graph.js, src/v4/store.js |
| `src/v2/runtime/verifiers.js` | reused | imported by src/v2/runtime/verify-bridge.js, src/v2/tools/builtins.js, src/v2/voice/speak.js, src/v3/runtime/file-deliverable.js, src/v4/agent.js |
| `src/v2/runtime/verify-bridge.js` | not-used | Bridges V2 acceptance to V2 verifiers; V4 calls runVerifier directly. |
| `src/v2/safety/approvals.js` | reused | imported by src/v4/agent.js, src/v4/server.js |
| `src/v2/safety/command-preflight.js` | reused | imported by src/v2/exec/sandbox.js, src/v2/voice/stt.js, src/v2/voice/tts.js |
| `src/v2/spawn/safe-exec.js` | reused | imported by src/v2/voice/stt.js, src/v2/voice/tts.js |
| `src/v2/studio/page.js` | not-used | UI for the V2 studio server, which V4 rejected for having no session model. |
| `src/v2/studio/server.js` | not-used | Desktop operator surface without a session model (rejected in SOURCE_AUDIT). |
| `src/v2/supervisor/plan-with-model.js` | not-used | Model-assisted V2 planning; V4 plans inside the conversation turn. |
| `src/v2/supervisor/roles.js` | not-used | Planning roles for the V2 supervisor, which V4 does not run. |
| `src/v2/supervisor/supervisor.js` | not-used | Plans V2 task graphs for the V2 scheduler. |
| `src/v2/telemetry/aggregate.js` | not-used | Renders V2's report; V4 reads the ledger directly. |
| `src/v2/telemetry/ledger.js` | reused | imported by src/v2/studio/server.js, src/v4/server.js |
| `src/v2/tools/builtins.js` | not-used | V2's read_file/write_file/verify_now demo tools; V4 defines its own workspace tools on the same V2 contract. |
| `src/v2/tools/registry.js` | reused | imported by src/v2/tools/runner.js, src/v4/tools.js |
| `src/v2/tools/runner.js` | reused | imported by src/v4/agent.js, src/v4/server.js, src/v4/tools.js, src/v4/tools/host.js |
| `src/v2/voice/listen.js` | reused | imported by src/v2/studio/server.js, src/v4/voice.js |
| `src/v2/voice/speak.js` | reused | imported by src/v2/studio/server.js, src/v4/voice.js |
| `src/v2/voice/stt.js` | reused | imported by src/v4/voice.js |
| `src/v2/voice/tts.js` | reused | imported by src/v2/voice/speak.js, src/v4/voice.js |

## V3 components

| Component | Status | Reason |
| --- | --- | --- |
| `src/v3/platform/runtime.js` | not-used | Node >= 22 check; V4 performs the same check in assertNodeSupported(). |
| `src/v3/runtime/file-deliverable.js` | not-used | V3's file vertical slice is V4's workspace_write + V2 file verifier, with approvals and receipts added. |
| `src/v3/server.js` | not-used | V3's single-purpose HTTP server (one file deliverable). V4's server supersedes it. |
| `src/v3/ui/page.js` | not-used | V3's static page for the file-deliverable demo; V4 has the PWA. |

## V4 lanes on this host

| Lane | Available | Tools | Reason |
| --- | --- | --- | --- |
| desktop | no | 0 | Windows-only (this host is linux) |
| computer | no | 0 | Windows-only (this host is linux) |
| screen | no | 0 | Windows-only (this host is linux) |
| net | yes | 5 |  |
| files | yes | 13 |  |
| shell | yes | 5 |  |
| shelltools | yes | 5 |  |
| sys | yes | 6 |  |
| power | yes | 3 |  |
| web | yes | 16 |  |
| research | yes | 1 |  |
| jobs | yes | 9 |  |
| flows | yes | 6 |  |
| github | yes | 2 |  |
| channels | yes | 1 |  |
| audit | yes | 1 |  |
| learn | yes | 3 |  |
| marketing | yes | 4 |  |
| re | yes | 23 |  |
| trading | yes | 2 |  |
