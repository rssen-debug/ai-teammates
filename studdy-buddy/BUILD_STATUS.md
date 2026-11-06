# BUILD_STATUS

Last updated: 2026-11-06
Environment used for verification: **Linux (x64), Node v22.22.3** — no Windows desktop,
no Packet Tracer installation, no NetAcad account, no AI provider API key.

Legend

| Status | Meaning |
| --- | --- |
| **VERIFIED** | Executed in this environment, output observed, covered by an automated test or a recorded command run. |
| **IMPLEMENTED_NOT_VERIFIED** | Code exists and typechecks, but the runtime behaviour could not be exercised here (needs Windows, a real app, or credentials). |
| **BLOCKED** | Cannot be completed in this environment. The blocker is named. |
| **FAILED** | Attempted and did not work. |

> Nothing below is marked VERIFIED unless it actually ran. Where a claim depends on
> Windows, Packet Tracer or NetAcad, it is marked IMPLEMENTED_NOT_VERIFIED or BLOCKED.

---

## Verified in this environment

| Area | Status | Evidence |
| --- | --- | --- |
| TypeScript typecheck (whole repo, strict) | VERIFIED | `npm run typecheck` → 0 errors |
| Node/Electron runtime floor | VERIFIED (and a real bug fixed) | CI failed on pinned Node **22.12**, where `node:sqlite` still needs `--experimental-sqlite`; `package.json` claimed `>=22.5.0`. Electron 33 bundles Node **20**, where the module does not exist at all, so the packaged app could never have opened its own database. Floor is now `>=22.13`, Electron `^37`, CI pins 22.13, and `tests/unit/runtime-floor.test.ts` fails if either regresses |
| Automated test suite | VERIFIED | `npm test` → **300 tests, 19 files, all passing** (see TEST_RESULTS.md) |
| SQLite persistence + versioned migrations | VERIFIED | Fresh DB creates 19 tables, schema v4; migration idempotency test; WAL mode |
| Settings/provider persistence | VERIFIED | Survives reopen; API key never present in the `provider_config` table (asserted) |
| Bayesian Knowledge Tracing | VERIFIED | `tests/unit/learning-engine.test.ts` (13 tests) |
| Mastery is revisable / reading ≠ mastery | VERIFIED | Incorrect-after-correct demotes state; exposure capped at 0.2 probability |
| Spaced repetition + due reviews | VERIFIED | Review interval, `REVIEW_DUE`, `dueReviews()` |
| Prerequisite gap diagnosis | VERIFIED | `weakPrerequisites` / `diagnoseGap` (subnetting → binary) |
| Curriculum discovery (no hardcoded module count) | VERIFIED | 6/9/12/17/21-module fixtures all report their own count |
| Curriculum hierarchy + stable ids | VERIFIED | Numeric-path parenting; ids stable across repeated discovery |
| Honest handling of unreadable content | VERIFIED | Same-titled modules don't collide; iframe content flagged inaccessible; completion stays `null` unless reported |
| Assessment-mode classification | VERIFIED | Formal / graded / practice / self-study, conservative defaults |
| Quiz observation never infers correctness | VERIFIED | Selection alone leaves `officialCorrectness === null`; only explicit feedback sets it |
| Adaptive quiz selection | VERIFIED | Weakest concept first, due reviews prioritised, no repeats, single question by default |
| Deterministic quiz grading | VERIFIED | 20 questions, one correct option each, hints reduce credit, tolerant answer normalisation |
| Cisco IOS output parsing | VERIFIED | `show ip interface brief`, `running-config`, `vlan brief`, `ip route`, `mac address-table`, ping |
| No invented subnet masks/conclusions | VERIFIED | Parser leaves mask `null` when not printed; fault engine returns `conclusion: null` without dominant evidence |
| Simulation-mode explanation | VERIFIED | ARP walkthrough; refuses to state a cause when the reason is not on screen |
| Permission gate | VERIFIED | Defaults closed; action requires APPROVED_ACTION + grant; guide requires VISUAL_GUIDE |
| Proactive governor | VERIFIED | Never fires during GRADED_QUIZ/FORMAL_EXAM; cooldown enforced |
| Context assembly | VERIFIED | Labelled facts, size caps, non-approved windows excluded and reported |
| Agent task queue | VERIFIED | Durable queue, bounded batch, exponential backoff, orphan recovery, no-handler guard |
| Perception dedupe (cost control) | VERIFIED | Time-windowed dedupe + image fingerprint |
| AI router: budget, cache, rate limit | VERIFIED | Daily ceiling blocks calls; identical requests served from cache; auth/500 errors surface |
| Structured explanation + length policy | VERIFIED | JSON parse (fenced/prose-wrapped), filler-opener detection, per-mode sentence/word caps, local trim |
| Secret redaction | VERIFIED | `sk-*`, Bearer tokens, `api_key=`, passwords redacted before logging |
| Voice is off by default | VERIFIED | Schema default `enabled: false`; `assertSpeechIsRequested` blocks otherwise |
| Technical pronunciation | VERIFIED | IP octets, CIDR, MAC (colon + Cisco dotted), `Gi0/1`, acronyms; verified in both languages |
| Voice provider honesty | VERIFIED | Cloud TTS reported unconfigured without a key; Linux reports SAPI unavailable |
| Mascot animation state machine | VERIFIED | 13 states, priorities, transient expiry, signal mapping, expression table |
| Screen-overlay geometry | VERIFIED | Multi-monitor incl. negative origins, DPI physical↔DIP round-trip, tooltip placement, stale-target rejection |
| Bubble placement | VERIFIED | Stays on screen, avoids reading area, nudges rather than overlapping, stable side |
| Click-through policy | VERIFIED | Only mascot + bubble accept input |
| Bridge auth | VERIFIED | Constant-time token compare, allow-listed message types, size cap |
| Loopback bridge server | VERIFIED | Real socket: binds 127.0.0.1 only, refuses to start without a token, closes on wrong token/unknown type, rejects unlisted sites, ping/pong, broadcast only to authenticated clients (`tests/unit/bridge-server.test.ts`, 11 tests) |
| Bridge end-to-end, real app | VERIFIED | Booted the bundled `main.cjs`, added `canvas.instructure.com` through the IPC handler, connected as the extension, sent a page, and read the SQLite file: 6 nodes stored, 5 dynamic topics, `Modul 3: Meiosis=okänd` |
| Any-subject support (no NetAcad assumption) | VERIFIED | Canvas biology course discovered, biology topics registered, prompt contains the real page and contains no Cisco/DVA120 text (`tests/integration/any-subject-memory.test.ts`) |
| Model memory across turns | VERIFIED | Previous question + previous answer are in the second request; the current question is sent exactly once (a duplicate-question bug was found and fixed) |
| Progress reaches the model | VERIFIED | Prompt states "Ingen kunskap är registrerad ännu" on a fresh profile and names the concept with independent-correct counts after real evidence |
| Memory budgeting | VERIFIED | Oldest turns dropped, drop count disclosed to the model, character budget enforced |
| `agent-desktop` CLI contract | VERIFIED | **The real binary was installed and run** (v1.2.0, protocol 2.6). Envelope shape, exit codes 0/1/2, absence of a `--json` flag and the `list-windows`/`--window-id` command names were observed, not assumed. Two real defects in the adapter were found and fixed. |
| Page-origin allow-list | VERIFIED | Rejects `netacad.com.evil.io`, http, unrelated hosts |
| End-to-end chat flow | VERIFIED | Provider → permission → answer → persistence → learning record → restart (11 tests) |
| End-to-end NetAcad loop | VERIFIED | Discovery → context → observation → evidence → mastery → next question (10 tests) |
| Renderer production build | VERIFIED | Vite build succeeded, 327 kB JS (96 kB gzip) |
| Electron main + preload bundle | VERIFIED | esbuild → `main.cjs` / `preload.cjs`; loaded under a stubbed Electron runtime: **39 IPC handlers registered, bridge listening on ws://127.0.0.1:8765, database file created** |
| CLI `doctor` / `status` / `models` / `progress` / `logs` / `voice-test` | VERIFIED | Real runs against a real database (output in TEST_RESULTS.md) |
| CLI honest blocking | VERIFIED | Reports BLOCKED for Windows-only checks instead of guessing |
| ESLint gate | VERIFIED | `npm run lint` → **0 errors, 0 warnings** (flat config, typescript-eslint). Wired into CI. |
| 0-100 readiness scale | VERIFIED | Derived from coverage (40) + mastery (40) + retention (20), each with its own detail line; returns `null` (shown as `–`) rather than `0` when nothing is recorded; reading alone cannot move it (`tests/unit/readiness.test.ts`, 12 tests) |
| Progress panel rendering | VERIFIED | Real component rendered in jsdom: score, three weighted meters, every limitation, next steps, and platform completion shown separately from knowledge (`tests/unit/progress-panel.test.tsx`, 5 tests) |
| `studdy readiness` CLI | VERIFIED | Real run against a real database: empty profile prints "Kan inte mätas ännu", a seeded profile prints `38/100` with all three parts and its limitations |
| Single build/dev entry point | VERIFIED | `node apps/desktop/scripts/dev.mjs` builds renderer + main + runtime manifest and then launches Electron; on a machine without the Electron binary it prints the reason and the fix instead of crashing |

## Implemented, not verified here

| Area | Status | What is missing |
| --- | --- | --- |
| Electron windows on Windows 11 | IMPLEMENTED_NOT_VERIFIED | Needs a Windows desktop. Window options, transparency, always-on-top and click-through are constructed and unit-tested, but not rendered. |
| Mascot visual appearance | IMPLEMENTED_NOT_VERIFIED | SVG character + CSS animation are built into the bundle; nobody has looked at it on a real display. Readability at small size is a judgement call that needs eyes. |
| `agent-desktop` on Windows | IMPLEMENTED_NOT_VERIFIED | The CLI was installed and its contract observed (Linux host), but `list-windows`/`snapshot` never ran against real windows here: no accessibility bus and no display. The Windows UI Automation path is untested. See docs/AGENT_DESKTOP.md. |
| Screen capture | IMPLEMENTED_NOT_VERIFIED | Uses Electron `desktopCapturer`. Not exercised (no display server). |
| Overlay on a real screen | IMPLEMENTED_NOT_VERIFIED | Geometry is tested; the actual transparent always-on-top window is not. |
| Windows SAPI speech | IMPLEMENTED_NOT_VERIFIED | Command construction is tested; audio was never produced (no Windows). |
| OpenAI-compatible / ElevenLabs TTS | IMPLEMENTED_NOT_VERIFIED | HTTP clients are written and error paths tested with a fake fetch; no real key was used. |
| DeepSeek (or any) provider call | BLOCKED | **No API key available in this environment.** All provider logic is tested against a fake transport; the exact DeepSeek `deepseek-flash` identifier was never called. |
| Vision capability | BLOCKED | Requires a provider with a vision model. The probe exists; it was not run against a real endpoint. |
| Tool calling | BLOCKED | Same reason. The probe exists and reports `false` on failure rather than assuming support. |
| Browser extension in Chrome/Edge | IMPLEMENTED_NOT_VERIFIED | Manifest V3 code is complete and now site-agnostic; it was never loaded into a browser. The protocol it speaks is verified from the server side over a real socket. Real course-site DOM structure is assumed, not observed. |
| Windows installer (.exe) | BLOCKED **here**; produced by CI | electron-builder NSIS requires Windows/Wine, neither available in this sandbox. The `package` job (`windows-latest`) builds it and the `proof` job fails if no `.exe` exists. Nobody has run the resulting installer yet. |
| App launching on Windows 11 | IMPLEMENTED_NOT_VERIFIED | A CI job (`Windows launch proof`) installs the app, launches the real `electron.exe`, and requires the renderer to report `{"mascot":true,…}`. The hook exists (`STUDDY_SMOKE_EXIT_MS`, inert by default) and the assertion fails the build rather than warning. **It has never run.** It also could not run from the original layout: the only workflow lived at `studdy-buddy/.github/`, which GitHub never reads. It now also exists at the repository root as `.github/workflows/studdy-buddy.yml` (same jobs, `working-directory: studdy-buddy`), so the next push either produces `evidence/` or a red job. |
| Packet Tracer observation | BLOCKED | Packet Tracer is not installed; `.pkt`/`.pka` parsing via official interfaces was not implemented because no documented interface was verified. CLI parsing is fed from fixtures. |
| NetAcad curriculum discovery on the live site | BLOCKED | No NetAcad account. Fixtures encode the *expected* DOM shape. **The real DOM may differ** — the extension reports what it can read and marks the rest inaccessible, which is the mitigation. |
| DVA120 official syllabus mapping | BLOCKED | No authorised syllabus source was available. The exam coach maps onto our own concept graph and says so; it does not claim official scope. |

## Known gaps in the code

These are real and should not be papered over:

1. **The renderer's capability probe is indirect.** `probeCapabilities` goes through the diagnostics channel and depends on the diagnostics payload including capabilities; the Settings panel's `onProbeCapabilities` currently reads them from that payload rather than a dedicated channel. The dedicated `AiRouter.capabilities()` call is implemented and tested at package level.
2. **RateLimiter false positive at high load.** The limiter rejects requests that are merely frequent; correct behaviour but worth tuning against real latency.
3. **OCR is not implemented.** Vision analysis is planned via a verified vision model; no local OCR pipeline exists.
4. **No auto-update.** Deliberate (needs a signed feed).

## Next actions, in priority order

0. **Run the `Windows launch proof` job and attach `evidence/`.** This is the first thing that turns "it builds" into "it starts". Then work through `docs/WINDOWS_PROOF.md`.
1. **Run `agent-desktop list-windows` / `snapshot` on Windows 11.** The contract is now verified; the mapping of real UI Automation windows and bounds is not. This is the highest-value remaining unknown.
2. Load the extension in Chrome/Edge against a real Canvas or NetAcad course and compare the discovered graph with what the site actually shows. The generic DOM readers (nav/headings/completion) are guesses about structure until then.
3. Make a real DeepSeek call with the student's key and fill in the capability table (`deepseek-flash` as the official id; third-party ids entered by hand).
4. Visual pass on the mascot and bubble at 100 %/150 %/200 % scaling on a real display.
5. Loudness/quality pass on Windows SAPI Swedish, then evaluate TTS providers on real audio.
6. Packet Tracer: verify which UI Automation / extension surface (if any) exists in the installed version before writing more parsers.
