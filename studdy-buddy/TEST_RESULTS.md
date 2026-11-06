# TEST_RESULTS

Executed 2026-11-06 on **Linux x64, Node v22.22.3**, in the Arena sandbox.
Every number below comes from an actual run. Nothing is estimated.

---

## 1. Unit + integration suite

Command:

```bash
cd studdy-buddy && npx vitest run
```

Result:

```
 Test Files  19 passed (19)
      Tests  300 passed (300)
   Duration  ~4.5s
```

### Per file

| File | Tests | What it proves |
| --- | ---: | --- |
| `tests/unit/database.test.ts` | 8 | Migrations apply on a fresh DB; are idempotent on reopen; settings survive restart; one open session; message cascade delete; ordered transcript; curriculum graph round-trip with honest module count and `null` completion; usage + task lifecycle |
| `tests/unit/learning-engine.test.ts` | 17 | BKT raises on correct / lowers on wrong; hard items weighted higher; reading alone never yields mastery; hints reduce credit; MASTERED needs repeated independent evidence; confidence stays low after one observation; prerequisite closure + weakest-first diagnosis; readiness honest with zero/incorrect evidence; REVIEW_DUE after the interval; **mistakes demote mastery**; evidence persists |
| `tests/unit/ai-router.test.ts` | 17 | Validated structured answer + usage recorded; cache prevents a second provider call; budget exhaustion blocks with zero HTTP calls; auth failure surfaced not swallowed; over-long answer retried then trimmed locally; API key sent only as a header; vision refused without a configured vision model; health check honest on 500; cost maths; filler-opener/unspupported-confidence/missing-example validation; JSON parsing from fences and from prose; secret redaction |
| `tests/unit/curriculum.test.ts` | 22 | Module count comes from the page (9 and 17 both correct); numeric-path parenting; quizzes/labs classified; completion `null` unless reported; iframe → warn not invent; ids stable across runs; same-titled sections don't collide; current-node detection picks the deepest heading match; ancestor chain; assessment classification (formal/graded/practice/self-study); graded mode still allows concept help but not answers; quiz observation **never** equates selection with correctness; explicit feedback read; retry detection; per-option markers ignored without a verdict; stable question id |
| `tests/unit/quiz-engine.test.ts` | 20 | Bank integrity (unique ids, one correct option, accepted answers, rubrics); correct/wrong evaluation; misconception text for the specific wrong option; alternative binary formats; CLI answer normalisation; hinted answer is not independent; EXPLAIN_BACK rubric threshold with lower grading confidence; unknown question returns `null`; remediation plan; adaptive targeting; weakest concept chosen; due review prioritised; current topic boosted; no repeats; deterministic for a seed; concept rotation; one question by default |
| `tests/unit/packet-tracer.test.ts` | 21 | `show ip interface brief` incl. `administratively down` two-word status; **no invented subnet mask**; warn on unrelated text; `running-config` interface extraction; `show vlan brief`; MAC table; routing table with and without default route; ping success/failure; command auto-detection; device-kind inference from labels; fault engine invents nothing with zero evidence; admin-down detected with high confidence; missing default route detected; not flagged when a default exists; one next action; debug checklist; ARP simulation walkthrough; **no cause claimed when the reason is invisible**; visible reason quoted; empty simulation handled; PDU type detection |
| `tests/unit/agent-core.test.ts` | 26 | Permissions closed by default; observe needs grant; guide needs VISUAL_GUIDE; act needs APPROVED_ACTION **and** grant; revoke immediate; grants persist; proactive never fires in graded/formal; cooldown; OFF mode; weak relevance rejected; context labelled facts; non-approved windows excluded and reported; absent topology stated as absent; selected answer ≠ correct; fact caps; task executes; retry with backoff; no-handler task does not spin; batch cap; orphan recovery; honest status; perception dedupe window; changed content is a new event; stable image fingerprint; resume silent with no history; resume from stored records; due reviews only when real |
| `tests/unit/voice-engine.test.ts` | 22 | IP read octet-by-octet; CIDR `snedstreck`; MAC colon + Cisco dotted; interface spelling; acronyms per language; prose untouched; no double spaces; chunking; **voice off by default**; blocked without enable; blocked without request; allowed only with both; cloud reported unconfigured without a key; native unavailable off-Windows; no provider when choosing none; fallback named explicitly; error surfaced with status; preprocessed text (not raw) sent to the provider |
| `tests/unit/overlay-and-mascot.test.tsx` | 25 | Display containing a point (incl. negative origins); straddle clipping; physical↔DIP round-trip on a 1.5× display; browser-zoom mapping; target accepted when stable; stale rejected; moved rejected; vanished rejected; changed element rejected; distance; tooltip below/flip-above/clamped; one active guided step; interactive hit-test; reading-area overlap; rect expansion; expression for every state; speaking can't be interrupted by thinking; transient expiry; forced change; signal mapping; celebrating > speaking |
| `tests/unit/bridge-and-windows.test.ts` | 25 | Constant-time token acceptance/rejection; fail-closed with no configured token; token uniqueness; unknown message type rejected (allow-list); malformed/oversized rejected; allowed types preserved; NetAcad/Cisco allow-list incl. **lookalike domain rejection**; http rejected; heading path capped; empty selection rejected; selection truncated; context isolation + sandbox + no node integration; transparent frameless always-on-top; overlay non-focusable; docking bottom-right; saved position restored; off-screen clamped; negative-origin clamp; click-through outside regions |
| `tests/unit/desktop-adapter.test.ts` | 15 | Non-Windows reported unavailable; missing CLI reported; version reported; enumeration failure returns empty + error; window JSON parsed and classified (NetAcad / Packet Tracer / other); snapshot accessible only with elements; unparsable snapshot honest; stale ref revalidation |
| `tests/unit/chat-ui.test.ts` | 17 | Bubble placed on the side with room; avoids reading area; warns when it must cover text; clamped at screen edge; stable side (no flicker); negative-origin display; growth with content and height cap; wider for code; click-through regions; no bubble → only mascot interactive; clamp margin; code/prose splitting; empty message preserved; theme resolution; CSS variables emitted for every token; light/dark text differ |
| `tests/integration/chat-flow.test.ts` | 11 | No provider → refuses with a reason and **zero HTTP calls**; data-sharing permission required; answer persisted with both messages and **only exposure recorded**; selected text reaches the model; graded quiz injects a "do not answer" instruction; provider failure reported honestly; state survives restart; diagnostics; insecure URL rejected; **API key absent from the database**; daily budget enforced across turns |
| `tests/integration/any-subject-memory.test.ts` | 13 | Topic extraction is deterministic and subject-agnostic (Swedish/English stopwords, plural+definite stemming); a Canvas **biology** course is discovered, its topics registered, and the prompt contains the real page and **no** Cisco/DVA120 text; platform completion stays an honest 2-of-5 and never becomes mastery; the second request contains the previous question *and* previous answer; an empty profile is described as "no knowledge registered yet" and a real evidence row then appears in the prompt; the current question is sent exactly once; history budgets drop the oldest turns and disclose the drop |
| `tests/integration/learning-loop.test.ts` | 10 | Curriculum discovered → stored → reloaded with real counts; different courses give different counts; current node located and grounded context built; observed practice answer becomes evidence **only after** the platform confirms; reading exposure ≠ demonstrated knowledge; mistakes steer the next question; prerequisite gap diagnosed; review scheduled and surfaced; everything needed to resume persists; platform completion never equals mastery |

### Readiness, real CLI runs

Empty profile — the honest case:

```
Tentaberedskap
  Kan inte mätas ännu. Ingen kunskap är registrerad.
  Säkerhet på underlaget: ingen
  · Ingen kunskap är registrerad ännu, så siffran säger inget om dig.
  · Kursstrukturen är inte läst ännu, så täckningen mäts mot begreppen vi följer i stället för mot kursen.
```

After recording real evidence (5 concepts × 3 independent correct answers, one
hinted, one wrong, one reading exposure):

```
  Grunden börjar sitta (38/100). Fortsätt med de svagaste begreppen.
  Täckning    40 / 100  (vikt 40)  8 begrepp har spår av arbete.
  Kunskap     19 / 100  (vikt 40)  7 begrepp har svar bakom sig, viktade efter oberoende och säkerhet.
  Retention   71 / 100  (vikt 20)  2 av 8 schemalagda repetitioner är försenade.
  Säkerhet på underlaget: god
  · 2 begrepp är dags att repetera och drar ner siffran tills du gör det.
```

The number moved from "cannot be measured" to `38` **only** because answers were
recorded — and it carries its own arithmetic on screen.

## 2. Lint

```bash
npm run lint
```

Result: **0 errors, 0 warnings** (ESLint 9 flat config + typescript-eslint, over all
packages, the Electron main process, the renderer and the tests).

The first run found 8 real problems, all fixed rather than suppressed:

| Finding | Fix |
| --- | --- |
| `App.tsx` kept capability state only to pass a stale type | typed as `ModelCapabilities` |
| `theme` was computed and never passed to either panel | passed to `ChatBubble` and `SettingsPanel` |
| A `react-hooks/exhaustive-deps` disable for a rule that is not installed | removed (dead directive) |
| `validateResponse(…, opts)` accepted an argument it never read | signature trimmed |
| CLI used `require('node:child_process')` mid-function | static import |
| Unused `uid` prop on the mascot `Eye` | removed from signature and both call sites |
| Unused `ProviderError` import in a test | removed |
| `let state` that is never reassigned in a test | `const` |

## 3. Typecheck

```bash
npm run typecheck
```

Result: **0 errors** (strict mode, `noUncheckedIndexedAccess`, across all packages,
the Electron main process and the renderer).

## 4. Builds

```bash
npx vite build --config apps/desktop/vite.config.ts
```

```
dist/renderer/index.html                  0.91 kB │ gzip:   0.51 kB
dist/renderer/assets/index-D4mSU-LF.js  327.75 kB │ gzip:  96.22 kB
✓ built in 1.57s
```

```bash
node apps/desktop/scripts/build-electron.mjs
```

```
apps/desktop/dist/electron/main.cjs     267.8kb
apps/desktop/dist/electron/preload.cjs  125.9kb
electron bundle: ok
```

## 5. Electron main-process boot smoke test

The bundled `main.cjs` was loaded under a stubbed `electron` module (a real
`BrowserWindow` cannot be created without a display server). This exercises the
real startup path: services construction, database creation, migration, window
construction and IPC registration.

```
[bridge] Brygga lyssnar på ws://127.0.0.1:8765 (endast denna dator).
IPC handlers registered: 39
bridge handlers: bridge:status, bridge:rotate-token, bridge:sites-get, bridge:sites-add, bridge:sites-remove, bridge:page-graph
db file created: true
```

This proves module resolution inside the bundle, database creation on first run,
that every IPC channel is registered, and that the extension bridge actually binds
a loopback port. It does **not** prove rendering.

## 6. Bridge round trip, real app instance

The bundled `main.cjs` was booted (stubbed Electron shell), then driven exactly as
the settings panel and the extension would drive it:

```
allowed sites after add: ["canvas.instructure.com"]
browser.read granted: true
welcome carries allow-list: ["canvas.instructure.com"]
[bridge] https://canvas.instructure.com/courses/42/pages/meiosis -> 6 noder, 5 begrepp
curriculum stored from Canvas: 6 noder, "Biologi 1"
dynamic topics registered: Meiosis, Biologi, Cellen, Cellbiologi, Mitos
modules with honest completion: Modul 1: Cellen=1 | Modul 2: Mitos=1 | Modul 3: Meiosis=okänd
```

Read back from the SQLite file, not from in-memory state. Two things this proves
that unit tests cannot: the IPC handlers and the socket agree with each other, and
what the student sees in the app comes from the same database the CLI reads.

Before any site is allowed, the same socket flow answers:

```
messages from app: welcome, rejected
page rejected while no site allowed: true
```

## 7. CLI runs (real, against a real database)

`STUDDY_DATA_DIR=/tmp/studdy-cli4 npx tsx packages/cli/src/bin.ts doctor`

```
Studdy Buddy – doktor
  OK       Node-version           v22.22.3 (kräver >= 22.5 för node:sqlite)
  OK       Databas                19 tables, schema v4 (/tmp/studdy-cli4/studdy.db)
  OK       Schemaversion          aktuell 4, förväntad 4
  WARN     AI-provider            Ingen provider konfigurerad. Lägg till en i appens inställningar.
  BLOCKED  Desktop-observation    Kräver Windows UI Automation. Nuvarande plattform: linux.
  BLOCKED  Packet Tracer          Packet Tracer kräver Windows. Kan inte testas här.
  BLOCKED  Röst                   Windows SAPI krävs för offline-röst.
  OK       Lärandemotor           20 begrepp i kunskapsgrafen

  4 OK · 1 varning · 0 fel · 3 blockerade
  Datakatalog: /tmp/studdy-cli4
  Schema: v4
```

`status`:

```
  Session:      ingen
  Senaste nod:  –
  Meddelanden:  0
  Kurs:         ingen discovery gjord
  Begrepp:      0 spårade, 0 behärskade
  Repetition:   inget förfallet
  Uppgifter:    {"PENDING":0,"RUNNING":0,"DONE":0,"FAILED":0}
  Idag:         0 anrop, 0.0000 USD
```

`voice-test` (pronunciation transform, real output):

```
  BLOCKED  Windows röster (SAPI)     Kräver Windows.
  BLOCKED  OpenAI-kompatibel TTS     Ingen API-nyckel angiven.
  BLOCKED  ElevenLabs                Kräver API-nyckel och voice-id.

Uttalstest
  Adressen ett nio två punkt ett sex åtta punkt ett punkt ett snedstreck 24 har
  mack noll noll bindestreck ett a bindestreck två be bindestreck tre se bindestreck
  fyra de bindestreck fem e på ge i noll snedstreck ett.
```

(`mack` for MAC, `bindestreck` for the separators, `ge i noll snedstreck ett` for
`Gi0/1` — the pronunciation layer is doing its job.)

## 8. Packaging

```bash
npm run package:win
```

Development loop (same three build steps, then launches Electron):

```bash
node apps/desktop/scripts/dev.mjs          # build + launch
node apps/desktop/scripts/dev.mjs --watch  # rebuild the renderer on change
```

On this machine it reports the honest blocker and exits 0:

```
BLOCKED: the Electron binary is not installed.
  Reason: node_modules/electron/dist is missing (installed with ELECTRON_SKIP_BINARY_DOWNLOAD=1,
          or the download step has not run).
  Fix:    npx electron-download-install   (or reinstall electron without the skip flag)
  Built:  apps/desktop/dist/renderer + apps/desktop/dist/electron/*.cjs
```

Result on Linux: renderer + electron bundles built, runtime manifest written, and
the script exited with an explicit message that **the Windows installer was not
created** because electron-builder's NSIS target needs Windows or Wine. No
installer artefact exists. The GitHub Actions workflow has a `windows-latest`
job that produces it.

---

## Not tested (and why)

| Test from the brief | Outcome | Reason |
| --- | --- | --- |
| Buddy launches on Windows 11 | **NOT RUN** | No Windows environment. |
| Monkey animates / always-on-top / drag / transparent / multi-monitor | **NOT RUN** | No display server. State machine and geometry are unit tested. |
| DeepSeek provider connects, streams, vision | **NOT RUN** | No API key. Covered by a fake transport instead. |
| Any course site (Canvas/NetAcad/Moodle) with the real extension | **NOT RUN** | No browser in this environment. The *server* side of the protocol is verified over a real socket; the *DOM readers* are unverified. |
| Packet Tracer detection, capture, CLI interpretation, ping investigation | **NOT RUN** | Packet Tracer not installed. CLI parsers tested from fixtures. |
| Screen highlighting on a real screen | **NOT RUN** | No display. |
| Voice playback, Swedish pronunciation, stop | **NOT RUN** | No Windows SAPI. Text transform verified. |
| Windows installer generated and installed | **NOT RUN** | Blocked as described above. |

These are marked BLOCKED/NOT RUN rather than passed. See BUILD_STATUS.md.
