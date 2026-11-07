# MAJIN V3 source audit — initial, evidence-backed

**Audit date:** 2026-10-22 (Europe/Stockholm)
**Status:** Initial inventory complete; behavioral audit is still in progress.
**Scope rule:** `main` (V1) and `v2/main` are read-only source lines. V3 changes are confined to `v3/main` and new `src/v3/`, `test/v3-*`, `docs/v3/` paths.

## Source baselines observed before the V3 round

| Line | Remote ref | Observed SHA | Evidence |
|---|---|---|---|
| MAJIN V1 | `origin/main` | `814459ea50fc86c5ac1aeed939ec9d2344dc5bfb` | `git ls-remote`, then `git rev-parse origin/main` |
| MAJIN V2 | `origin/v2/main` | `b2533097ca3c744fa7e9b152b221a97186507835` | `git ls-remote`, then `git rev-parse origin/v2/main` |
| V3 starting point | local `v3/main` | `b2533097ca3c744fa7e9b152b221a97186507835` | Branch created from `origin/v2/main`; no remote V3 ref was present at inspection |

V1 and V2 refs are not V3 write targets; work remains on the separate `v3/main` branch. The initial vertical slice added new V3 files. This Node-floor follow-up also updates shared package/install/startup policy and the V2 Doctor's runtime check on `v3/main`; it does not switch to or alter the protected V1/V2 refs.

## V1 inventory and classification

| Subsystem | Code evidence | Classification | Finding / follow-up |
|---|---|---|---|
| Conversation and agent loop | `src/core/agent.js`, `src/core/loop.js`, `src/core/chats.js` | ADAPT / WRAP | Reuse the established conversation/tool loop behind a V3 goal boundary. Re-audit interrupt and cancellation contracts before binding it to V3. |
| Providers and model calls | `src/core/provider/{chat,openai,anthropic,responses,catalog}.js`; V2 `src/v2/model/{provider,profiles,registry}.js` | ADAPT | Existing provider implementations and V2 profile/routing work are the source of truth; do not create a second provider SDK layer without a measured gap. Key persistence and streaming acceptance remain open. |
| Browser | `src/core/browser.js`, `browser-ground.js`, `browser-semantic.js`, `browser-evidence.js`, `browser-recovery-policy.js`, `browser-action-receipt.js` | WRAP / ADAPT | The repository already has CDP browser control, structured grounding, action evidence and recovery. Prefer its structured/DOM path before visual coordinates; test on real sites before claiming reliable browser control. |
| Desktop / Windows | `src/core/computer-use.js`, `src/core/tools/computer.js`, `src/core/tools/wincontrol.js`, `src/core/tools/power.js` | WRAP | Keep behind V2/V3 permission and verification gates. Windows desktop acceptance cannot be inferred from this Linux sandbox. |
| Filesystem and shell tools | `src/core/tools/files.js`, `exec.js`, `shell.js`, `sys.js` | WRAP | These are powerful inherited capabilities. V3 must not expose the full registry by default; adapt them to a per-goal workspace and consent policy. The first V3 slice intentionally uses only a create-only file capability. |
| Web, GitHub, networking | `src/core/tools/web.js`, `github.js`, `net.js`, `research.js` | ADAPT | Reuse maintained integrations for research and repository workflows; treat fetched content as untrusted. External credentials must stay out of logs and source. |
| Memory | `src/core/memory.js`, `src/core/memory-sync.js`; V2 `src/v2/memory/store.js` and `context/engine.js` | ADAPT | Start with the repository's small local store/context path. Do not add vector infrastructure before relevance and scale tests justify it. |
| Channels / integrations | `src/core/tools/channels.js`, `teams.js`, `jobs.js`, `marketing.js` | DEFER / WRAP | Useful capabilities exist but are not part of the V3 first vertical slice; external actions need explicit scopes and confirmation. |
| Windows installation / releases | `install.ps1`, `installer/`, `.github/workflows/`, `scripts/` | ADAPT | Reuse packaging and installation conventions only after V3 entry points and clean-install behavior are tested on Windows. No Windows V3 release evidence exists yet. |

## V2 inventory and classification

| Subsystem | Code evidence | Classification | Finding / follow-up |
|---|---|---|---|
| Durable goal state machine | `src/v2/runtime/goal.js`, `states.js` | ADOPT | V3 vertical slice directly reuses `Goal`, its legal state transitions, acceptance gate and JSON persistence. |
| Receipts and verification | `src/v2/runtime/receipts.js`, `verifiers.js`, `verify-bridge.js` | ADOPT / WRAP | V3 uses the existing file verifier and receipt verification; it does not treat a successful write as proof by itself. HTTP/DOM/pixel adapters remain candidates for later tasks. |
| Task DAG and scheduling | `src/v2/runtime/dag.js`, `scheduler.js`, `src/v2/runtime/orchestrator.js` | ADAPT | Reuse the DAG/scheduler for actual multi-step goals. Audit the orchestrator's deterministic deliverable templates before treating it as a general autonomous executor. |
| Model-based planning and roles | `src/v2/compiler/`, `src/v2/supervisor/` | ADAPT | Reuse behind a bounded goal API after model/provider fallback, cancellation and prompt-injection tests are added. Not used by the deterministic V3 demo. |
| Safe execution and approval | `src/v2/spawn/safe-exec.js`, `src/v2/exec/`, `src/v2/safety/` | ADOPT / ADAPT | Reuse the audited safe-exec/approval boundaries; V3 demo invokes no process or shell. V3-wide authorization remains incomplete. |
| Memory and context | `src/v2/memory/store.js`, `src/v2/context/engine.js` | ADAPT | Reuse with provenance and user controls; no vector database is introduced in this round. |
| Voice | `src/v2/voice/{listen,speak,stt,tts}.js` | ADAPT / DEFER | Existing batch voice facilities are not proof of continuous, interruptible realtime voice. Real microphone, barge-in, Swedish and reconnect tests remain mandatory. |
| Studio / UI | `src/v2/studio/page.js`, `server.js` | REPLACE DEFAULT SURFACE / WRAP ADVANCED | V2 Studio is an operator-oriented multi-panel surface. V3 starts with a separate, minimal local surface; existing Studio remains untouched. |
| Telemetry, audit, model registry | `src/v2/telemetry/`, `src/v2/audit/`, `src/v2/model/registry*` | ADOPT selectively | Strong candidates for later evidence, provenance and provider health; do not expose their dashboards in the default UI. |

## Audit confidence and known gaps

- This pass inspected repository structure, V2 architecture/baseline/dependency/security documentation, goal and verifier code, selected V1/V2 implementation files, and the full Node test suite on the V2 baseline.
- It is a **source inventory and reuse decision**, not a complete behavioral audit of every listed subsystem.
- The observed Node suite baseline on this sandbox was 1,176 passed, 0 failed, 19 skipped (1,195 total). Environment-gated voice/provider/Windows lanes remain skipped or unrun; this does not validate real hardware behavior.
- The V2 orchestrator includes deterministic templates and must not be described as general model-driven website/research creation without separate evidence.
- Next audit pass: map every tool's risk/permission contract; inspect V1/V2 voice turn control and model-selection persistence; run the relevant browser, desktop, voice and Windows workflows on their target hosts.
