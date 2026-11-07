# MAJIN — full unification audit (V1 / V2 / V3 / V4)

**Date:** 2026-10-23 · **Branch:** `v4/main`
**Method:** reading the source in `main`, `v2/main`, `v3/main`, `v4/main`, plus the
302 remote branches, not the READMEs.

**Environment truth for this audit:** the audit ran on a Linux sandbox with no
Windows host, no Tailscale endpoint, no phone and no provider credential. Anything
that requires them is marked **UNVERIFIED**, never "done".

## 0. The one-paragraph summary

MAJIN's *engine* is largely finished and heavily tested (V2's goal/receipt/verifier
kernel, V4's gateway, 293 tests). MAJIN's *reach* is not: the tools that touch a
real Windows desktop, a real browser and real user folders live in V1 and were
never wired into V4 until this audit. That wiring now exists and its contract is
tested; **its effect on Windows is not tested here and cannot be.**

## 1. Capability matrix

Legend — **Works**: verified by executable test in this environment.
**Wired**: adapted into V4 and contract-tested, effect unverified.
**Absent**: does not exist anywhere in the repo.

### 1.1 Agent engine

| Capability | Source | Files | Works | In V4 | Evidence |
|---|---|---|---|---|---|
| Goal state machine (12 states) | V2 | `v2/runtime/states.js` | yes | imported verbatim | `conversation.test.js`, `crash.test.js` |
| Evidence receipts | V2 | `v2/runtime/receipts.js` | yes | verbatim | `conversation.test.js` |
| Verifiers (file/http/pixel/dom) | V2 | `v2/runtime/verifiers.js` | yes | verbatim | `conversation.test.js` |
| Tool contract + runner | V2 | `v2/tools/registry.js`, `runner.js` | yes | verbatim | `host-tools.test.js` |
| Consent/approvals | V2 | `v2/safety/approvals.js` | yes | verbatim | `agent-failures.test.js` |
| Failure→recovery plan | V2 | `v2/recover/advisor.js` | yes | imported | `recovery.test.js` |
| Outer recovery loop | V2 | `v2/recover/outer-loop.js` | — | **not used**: drives V2's `runObjective`, which V4 does not run | — |
| Task DAG / scheduler | V2 | `v2/runtime/dag.js`, `scheduler.js` | usable | **not wired** | — |
| Supervisor / roles / subagents | V2 | `v2/supervisor/*` | scaffold | **not wired** | — |
| Multi-agent execution | — | — | **absent** | — | — |
| Parallel task execution | — | — | **absent** | — | — |

### 1.2 Windows desktop control

| Capability | Source | Files | Works | In V4 | Evidence |
|---|---|---|---|---|---|
| Window enumeration | V1 | `core/tools/wincontrol.js` (`control.list_windows`) | Windows only, **measured in V1's own CI** | **wired** (tier `read`) | `host-tools.test.js` — contract only |
| Text entry into a window | V1 | same (`control.type`, WM_SETTEXT) | Windows only | **wired** (tier `process`) | contract only |
| Read-back verification | V1 | same (`control.read`, WM_GETTEXT) | Windows only | **wired** (tier `read`) | contract only |
| Button press | V1 | same (`control.click_button`, BM_CLICK) | Windows only | **wired** (tier `process`) | contract only |
| Move the real cursor | V1 | same (`mouse.move`) | Windows only | **wired** (tier `process`) | contract only |
| Screenshot capture | — | V1 `desktop-vision.js` references a capture tool that is **not** in `core/tools` | **absent as a tool** | — | — |
| Mouse click / drag | — | — | **absent** | — | — |
| Keyboard shortcuts / clipboard | — | — | **absent** | — | — |
| Application launch | V1 | `core/tools/exec.js` + `power.js` | usable | wired as shell lane (tier `process`) | contract only |
| UIA / accessibility lane | — | deliberately not built: V1's audit found UIA exposes bare Pane on windows-2025 | **absent by decision** | — | V1 `wincontrol.js` header |

**This is the biggest real gap and it is now honest rather than silent.** MAJIN can
enumerate windows, type into them, read them back and click buttons on a measured
Win32 lane. It cannot take screenshots, move-and-click at coordinates, or use
keyboard shortcuts, because no version ever implemented those as tools.

### 1.3 Filesystem

| Capability | Source | Files | Works | In V4 | Evidence |
|---|---|---|---|---|---|
| list / read / write / patch | V1 | `core/tools/files.js` (`fs.*`, 557 lines) | yes | **wired** | `host-tools.test.js` (real read) |
| search / grep / stat / mkdir | V1 | same | yes | **wired** | contract |
| copy / move / delete / tar | V1 | same | yes | **wired**, delete is tier `process` | contract |
| Path guard (workspace + protected dirs) | V1 | `resolveIn()` in the same file | yes | inherited | contract |
| PDF / DOCX / XLSX parsing | — | — | **absent** (no parser dependency in the repo) | — | — |
| Image analysis | — | — | **absent** | — | — |

### 1.4 Browser

| Capability | Source | Files | Works | In V4 | Evidence |
|---|---|---|---|---|---|
| Playwright launch/pool/navigate | V1 | `core/browser.js` (402 lines) | usable | **not wired** | — |
| DOM verification | V2 | `runtime/verifiers.js` (`verifyDom`) | degrades honestly without playwright | verbatim | `conversation.test.js` |
| Click / fill / upload / download as tools | — | — | **absent** | — | — |
| Real browser binary in this sandbox | — | — | **absent** (no CDN access, no NSS) | — | `TEST_EVIDENCE.md` §3.2 |

The capability detector reports `browser.available: false` with the reason and
lists **zero** tools. It does not advertise tools that do not exist.

### 1.5 Models and providers

| Capability | Source | Works | In V4 | Evidence |
|---|---|---|---|---|
| OpenAI/Anthropic/Responses transport + SSE | V1 `core/provider/*` | yes | **used** | `models.test.js` |
| Live model catalog | V1 `core/provider/catalog.js` | yes | **used** | `models.test.js` |
| Per-conversation model choice | V4 | yes | native | `models.test.js` |
| `x-opencode-session` header | V1 presets carry `headers` per provider | yes | inherited through the route | not exercised (no credential) |
| Real inference | — | — | **BLOCKED**: no provider key in this environment | `accept.test.js` asserts `model.configured: FAIL` |
| Token/cost accounting | V1 `ratelimit.js` + `usage` | yes | used | `models.test.js` |
| Fallback chain | V2 `model/registry.js` | usable | not wired | — |

### 1.6 Voice

| Capability | Source | Works | In V4 | Evidence |
|---|---|---|---|---|
| Browser recognition + synthesis | V4 UI | yes | native | `ui.test.js`, `client-dom.test.js` |
| Tap-to-talk, one turn at a time | V4 UI | yes | native | honest capability model |
| Server-side TTS (offline provider) | V2 `voice/speak.js` | yes | **wired** | `voice-server.test.js` |
| Server-side TTS via local binary | V2 `voice/tts.js` | yes | **wired** | `voice-server.test.js` |
| Server-side STT via local binary | V2 `voice/stt.js` | yes | **wired** | `voice-server.test.js` |
| Barge-in / measured latency | — | — | **absent** (no device) | — |
| Always-listening | — | — | **not claimed** | — |

### 1.7 Session, security, operations

| Capability | Source | Works | Evidence |
|---|---|---|---|
| Pairing → signed session, revocation | V4 | yes | `security.test.js` |
| CSRF / origin / host allowlist | V4 | yes | `security.test.js` |
| Rate limiting (bounded) | V4 | yes | `security.test.js`, `leaks.test.js` |
| Prompt-injection corpus | V4 | yes | `agent-failures.test.js` |
| Telemetry ledger (privacy allowlist) | V2 | yes | `telemetry.test.js` |
| Turn journal + reconnect | V4 | yes | `turns.test.js`, `journal-live.test.js` |
| Crash reconciliation | V4 | yes | `crash.test.js` |
| Supervisor + restart | V4 | yes | `supervisor.test.js` |
| Backup / restore / rollback | V4 | yes | `backup.test.js` |
| Upgrade with rollback | V4 | yes | `upgrade-git.test.js` |
| **Zero-PowerShell auto-update** | — | **absent** | no release channel, no signature verification, no updater daemon |

### 1.8 Mobile / PWA

| Capability | Works | Evidence |
|---|---|---|
| Installable PWA, safe areas, reduced motion | yes | `ui.test.js` |
| Real client executed in jsdom | yes | `client-dom.test.js` |
| Mid-stream reattach | yes | `client.test.js` |
| Physical iPhone / Android | **UNVERIFIED** — no device | — |
| Real layout/paint | **UNVERIFIED** — no browser binary | `npm run v4:e2e` on the host |
| Push notifications | absent | — |

## 2. What this audit changed in the code

`src/v4/tools/host.js` is new: it detects what the host can actually do and adapts
V1's proven tool implementations into V2 `ToolDefinition`s so they run through the
same runner, approvals and receipts as everything else.

Design decisions worth naming:

- **Opt-in.** `MAJIN_V4_HOST_TOOLS=1` is required; the default host exposes only the
  workspace. `MAJIN_V4_HOST_TOOL_ALLOW` narrows it further.
- **Risk → tier.** `exec` becomes `process`, which V2's runner holds for consent.
  `fs_delete` and `exec_start` are therefore held, not auto-approved.
- **No phantom tools.** The browser lane reports zero tools because none exist.
  An earlier draft listed four names; the test caught it.
- **Name mapping.** V1 uses dots (`fs.read`); V2's registry forbids them. Names are
  mapped deterministically to `fs_read` and the original is kept as `sourceName`.
- **Absent ≠ broken.** A lane that is not present is not registered and states why.

## 3. What is still missing, ranked by user value

| # | Gap | Why it matters | Blocked by |
|---|---|---|---|
| 1 | Screenshot / click-at-coordinate / keyboard tools | the examples in the brief ("look at my desktop", "open Edge") need them | implementation + Windows to verify |
| 2 | Browser tools (navigate/click/fill) | job search, form filling | browser binary on the host |
| 3 | Zero-PowerShell updater with signature verification | explicit non-negotiable in the brief | release channel + signing key |
| 4 | Multi-agent / parallel execution | three examples in the brief | design + implementation |
| 5 | PDF/DOCX/XLSX reading | "find my CV" needs it | a parser dependency |
| 6 | Job-search workflow | worked example in the brief | 1, 2, 5 |
| 7 | Push notifications | continuity | device |
| 8 | Real inference from the phone | everything | provider credential on the host |

## 4. What cannot be verified here, and what would verify it

| Claim | Verifier |
|---|---|
| Windows desktop control works | `npm run v4:accept` on the Windows host + one manual `control.list_windows` from the phone |
| Browser automation works | `npm run v4:e2e` on the host |
| Real inference | `npm run v4:accept` (already asserts `model.configured`) |
| iPhone / Android | the §5 walkthrough in `DEPLOYMENT.md` |
| Auto-update | a published release with a signature, then one unattended cycle |
| Tailscale endpoint | `npm run v4:accept -- --url https://<tailnet>` |

## 5. Honest status

Nothing in this document is "100%". The engine is close; the reach is not. Every
claim above has either a test name or the word **UNVERIFIED** next to it, and the
acceptance matrix in `docs/v4/ACCEPTANCE_MATRIX.json` still scores **78.5/100** —
because the 20 points that require your Windows machine have not moved, and this
audit did not move them.
