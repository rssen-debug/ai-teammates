# Changelog

## 2026-10-21 — v1.0.2 — Reliable checkpoint resume

**Fixat:** En återupptagen GRAND ARCHITECT-mission kan inte längre återanvända en gammal VERIFIED-stämpel för en borttagen/ändrad fil. Tidigare checkpoints valideras mot färska kontrakt och, där filhash finns, mot tidigare hash. Node-ID får inte längre av misstag återanvända en annan instruktion eller beroendegraf.

**Säkerhet:** Om en checkpoint avser en åtgärd vars utfall inte säkert kan kontrolleras utan att köra åtgärden igen, blockeras automatiskt återförsök med `REQUIRES_REVIEW`. Riskfyllda åtgärder spelas inte upp blint.

**CI:** Den riktiga Qwen-gatens externa `ollama pull` får högst tre försök vid temporärt 503-fel. Tre misslyckade hämtningar = röda CI-resultat; inga falska PASS.

**Verifiering:** PR #211:s åtta kontroller gröna, inklusive Windows installer och real cloud Go. v1.0.2 behöver **egna** gröna PR-/main-gates och en publicerad release med fyra korrekta assets. Windows self-hosted runner har separat testat MAJIN-kontrollverktyg mot en isolerad syntetisk GUI-window och W12 pink-overlay pixels. Detta ersätter **inte** ett verifierat generellt autonomt GUI-uppdrag med molnmodell, och garanterar inte samtliga användarmiljöer.


Date headers, newest first. Under each date: **Ändrat** (what changed), **Fixat** (what was
broken), **Verifierat** (the exact command and its result). Verified means the Linux sandbox +
GitHub Actions CI unless stated otherwise; nothing here claims a browser or human Windows click
without saying so explicitly. Version tags map 1:1 to git tags.













## 2026-10-20 — REAL-WORLD REPAIRS (Fas 1, independent QA audit 16/34 → repair loop)

**Arenas oberoende real-world-audit (34 scenarier mot installerad v1.0.0 på windows-latest)
mätte ärligt: 16 VERIFIED / 17 FAILED / 1 honest-skip. Reparationer (alla lokalt gröna,
554/537/0, och med branch-build QA-lane på win-qa-realworld mot installerad binär):**

- **R1 (d04/s18/b01)** required-derivation deklarativ & paket-säker: `run.toString()`
  överlevde inte bundling — installerad exe rapporterade fel scheman (`shell.run→[]`,
  `fs.write→append`, `browser.open→headless`). Markörer på ~143 parametrar + kontrakttest.
- **R4-a (s16)** user-raden journaleras omedelbart vid turn-start.
- **R4-b (s23)** memory-recall delar på icke-alfanumerik — IFACT-kodord (IRONWOOD-799)
  träffar även single-token-frågor (smoke-mätt).
- **R5 (s25)** `sys.info` statiskt `os.freemem()` — dynamic import kraschade paketerad
  exe (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`).
- **R2 (s08)** lokal provider + timeout ⇒ `kind:'slow'` ärligt meddelande; 600 s
  lokal-timeout-lane (gateways 180 s kvar).
- **u03** slutförd stream med TOM body = ärlig felbubbla — aldrig tyst bortplockad spinner.
- **Control SHIPPED (användardirektiv)**: `control.list_windows/read/type/click_button`
  i produktbältet — Win32-SendMessage-lane (enda uppmätt överlevande lane på
  windows-2025-runnern; UIA & SendKeys mätt döda 2×). `type` verifieras via
  obligatorisk WM_GETTEXT-återläsning; exec-gated; ärlig vägran utanför Windows.
  CI-scenario c03 kör Notepad byte-exakt via det installerade bältet.
- **s04 omdesignad**: mäter äkta gränsen — spoofad Host vägras även från loopback.
- **QA-lane**: `source=branch-build` bygger+installerar FRÅN refen (reparationsslinga);
  `published`=sanningsspar. Ordningsfix build-exe före setup (run 39421716141).

## 2026-10-20 — v1.0.0 — RELEASE CANDIDATE: 99/100 matrix, full evidence wave

**First release-candidate.** Same-day evidence wave closed every machine-earnable row of the
acceptance matrix (99/100, five-way gate consistent):

- **1E** live two-provider handoff opencode→ollama journaled + real completion via complete() on local Ollama.
- **5D** real Windows computer-use: probe v2.6 Run-dialog WM_SETTEXT→WM_GETTEXT round-trip on windows-latest CI.
- **6C** same-task two-model quality/cost matrix (smollm2:135m / qwen3:0.6b) — both correct, $0 measured.
- **8A–8D** real-browser Aurora acceptance (Playwright chromium): model explorer 1200-catalog + exact route-save,
  task cards bound to /api/tasks, sandboxed preview with byte-exact download, reduced-motion, Escape focus-return,
  300-message render 126 ms; static a11y suite test/a11y-static.test.js 9/9; CI-locked by ui-acceptance-browser.yml.
- **11A/11C/12B** Windows acceptance all-green on CI (sha256, silent install, first-run version, update-over-install
  data preservation, mid-task hard-kill + restart recovery).
- **Local E2E**: SIGKILL mid-generation → 0 torn journal lines; handoff checkpoint crash-recovery idempotent.

Only 12C (release walkthrough itself) remains, closed after the tagged build re-passes every gate.

## 2026-10-20 — WAVE 12 (§3): bench usage arms — per-scenario requests/tokens/cost — v0.9.20

### Added
- **Usage arms in `scripts/bench.mjs`** — every scenario now measures its model spend through
  the real `rt.usage.summary()` ledger (delta around the run): `requests`, `tokens`, `costUsd`
  per scenario row, shown in the table (`req`/`tok` columns) and the JSON verdict.
- **Ledger conservation as a gate** — the per-scenario deltas must sum EXACTLY to the global
  usage summary (requests AND tokens), or the bench verdict fails. Double-counting and leaks
  now break the bench, not just prod.
- **Free-by-design check per arm** — every scenario asserts `costUsd === 0`; a mock arm that
  spends money is a contradiction, now immediately visible.
- **Codified self-config truth** — `maxRequests: 1`. Measured today: 1 intent-parse request /
  ~1,105 tokens (the no-model-call aspiration remains a DEFERRED candidate, now data-backed);
  the bench fails loudly if usage ever climbs past the budget.

### Measured (mock arm, 2026-10-20)
- Per-scenario: fs.write 3req/3,044tok · fs.read 3/3,103 · re.analyze 3/4,115 · shell.run
  3/3,124 · multi-step 5/5,640 · self-config 1/1,105 · guard-approval 4/4,802 — sum 22/24,933
  == global totals (conservation OK), $0 everywhere.

### Verified
`test/w12-bench-usage-arms.test.js` (6): visibility, conservation, free-arm, self-config
budget, multi-step visibility. Full suite **541 / 524 / 0 / 17**.


## 2026-10-20 — WAVE 11: bidirectional cap tuning, every decision logged with why + per-input evidence — v0.9.19

### Changed (user directive)
- **`runSwarm` adaptive concurrency is now two-directional.** DOWN (contraction, existing):
  proven overrun ≥ factor freezes the cap at measured width. NEW **UP (recovery)**: after a
  freeze, proven within-estimate completions (cumulative ratio ≤ 1.25) reopen **exactly one
  lane per decision tick**, never past the declared `cap` — the orchestrator may tune up/down,
  but only on measured evidence, never on hope.
- **Every decision is logged with WHY, the new cap, and per-input evidence.** Each
  `topology_adapt` event now carries a human-readable `why` (measured ratio, factor, sample
  count, annotated-est/actual sums), `capBefore`/`capNow`, `evidence {samples, estSumMs,
  actSumMs, worstInputs}` and `perInput` (worst-ratio inputs, sorted desc, top 3) — "how
  capped per input" is data, not prose.
- **Flood-honesty bound** (`maxAdaptations`, default 50, configurable): decision floods mute
  adaptive control — and the mute itself is logged exactly once (`adaptive_flood_mute`), so
  silence can never hide oscillation. Task results are never eaten by muting.
- Direction discipline: overruns always `capNow < capBefore`; recoveries always
  `+1 ≤ capN`. Un-annotated grids never adapt (unchanged legacy rule).

### Fixed during the wave (design lesson, recorded)
- First T2/T4 scenario builds let fast within-estimate tasks complete BEFORE the overrun wave,
  masking the cumulative ratio — the freeze they were testing never fired. Redesigned with
  dependency waves (goods gated on the bad wave) so causality is explicit. Rule: when a test
  observes an adaptation, the scenario must PROVE the precondition happened first.

### Verified
- `test/w11-cap-tuning-log.test.js` — 5 tests: enriched overrun event shape, recovery (+1
  lane, ≤cap, logged, only-on-proof), quiet/un-annotated silence, bounded flood mute,
  direction discipline. Full suite: **534 / 517 / 0 / 17**.

### Fixed during PR review (CI evidence)
- **package-lock.json shipped CORRUPT (zero package entries)** — `npm ci` died in the check
  job. Lock restored from the last healthy commit (`3c422dd`, 294 entries) and re-bumped
  JSON-aware (root + packages[""] only — the naive full-text replace that preceded it is now
  a banned pattern for structured files). **release-gate hardened**: `package-lock.json
  structure` (entry count) is now part of the version-literals check, and a w6 sabotage test
  proves an empty lock blocks the gate. Rule added to knownFailures: never text-replace into
  package-lock; always JSON-aware edit + structure assert after any bump.


## 2026-10-20 — WAVE 10: skill visit telemetry — a per-skill counter the agent can see — v0.9.18

### Added (user directive)
- **Per-skill visit counter (`Skills.hit`)** — a visit is counted ONLY at the moment a skill is
  actually presented to the model: (a) injected into the system prompt (ambient channel), or
  (b) returned by a deliberate `majin.skill action=match` lookup. Never speculatively —
  pruned and disabled skills receive no visits, a zero-match lookup counts nothing. Disk-backed
  (`uses` + ISO `lastUsed` in the skill frontmatter, atomic writes, slug-deduped): two agent
  processes count one truth, a crash cannot inflate it.
- **Agent-visible counter in the prompt** — each skill line now carries
  `[visited ×N · streak S]` (streak decoration only when a streak exists). The model can reason
  about which skills it has actually been shown before, not guess.
- **K2-consistent ledger** — a content edit preserves `uses`/`lastUsed` (added to the
  accountability carry-over list): an edit never launders the visit history either.
- `list()` surfaces `uses` for UI/CLI consumers.

### Verified
- `test/w10-skill-visits.test.js` — 7 tests: disk persistence + atomicity + lastUsed,
  shown-counted/pruned-not counting, prompt counter + increment + streak decoration,
  match-lookup counting (misses count nothing), edit preservation, disabled never visited,
  list() surfacing. All skill suites 25/25 together; full suite **529 / 512 / 0 / 17**.


## 2026-10-20 — WAVE 9: cross-platform path hygiene closed + guard test — v0.9.17

### Fixed
- **`scripts/bump-version.mjs` self-run gate** — last remaining `new URL(import.meta.url).pathname`
  compare (false on Windows drive letters AND quietly %-encoded) replaced with the canonical
  `path.resolve(fileURLToPath(import.meta.url))` pattern. Tree-wide audit: this was the final
  offender after WAVE 8 fixed `offline-swarm-bench.mjs` + `i18n-check.mjs`.

### Added
- **`test/w9-xplatform-path.test.js`** (5 tests) — the trap class is now a permanent CI failure:
  banned-pattern scans across `scripts/` + `src/core/` + `src/tools/`, canary that all six
  self-run CLIs carry a Windows-safe gate, bump-version import-safety, and a guard-sanity check
  (the scan corpus must stay non-trivial — an empty tree cannot fake green).

### Verified
WAVE-9 5/5; full suite below in PR evidence; release-gate local checks GREEN.


## 2026-10-20 — WAVE 8 (§3): swarm-vs-baseline benchmark, offline + CI-reproducible — v0.9.16

### Added
- **`scripts/offline-swarm-bench.mjs`** — the deterministic twin of the live 3E bench: both arms
  run through the SAME `runSwarm` executor, serial (cap=1) = the equivalent single-agent
  baseline, parallel (cap=N) = MAJIN's parallel path, with seeded artificial latency
  (mulberry32) so jitter is part of the evidence, not an alibi. Interleaved S/P replicates
  cancel order effects. Reports median speedup, per-rep overlap-pair counts, logical result
  parity, failures, and a dependency-chain integrity scenario (3 deep, cap=3) where beating
  the critical path would prove dependency violation.
- **`test/w8-swarm-baseline.test.js`** — 7 tests: ≥2.5× parallel speedup floor (measured
  ~6.5×), overlap 0-vs-maximal, payload parity, chain deps respected + makespan ≥ 85% of
  critical path, seed reproducibility, CLI evidence + BENCHMARKS.md marker refresh,
  render/refresh round-trip with no marker loss.
- **`docs/evidence/swarm-baseline-2026-10-20.json`** + `SWARM-BASELINE:BEGIN/END` section in
  `BENCHMARKS.md` — auto-refreshed by the CLI, hand-edit guarded.

### Measured (offline, executor-level)
- fan=8, reps=3, taskMs=60±15: serial 472 ms vs parallel 72 ms → **6.56× median speedup**
  (theoretical max 6.25× at perfect packing), overlap 0/0/0 vs 28/28/28 (= C(8,2) full),
  parity OK, 0 failures; chain 193 ms vs critical path 192 ms, deps respected.
- Scope honesty: this measures executor parallelism. Model quality/cost evidence remains in
  `scripts/live-bench.mjs` (live 3E: 4.29× median).

### Verified
Full local suite: **517 tests, 500 pass, 0 fail, 17 skip**.

### Fixed during PR review (CI evidence)
- **Windows `isCli` trap, self-caught:** `import.meta.url === 'file://'+argv[1]` is false on
  Windows (`file:///D:/…`) — the bench CLI silently ran nothing and B6 failed on the exe job
  while Ubuntu stayed green. Fixed with the `fileURLToPath` compare (set-icon.mjs pattern);
  the same latent trap in `scripts/i18n-check.mjs` (pre-existing) fixed identically. Lesson:
  a CLI's self-test MUST assert non-empty output — the regex on empty stdout caught what a
  bare exit-0 check never would.


## 2026-10-20 — WAVE 7: radar closure — skill outcome telemetry routes, truncation tells the truth — v0.9.15

### Changed
- **`Skills.match()` = outcome-aware (radar #3 → ADOPT).** Token relevance still dominates
  (score × 10); outcome history is a small visible reputation: streak ≥ 3 → +2, fails ≥ 1 → −1.
  `boost` and `rank` are exposed on every result, ties break by name (deterministic). A failing
  skill with the better keyword fit still wins — evidence beats enthusiasm, never overrides
  competence. Disk state is the source, so two agents rank identically (Del 7C preserved).
- **`Skills.prompt()` no longer truncates silently (radar #5 → ADOPT).** Past `maxInPrompt`,
  the prompt itself says "(N more learned skills not shown…)" and the log channel carries
  `skill.pruned {shown, eligible, max, hidden}` (same convention as `skill.outcome`) — the UI
  can surface "N hidden" instead of the catalog pretending to be complete. Disabled skills are
  excluded from the eligible count.

### Decided
- **Radar #2 (canonical tool-count) → DEFER.** Five suites red-lighting on a new tool IS the
  review gate the master directive wants; single-sourcing the literal would dismantle it.
  Revisit only if the owner prefers a canonical count over forced review.

### Verified
- `test/w7-skill-telemetry.test.js` — 7 tests: streak-promotion, fail-demotion, token-dominance
  over reputation, determinism, pruned-event payload + prompt text, silence at/below max,
  disabled excluded from eligible. Full suite **510 / 493 / 0 / 17**; P5/skill-failure suites
  unaffected (11/11).


## 2026-10-20 — WAVE 6: §12 machinery — matrix-integrity CI gate + executable release gate — v0.9.14

### Added
- **`scripts/matrix-check.mjs`** — shared parser: all FIVE representations of the earned total
  (header, phase-table sum, TOTAL row, DEL-header sum, PASS-row point sum) must agree; PASS rows
  need evidence cells; max-total drift checked separately. One parser, one verdict — imported by
  BOTH the CI test and the release gate so the two can never fork the truth.
- **`test/w6-matrix-integrity.test.js`** (6 tests) — the 2026-10-19/20 drift classes are now CI
  failures: stale TOTAL row, never-totaled PASS row, header inflation, evidence-less PASS,
  max-drift — each proven with a surgical fixture, not asserted in prose.
- **`scripts/release-gate.mjs`** — the executable half of §12 RELEASE_READY: version-literal
  containment across 6 files, matrix integrity, DEV_CONTINUATION checkpoint ancestor-of-HEAD,
  secret hygiene (real key shapes only: `oc_sk_<8+hex>`, `ghp_<25+>`, documented dummys excluded);
  `--online` adds live release-asset count + sha256 hash-match for the current tag; `--json` for
  automation. Exits 1 on any failure — it verifies, never manufactures readiness.
- **`test/w6-release-gate.test.js`** (4 tests) — gate green on the real repo; JSON parseable;
  sabotage-proven: a deliberately drifted matrix and a planted opencode-shaped key each BLOCK,
  restore recovers; the repo's own `oc_sk_dummy-not-real` fixture is NOT a false positive.

### Verified
- WAVE-6 suite 10/10; gate `--online` live: v0.9.13 4 assets, both exe sha256-match.
- Full local suite: **503 tests, 486 pass, 0 fail, 17 skip**.


## 2026-10-20 — Acceptance-matrix reconciliation + 12A live re-verification (documentation wave, no version change)

### Fixed (honesty of record-keeping, found by the §12 walk-through)
- **COMPLETION_MATRIX summaries had drifted from their own rows** (rule in the file: phase-totals =
  row-sum): TOTAL row still said 59 (pre-v0.9.x), phase 12 said 0 while row 12A has been PASS since
  2026-10-19, and five section headers lagged their rows (DEL 1/4/5/10/12). No row contents were
  touched; only the derived numbers were reconciled. **Score stays 81/100** — this wave manufactures
  zero points.
- **Row 12A point now counted**: it was earned 10-19 but never totaled. Re-verified TODAY against
  current main (`24fcd5d`): `MAJIN_LIVE=1 node --test test/acceptance-live.test.js` → **3/3 pass**
  (live create + VERIFIED marker, live edit preserving original, lie-detector naming missing files —
  opencode free tier, 2026-10-20).
- Frontier section rewritten as an honest remaining-points table: all 19 unearned rows need either
  the owner's Windows session (5D, 11A, 11C, 12B → 12C), the other agent's UI merge (8A–8D), or
  additional free provider keys (1E, 6C). 81/100 is today's credential-bounded ceiling.

### Verified
- Phase table earned-sum recomputed by script: exactly 81; header/phase/row-sum all agree.
- Live suite: 3/3 (acceptance-live, MAJIN_LIVE=1). Full offline suite unchanged: 493t / 476p / 0f / 17s.


## 2026-10-20 — WAVE 5: perf lab A/B/C/D (§19) + ranker O(n²)→O(n) — v0.9.13

### Added
- **`scripts/perf-topology-bench.mjs`** — importable harness + CLI: runs the REAL `runSwarm` on synthetic
  DAGs with declared durations (median-of-N, no model calls) across four labs:
  A wide fan-out CP-first vs legacy, B deep-chain CP-first vs declaration-order, C 11× est-overrun
  contraction (reported as a **trade, never a speedup**), D ranker-cost + 200-node pass-through guard.
  CLI writes `docs/evidence/perf-topology-<date>.json` and refreshes the marked PERFLAB section of
  `docs/SWARM_PERFORMANCE.md`.

### Fixed (found BY the lab, this wave — §19 working as intended)
- **`criticalTailRanks` O(n²)→O(n)**: children index built once instead of full-array scan per node.
  D-lab measured 68.57 ms → **6.01 ms on 2 000 nodes (×11.4 measured)**. Production grids (tens of
  nodes) were already fine; the lab exists to catch the scaling edge before it bites.

### Measured results (scale 0.6, median of 5 — evidence JSON in repo)
- A fan-out: **×1.002** (parity — work-conserving dispatch fills lanes regardless of order)
- B deep chain: **×1.003** (parity — no regression; CP-first's value is insurance on steeper graphs)
- C overrun: adaptive 199 ms with 1 contraction vs legacy 133 ms — the honest price of spawn-frugality
  on a broken estimation model, labeled a trade
- D: rank-2000 6.01 ms, grid-200 11 ms

### Verified
- 5 lab tests (structure, direction with wide CI-noise margins, contraction-under-overrun, CLI evidence
  + scorecard refresh). Full local suite: **493 tests, 476 pass, 0 fail, 17 skip**.


## 2026-10-20 — WAVE 4: speculative execution lab (§6 — experimental, disabled by default) — v0.9.12

### Added
- **`src/core/speculate.js` — SpecLab + `speculate()`**: races N pure, side-effect-free speculative
  lanes against the authoritative confirm path. Losers get a real AbortSignal; a per-lane timeout
  caps runaways; deaf lanes that ignore the signal cannot hang the result (grace-window accounting
  flags them `pendingAfterAbort` and bills elapsed-at-abort). Every run emits an audit trail:
  `from`, `winnerMs`, `savedMsEstimate`, `discarded[]`, `wastedMs`, `wallMs`.
- **Honest savings rule**: `savedMsEstimate > 0` only when the confirm path actually SETTLED and
  its real duration is known — the lab understates rather than invents phantom time.
- **Self-limiting waste budget** (`speculation.wasteMsMax`, default 60s lifetime): cumulative
  discarded-lane burn over budget CLOSES the gate; later calls run confirm-only with `gated:true`.
  Speculation never pretends compute is free, and it pays for its own experiment.
- **Default state**: `speculation.enabled` falsy → zero speculation, zero accounting noise.
  No model calls anywhere in the module; production adoption is a separate evidence-gated decision.

### Verified
- 6 deterministic tests (real timers, asserted margins): measured-win savings vs confirm; loser abort
  observed + waste accounted; timeout caps a 5s runaway under 2s wall; deaf-loser grace accounting;
  budget arithmetic closing the gate exactly after the second burn (runs stays 2); disabled-by-default
  zero-effect + empty-speculation pass-through.
- Full local suite: **488 tests, 471 pass, 0 fail, 17 skip** (skips machine-gated).


## 2026-10-20 — WAVE 3: delta memory protocol (§9) — v0.9.11

### Added
- **Memory revisions + append-only delta log** (`memory-state.json` atomic tmp+rename, `memory-deltas.jsonl`):
  every `remember`/`forget` mutation bumps a monotonic rev and records `{rev, ts, kind: add|update|forget, text}`.
  facts.md stays the materialized view — the read path is untouched (zero regression risk by construction).
  `deltaSince(rev)` is order-true and tolerates torn log lines entry-by-entry.
- **No-op write elimination** (the protocol's first measurable win): `remember` of an already-identical fact and
  `forget` with no match no longer rewrite facts.md wholesale — skipped writes are reported (`unchanged: true`)
  instead of silently happening. Old behavior rewrote the full 400-fact file on every call either way.
- **`compactEvents(keep)`**: rotates unbounded `events.jsonl` to a rev-stamped archive (`events.r<rev>.n<total>.jsonl`)
  keeping the newest entries as the active working set. Nothing deleted — archived; totals returned for
  conservation checks.
- **Session injection ledger**: `noteInjected(session)` / `injectedRev(session)` / `staleness(session)` persisted
  in the rev state; `agent.js` stamps the ledger on every memory injection, so "which memory revision has this
  chat actually seen?" is observable evidence, not hope. `stats()` now carries `rev`.

### Verified
- 6 new deterministic tests (`test/w3-delta-memory.test.js`, isolated tmp dirs, real files): rev bump + delta
  kinds; identical-fact no-op (file size + rev + delta log all unchanged); forget only-bumps-on-removal;
  order-true deltaSince surviving a torn line; compactEvents conservation + newest-kept + idempotence;
  ledger persistence across a simulated restart incl. staleness arithmetic.
- Full local suite: **482 tests, 465 pass, 0 fail, 17 skip** (all skips machine-gated).


## 2026-10-20 — WAVE 2: adaptive topology dispatch + critical-path-first scheduling (§5+§8) — v0.9.10

### Added
- **`criticalTailRanks(nodes)` (src/core/swarm.js)** — exported pure ranker: own estMs plus the longest downstream tail. Missing estMs ranks 0 → stable declaration-order ties (GENESIS ZERO: deterministic code decides topology, never a model).
- **§8 runtime critical-path-first dispatch**: `runSwarm` *simulated* CP-first (list-scheduler used rank ordering) but *launched* in declaration order — the model agreed, the runtime did not. Launch ticks now sort the ready set by tail rank; unannotated grids keep identical behavior (pinned by test).
- **§5 adaptive contraction**: measured actuals are compared against the estMs the parallelism plan was built on, at every launch tick. If the ratio reaches `overrunFactor` (default 2×), the scheduler STOPS widening — cap freezes at the width active at proof-time, exactly one `topology_adapt` typed event fires (`reason`, `measuredRatio`, `capBefore`, `capNow`), and the result carries `adaptive: { enabled, overrunFactor, adaptations }` plus a `launchOrder` audit trail. Honest rationale: spawning more lanes on a broken model multiplies the overhead the model already underpriced. `adaptive:false` restores the legacy fixed cap.

### Verified
- 6 new deterministic tests (`test/w2-adaptive.test.js`): CP-first order; stable unannotated ties; contraction + typed event + serialization under frozen cap (real sleeps, timestamp-asserted, not wall-clock hand-waving); `adaptive:false` legacy pin; run-to-run determinism of `launchOrder`; exported ranker math purity.
- Full local suite: **476 tests, 459 pass, 0 fail, 17 skip** (every skip carries a machine-readable gate).


## 2026-10-19 — Windows-control PoC scaffold (handover #4, PoC-before-bind; evidence pending) — v0.9.9

### Added
- **`scripts/win-uia-probe.ps1`** — raw UI Automation probe with ZERO installed dependencies: UIA assembly load + top-level window enumeration (P1), a deliberately impossible window name as negative control (P2), and a controlled Notepad round-trip: launch → locate window → locate Edit/Document control → `ValuePattern.SetValue(marker)` → read back → must round-trip → cleared (P3). Every capability is a measured boolean; gaps are recorded as data (`gapReason`), never smoothed over.
- **`.github/workflows/win-control-poc.yml`** — `workflow_dispatch`-only on `windows-latest` (read-only permissions, 15-min cap, artifact upload of the verdict JSON). Workflow-dispatch requires the file on the default branch — this is why the scaffold lands before evidence; the probe itself gates the BINDING decision, and no dependency is being added.

### Fixed (this wave, found by CI on this branch)
- **Version-fragile update test (pre-existing mine)**: `test/update.test.js` mocked the "new release" as hardcoded `v0.9.9` — any wave bumping the repo *to* 0.9.9 (theirs included) would make current==latest → empty notice → red suite. The mock now derives a strictly-newer version from `src/core/version.js` (`MOCK_LATEST`), so future bumps cannot trip it. Found by honest CI failure, repaired, suite 453/453 again locally.

### Evidence — run 1 collected (workflow_dispatch on main, 2026-10-20)
Artifact `uia-probe-result` (run 39344950257, evid: docs/evidence/uia-probe-run1-v1-2026-10-20.json):
- P1 PASS — raw UIA loads on windows-latest (Server 2025 / NT 10.0.26100), 4 top-level windows enumerated
- P2 PASS — negative control: nonexistent window correctly returns null (no fabricated matches)
- P3 PARTIAL — Notepad window located (class `Notepad`, "Untitled - Notepad"), but modern Win11 Notepad
  exposes NO Edit/Document control under the window → ValuePattern lane had nothing to write to.
  Honest gap; this is exactly what the PoC was ordered to find before binding FlaUI/UFO.
- Probe v2 (same script, schema v2): dumps the Notepad subtree with per-node supported patterns and
  retries text input via (a) any descendant ValuePattern and (b) zero-dependency SendKeys fallback.
  The raw-UIA vs external-binding decision is recorded once run 2 lands.

### Evidence — run 2 collected (probe v2, run 39346426347, evid: docs/evidence/uia-probe-run2-v2-2026-10-20.json)
- The mystery resolved ONE layer down: Notepad's classic children DO enumerate —
  `Edit` (the text surface) + `msctls_statusbar32` — but BOTH report `ControlType.Pane`
  with **zero supported patterns**, and the SendKeys lane found no TextPattern reader
  to verify against. Pattern-free `Edit` + dead input injection is the signature of
  **Session 0**: GitHub hosted runners execute as a non-interactive service, where the
  UIA/MSAA bridge cannot project control patterns and the desktop accepts no input.
- Consequence (already certain): FlaUI would see the SAME pattern-free tree (it wraps
  this exact bridge) and vision-based agents (UFO/OmniParser) the same dead desktop —
  so no external library can fix a CI-runner limitation. The binding question is now an
  environment question.
- Probe v2.1 measures session identity (userInteractive, sessionId, userName) to close
  the Session-0 hypothesis with data instead of inference; final decision recorded after run 3.

### Evidence — run 3 collected (probe v2.1, run 39347315232, evid: docs/evidence/uia-probe-run3-v21-2026-10-20.json)
- Session-0 hypothesis MEASURED and REFUTED: userInteractive=true, sessionId=2, user runneradmin.
  The zero-pattern tree is NOT session isolation. What remains certain across 3 runs:
  P1 window enumeration + P2 negative control PASS every time; Notepad tree reachable;
  no Value-/TextPattern channel materializes on the hosted-runner image, so runner-CI
  text-I/O stays honestly UNPROVEN (not failed-in-principle — unverifiable there).

### FINAL DECISION (bound to 3 artifacts — evidence, not optimism)
- **ADOPT raw UIA as the Windows-control adapter API** (zero installs, free-only, proven:
  window identification + control discovery). No external bind today.
- **Two-tier text I/O**: ValuePattern/TextPattern wherever exposed; SendInput-family
  injection as fallback lane, with read-back verification required per action.
- **DEFER FlaUI** — a C# wrapper over the identical UIA/MSAA bridge; it adds a .NET
  dependency and cannot repair anything we measured (same tree, same zero patterns).
- **DEFER UFO/OmniParser (vision lane)** — different modality (pixels + injection +
  model calls), real cost; OmniParser license caution from the handover STANDS.
  Revisit only if a free vision model passes an injection-verification demo on a real
  interactive desktop.
- **Owner acceptance gate**: final text-I/O proof must run on a real interactive
  Windows session (owner machine) — the probe is deliberately reusable for exactly
  that (workflow_dispatch + artifact). CI runners cannot bind this claim; three runs
  say so honestly.

### Status — DECIDED. Handover #4 closed at PoC-decision level; owner-run acceptance open.
The probe has NOT yet run on a Windows runner at merge time. The FlaUI-vs-Microsoft-UFO binding decision follows only after the runner JSON exists (recorded as a separate evidence commit into `docs/DEV_CONTINUATION.json` decisions). Zero installs anywhere; no UI files touched.

### Verified
- Local: file scaffolding + workflow yaml shape validated by build-exe CI on this branch (ubuntu suite unchanged).
- Full suite: unchanged by this wave (453 pass / 0 fail / 17 skipped on v0.9.8).
- Release gate: `build-exe` workflow on tag `v0.9.9` (GitHub Actions, Windows NSIS).


## 2026-10-19 — P5: skills with versioning, rollback and surviving accountability (V5 §3) — v0.9.8

### Fixed
- **`Skills.save()` was not atomic and had no history**: every save now (a) archives the previous full file to `.versions/<slug>.v<N>.md`, (b) bumps `version` honestly, (c) writes atomically (tmp+rename — the same standard as config/plan; a crash can no longer tear skill frontmatter), and (d) **carries the fail/streak/disabled accountability** — editing a skill can no longer launder a failing track record (previously the whole frontmatter was rewritten from scratch, silently resetting `fails`).
- **New honest APIs**: `skills.versions(slug)` (archived versions, oldest first) and `skills.rollback(slug, version?)` — restores the archived state atomically and **archives the live state first**, so rollback itself destroys no information; missing archive/version answers `ok:false` never a synthetic restore. Archives capped at the newest 10 per skill.

### Added
- `test/p5-skills-integrity.test.js` K1–K6: version bump + full-content archive; accountability carry-over incl. disabled-through-edit and silent-match exclusion; symmetric rollback + explicit-version restore; honest refusal without an archive; atomic save (no temp litter, exact re-read); 10-version archive cap.

### Verified
- `node --test test/p5-skills-integrity.test.js` → 6/6 pass.
- `node --test test/*.test.js` → **453 pass / 0 fail / 17 skipped** (470 total; v0.9.7: 447/464 → +6, zero regressions).
- Release gate: `build-exe` workflow on tag `v0.9.8` (GitHub Actions, Windows NSIS).


## 2026-10-19 — P4 entry: load-proof measurements + durable spec + count reconciliation — v0.9.7

### Added
- **`docs/RELEASE_MASTER_DIRECTIVE.md`** — the missing durable spec, honestly reconstructed from the owner's GODLIKE V5 message (per §1.4: no unseen specifications claimed preserved; `COMPLETION_MATRIX.md` remains the acceptance matrix of record; requirement families registered with provenance).
- **`test/ratelimit-load.test.js` S9–S12** (load-proof extensions of the S1–S8 simulator):
  - S9: 20-wide burst under `concurrent:2` — hard ceiling held (measured `maxInFlight=2`, wall 1330ms ≥ 20×120ms/2, zero leak).
  - S10: same-tick arrivals admit in priority order: measured `interactive → tasks → background` exactly.
  - S11: reservation lifecycle truth (est → reservation → release → window charges ACTUAL usage 42/8; aborted queued wait = zero reservation, zero window charge, `canceledQueued` recorded).
  - S12: admission overhead as sandbox DATA: pass-through p50 ≈ 0.005ms / p95 ≈ 0.011ms; configured-ample p50 ≈ 0.008ms / p95 ≈ 0.021ms (Linux sandbox, node 20). **These are measurements, not certifications of the handover's UNCERTIFIED target table** — reported as data with environment.

### Fixed
- **Test-count truth item closed**: Linux(460) vs Windows(441) count difference reconciled exactly: their 441 total @ `de3ad45` + 19 tests added by waves P0/P1/P2 = 460. All 17 Linux skips carry machine-readable gate reasons (6×MAJIN_LIVE, 1×jobs-live, 5×browser-live, 4×installer-deps, 1×Windows-updater); on Windows, the P0/P1 permission tests skip instead. No unexplained delta remains — recorded in the checkpoint.

### Verified
- `node --test test/ratelimit-load.test.js` → 4/4 pass.
- `node --test test/*.test.js` → **447 pass / 0 fail / 17 skipped** (464 total; v0.9.6: 443/460 → +4, zero regressions).
- Release gate: `build-exe` workflow on tag `v0.9.7` (GitHub Actions, Windows NSIS).


## 2026-10-19 — P2: honest vision + truthful screen capture (UI-agent handover #3, engine side) — v0.9.6

### Fixed
- **Anthropic vision no longer drops pixels**: the adapter used to flatten every multimodal content array through `textOf()` — OpenAI-format `image_url` parts silently vanished while the model was told an image arrived. `toAnthropic` now maps `image_url` data: URLs to real `{ type:'image', source:{ type:'base64', media_type, data } }` blocks and http(s) URLs to `{ type:'url' }` sources; text parts are preserved; genuinely unhandled parts are dropped **but announced** (`bus: anthropic.parts-dropped`) — never silently.
- **screen.capture region math**: the tool contract says `x,y,width,height`, but the Windows backend fed them straight into `[Rectangle]::FromLTRB(left,top,RIGHT,BOTTOM)` — any region not starting at 0,0 captured the wrong rectangle. `ltrbFromRegion()` now converts honestly; malformed regions return a typed `bad_region` error instead of garbage coordinates.
- **The capture receipt is the BYTES now**: capture lands in a unique temp file (`.cap-<pid>-<ts>.part`), the PNG magic must validate, and only then is it atomically renamed into place. A failed/empty/non-PNG capture reports `invalid_png` (or `no_file`) — the old "stdout said saved / a file exists" receipt could lie. Result meta gains `validatedPng` + `bytes`. PowerShell path escaping hardened (`psQuote` — apostrophes cannot break the command string).

### Added
- Exported, test-covered helpers: `toAnthropic` (provider mapping), `ltrbFromRegion`, `psQuote`, `validatePngBytes`.
- `test/p2-vision-capture.test.js` — V1–V6 (image-block mapping data:/http, announced drops, adapter regressions, region math incl. rejections, PNG-magic validation incl. truncated/garbage, PS-quoting).

### Verified
- `node --test test/p2-vision-capture.test.js` → 6/6 pass.
- `node --test test/*.test.js` → **443 pass / 0 fail / 17 skipped** (460 total; v0.9.5: 437/454 → +6 new, zero regressions).
- Release gate: `build-exe` workflow on tag `v0.9.6` (GitHub Actions, Windows NSIS).


## 2026-10-19 — P1: durable journal, resume and route-switch handoffs (UI-agent handover #2, engine side) — v0.9.5

### Fixed
- **Resume gap closed**: the turn brief now hydrates plans from DISK (`loadPlan`), not only the in-memory map — after a restart the ACTIVE PLAN block returns. The loop's plan context uses the same hydration.
- **`consumeHandoff` consumes exactly once**: an artifact is marked `consumed` (atomic) and never re-injected on later turns — a re-run, retry or restart no longer duplicates context.
- **Turn-level plan honored the session binding**: `plan(cfg, decision, { session })` now routes through the same per-chat table as the loop — the `route` event, MOA routing and served-route tracking describe the model that actually serves the chat (previously the turn plan silently ignored per-chat pins).
- `persistPlan` / `handoff` writes are atomic (tmp→rename) and honestly reported (`lastPlanPersistError`, `lastHandoffError`, bus events `plan.persist_failed` / `handoff.persist_failed`) — a journal hiccup never kills a turn, but it is never silently lost either.

### Added
- **Handoff producer wiring (was dead code)**: a route switch for a session (per-chat binding or global picker) writes a durable handoff checkpoint — goal from the durable history, live plan, from→to — BEFORE the new model starts, injects it into the same turn, and emits a `handoff` event including `persisted` status. The artifact survives restart (restart-resume), and a fresh process consumes it exactly once.
- **Served-route journal**: `.route.json` per session atomically records which route actually served it — switch detection works across process restarts.
- `test/p1-journal-resume.test.js` — R1–R6 (restart plan hydration, same-turn switch handoff, consume-once, pre-crash artifact pickup, honest persist failure, well-formed artifact).

### Verified
- `node --test test/p1-journal-resume.test.js` → 6/6 pass.
- `node --test test/*.test.js` → **437 pass / 0 fail / 17 skipped** (454 total; v0.9.4: 428 pass of 448; +6 new, zero regressions).
- Release gate: `build-exe` workflow on tag `v0.9.5` (GitHub Actions, Windows NSIS).


## 2026-10-19 — P0: honest persistence + per-chat routing (UI-agent handover #1, engine side) — v0.9.4

### Fixed
- `Config.save()` is now atomic (`tmp` write → fsync → rename, rotation into `.bak`) and honestly reported: a failed disk write surfaces as `patch()` → `{ ok:false, persisted:false, errors:[{ code:'save_failed' }] }` — the old silent `ok:true` on a failed save is gone. The previous file on disk stays intact when a write fails.
- `load()` now distinguishes **absent** from **corrupt**: a corrupt main file heals from `.bak` (`cfg.recoveredFrom='bak'`), never gets silently overwritten by defaults, and every anomaly stays visible via `cfg.loadIssues`. (Previously a parse error flipped `fresh=true`, which could auto-save defaults over the user's last working config.)
- `appendHistory()` reports success/failure (`true/false`) and records failures in a bounded `historyErrors` ring instead of swallowing disk errors.

### Added
- **Per-chat model binding (backend)**: `models.sessionRoutes = { <sessionId>: { <job>: "provider/model" } }`; `routeFor(cfg, job, { session })` honors an explicit binding without rewriting the global table, and a missing key on an explicitly bound route surfaces as a real error in that chat (no silent fallback).
- **Turn-pinned routing**: an in-flight turn now keeps the route chosen at its start (`loop` pins per `stepJob`); a provider switch in another chat mid-turn no longer reroutes the running work. Deliberate escalation keeps its own swap.
- `test/p0-save-sessionroute.test.js` — S1–S6 (7 subtests): honest save, atomic+`.bak`, corrupt→heal, no-overwrite-without-backup, session binding global-table isolation, mid-turn re-route prevention, honest history.

### Verified
- `node --test test/p0-save-sessionroute.test.js` → 7/7 pass.
- `node --test test/*.test.js` (rebased onto v0.9.3 main) → **431 pass / 0 fail / 17 skipped** (448 total; de3ad45 alone failed 4 version-literal tests first, fixed by 0.9.4 literal alignment; zero regressions from P0).
- Release gate: `build-exe` workflow on tag `v0.9.4` (GitHub Actions, Windows NSIS).


## 2026-10-19 — Aurora Studio UI/UX — v0.9.0

### Changed
- Refined graphite/pink visual system, static luminous home emblem, compact organic loading states and one aligned conversation/composer column.
- Contextual Workspace: Activity, Files, Preview and Settings. The existing advanced tools remain accessible without turning the chat into a dashboard.
- Interactive task visualization from actual API snapshots, per-task Stop, real file inventory, sandboxed read-only preview, original-file download and resizable preview width.
- Model capability filters (Tools, Vision, 128k+), model detail view, session search, keyboard navigation and narrow-window controls.

### Fixed
- Immediate Escape/open race in the asynchronous model picker; stale loads cannot repaint a dismissed dialog.
- Theme-switch contrast flash; late events changing failed/stopped runs into active/success states; sidebar/composer alignment when contextual panels open.

### Validation
- Windows Edge UI acceptance, 37 focused tests, reduced-motion checks, actual file download/preview and live catalog access. See docs/MAJIN_AURORA_HANDOVER.md for test fixtures, evidence and scope limits.

## 2026-10-19 — Phoenix UI/UX — v0.8.0

### Changed
- Neutral dark surfaces, readable conversation, centered composer, new-chat and model/provider navigation; expert features preserved.
- Live model explorer with provider selection, search, free-price filtering, context/input-price sorting and incremental rendering of the full catalog.
- One recoverable failure card per request, preserved input, accurate failed status, keyboard dismissal/focus and quiet expandable activity.

### Fixed
- Token/version interpolation corrupted JavaScript variable names in the served HTML.
- Undefined MODE_LABEL interrupted header rendering; named SSE events without a JSON type were ignored.
- Error-followed-by-answer events could display false success; routing notices flooded the conversation.
- Unstreamed answers were invisible; automatic activity scrolling interrupted reading.

### Validation
- Windows Edge behavioral UI acceptance; pure catalog tests; syntax/i18n and CLI bundle checks.
- Live OpenRouter catalog: 470 entries, 20 with zero reported catalog charges on 2026-10-19.
- OpenCode inference attempt timed out; no successful live inference claimed. See docs/PHOENIX_HANDOVER.md for limits and release verification.

## 2026-10-19 — GODLIKE V4: intelligent rate-limit orchestrator (§7) — v0.7.2

### Changed
- New `src/core/ratelimit.js`: provider-quota buckets (rpm/tpm/concurrent), token reservations (requests count against quota at reservation time), Retry-After floor, bounded backoff+jitter, prioritized admission queue (interactive > tasks > background, same-tick coalescing), AIMD adaptive concurrency, 6-class error classification, pass-through when no quota is configured.
- `chat.complete` now admits through the orchestrator + reconciles actual usage against reservations + honors Retry-After before retrying.
- `Config.resolveModel` carries the owner-configured `limits[provider]` on the route (no invented limits).
- New reporting dimension docs: `docs/SWARM_PERFORMANCE.md`, `docs/REAL_WORLD_READINESS.md`, `docs/DEV_CONTINUATION.json`; FEATURE_RADAR updated.

### Verified
- Deterministic simulator `test/ratelimit-sim.test.js` 8/8: S1 naive-burst violation vs S2 zero-violation throughput; S3 Retry-After floor; S4 queued-abort (zero unhandledRejection, floating-reject class eliminated in engine); S5 priority; S6 AIMD; S7 classification; S8 pass-through.
- Sabotage discrimination: SA3 (both prio sorts removed) → S5 red; SB (reservations not counted) → S4/S2-class red; SC (Retry-After floor removed) → S3 red. Restored → green.
- Full suite: 404 tests / 388 pass / 0 fail / 16 skipped. Bench unchanged 7/7 (24 399 tokens, $0).
- Version 0.7.2. Implementation completion unchanged 81/100 (this wave strengthens the OMEGA layer; matrix rows untouched by design).

## 2026-10-19 — Del 12A (independent real-model acceptance suite) — 81/100

### Changed
- New `test/acceptance-live.test.js`: three real-model acceptance runs (create, append-via-patch preserving original, engine lie-detector) — the verdict machine is code only. Version 0.7.1.

### Verified
- Suite total: 396 tests / 380 pass / 0 fail / 16 skipped (live-gated files all skip cleanly).
- Live: A1 43 379 tokens, A2 281 891 tokens measured; A3 engine-only exit-7 honesty. **81/100.**


## 2026-10-19 — Del 5A + 5B + 5E (real browser domains) — 80/100

### Changed
- `src/core/browser.js`: browser launch is now bounded-retry (2 attempts, fresh port, longer deadline) — the runner-policy Edge-flake that blocked two CI runs in a row is gone from the engine (error text unchanged, honest).
- `.github/workflows/build-exe.yml`: the browser live-gate now runs `test/browser-domains.live.test.js` alongside browser.live + jobs.live.
- New `test/browser-domains.live.test.js`: 5A forms/select/radio/consent observed AT THE SERVER, 5B hash-nav + target=_blank + iframe-straight-path, 5E multi-step webshop with server-state cross-checks at every step.

### Verified
- exe-CI live round (run 3927xxx…, commit c066a34): **5/5 pass** — 5A posted `{"name":"Siri Testsson","mail":"siri@test.dev","stack":"node","level":"senior","consent":"on"}` + thanks-words; 5B new-tab followed + hash content + frame path; 5E cart `X900×1` + order recorded before any claim.
- Full suite: 380 pass / 0 fail / 13 skipped (live-browser files stay key-gated).
- Retry hardening self-discriminating: attempts=1 → 2/3 red (run 39265517682); attempts=2 retry → 3/3 green.
- Bench unchanged (browser wave, no new spend). **80/100.**


## 2026-10-19 — Del 4D (contract domains: command/json/http) + Del 10E (adversarial regressions) — 74/100

### Changed
- `src/core/mission.js`: `verifyContract` async for real I/O contracts (legacy sync kept as `verifyContractLegacy` documented); three new out-of-the-box domains with NARROW derivation: `command_exits_zero` (two phrasings), `json_topkeys`, `url_contains` — under-deriving is honest, never a false pass.
- Command domain: hard denylist (rm -rf/sudo/curl|sh/mkfs/fs-write/format/cipher/vssadmin) + real child-process exit code as evidence (timeout-controlled).
- JSON domain: real `JSON.parse` + top-level key proof + workspace-sandbox on the target file.
- HTTP domain: real `fetch` (https or localhost-only, size cap + status + needle).
- 10E: `src/core/config.js` hardened against hostile identity keys (`__proto__|constructor|prototype`): merge drops segments, getPath own-prop only, setPath refuses — a REAL config-pollution vector found and fixed.
- `docs/ADVERSARIAL.md`: six classified attack vectors with regression tests.

### Verified
- `test/domains.test.js` 5/5 — all three domains pass/fail/denied + derivation + E2E repair-on-lies. Full suite 390/0.
- `test/domains-live.test.js` 2/2 (MAJIN_LIVE=1, opencode key): real https google.com check + real `node --version` exit + LIVE longcat mission wrote mission-live.json {answer:42, task:…} VERIFIED sha:c181499c — 72 511 tokens measured.
- `test/adversarial-regressions.test.js` 5/5 — path containment map, proto pollution, 4MB-args bound, readOnly bypass, eval-content-as-data. CI stays mock-only (live files skip honestly).
- Sabotage discrimination: T1 universal-pass → 4 reds; T2 fake-exit → 4D.1 red; T3 url-derivation off → 4D.4 red; E1 merge-filter removed → V2 red; all restored green.
- Bench unchanged: 7/7, 24 400 tokens, $0 (före 24 399 — miljödrift ±1). **74/100.**


## 2026-10-19 (night) — v0.6.8 · Del 3E — HYPERSWARM COMPLETE (67 → 69/100)

### Changed
- **3E — REAL parallel-vs-sequential benchmark, live model:** `scripts/live-bench.mjs`,
  N=4 dependency-free briefs through `runSwarm`, interleaved R=3 (S,P,S,P)
  against `opencode/longcat-2.5-preview-free`. Sequential median **47 499 ms**
  vs parallel median **11 065 ms** = **4.29× speedup**; overlap-pairs 0/0/0 vs
  6/6/6 (of max 6). 24/24 calls ok; 6 290 tokens measured by the gateway.
- `test/live-bench.test.js`: deterministic mock path (always on in CI — cap
  mechanics + timestamp-overlap evidence with a 120–160 ms latency ladder) +
  live path gated `MAJIN_LIVE=1` (24 522 ms vs 6 991 ms, tokens 660=660).
  Offline the live test skips honestly (suite 370/0/8, the +1 skip IS the gate).

### Verified
- `node scripts/live-bench.mjs` (opencode key) → table committed in
  `docs/BENCHMARKS.md`; `MAJIN_LIVE=1 node --test test/live-bench.test.js` → 2/2.
- Discrimination: D1 cap forced 1 → RED in BOTH modes (live parallel degraded to
  30 553 ms/overlap 0 — fake concurrency caught); D2 timestamps zeroed → RED.
  Restored green. Version pinned 0.6.8 in all four sites before the final gate.

## 2026-10-19 (night) — v0.6.7 · Del 9D + 10C (Del 9 COMPLETE 5/5)

### Changed
- **9D — creative/productivity workflow evidence:** E2E story brief through the
  live registry (3 chapters + referencing index.json, byte-verified on disk);
  notes.md → brief.json pipeline with preserved source. `test/creative.test.js`.
- **10C — prompt-injection resistance (web/repo/doc):** `src/core/injection.js`
  (11-pattern corpus, zero false positives), wired into the loop's tool-result
  message path: infected results annotated in the message the model reads
  + `injection_warning` events; clean results byte-identical. `test/adversarial.test.js`.

### Verified
- Suite 369/0/7, i18n clean. Bench note: totals read 24399 (`main` worktree
  control identical — environmental drift, branch==main parity exact).
- Discrimination 5 cycles: C1 fs.write no-op, C2 registry args wiped, A1 scan
  off, A2 corpus emptied, A3 detect-without-annotate — all RED → restored GREEN.

## 2026-10-19 (night) — v0.6.6 · Del 7D (Del 7 COMPLETE 8/8)

### Changed
- **7D — adapter execution through the existing engine:** `Adapters.call()`
  re-reads + RE-validates the descriptor per call; read→GET /
  external-write,post→POST; external classes need approved:true AND a live
  `approvals.request` decision (same gate as jobs.send); disk sidecar state
  (rolling-hour rate limit, fail counters, disabled flag); self-disable after
  3 consecutive failures; explicit enable; `mapRows` array enumeration.
  Tool: `majin.adapter` call | enable. `test/adapters-exec.test.js` 5/5.

### Verified
- Suite 364/0/7, i18n clean, bench 7/7 byte-identical 24400 tokens.
- Discrimination 4 cycles: D1 approval skipped, D2 rate off, D3 never-disable,
  D4 re-validation off — all RED → restored GREEN.

## 2026-10-19 (night) — v0.6.5 · Del 7B + 7C (59 → 63/100)

### Changed
- **7B — safe adapters (`src/core/adapters.js`):** declarative http-json
  descriptors only; HARD validation before any disk write (https-or-localhost,
  no javascript:/data: schemes, no raw secrets — {env:NAME} placeholders only,
  kind allowlist, permission classes read | external-write | external-post,
  code-shaped mappings refused, clamped timeout/rate, atomic writes).
  Tool: `majin.adapter` validate | create | list | remove. Registry 103 → 104.
- **7C — skill failure tracking (memory.js):** `recordOutcome()` counted on
  disk state (multi-instance honesty), success resets streak, N=3 consecutive
  failures → DISABLED honestly (never deleted), disabled filtered from
  match()+prompt(), explicit enable. Tool: `majin.skill` report | enable.

### Verified
- Suite 359/0/7, i18n clean, bench byte-identical 24400 tokens.
- Discrimination 5 cycles: S1 disabled-selectable, S2 never-disable, S3
  no-success-reset, S4 skip-validation, S5 allow-remote-http — RED → GREEN.

## 2026-10-19 (late evening) — Del 6A: one budget guard, measured per-task caps, honest unknown prices

### Changed
- **`budgetGate` (exported from `src/core/loop.js`) is the single guard called
  at the only two places the loop can spend**: before a provider call (monthly
  ledger — behaviour unchanged for users) and after every measured step
  (the new per-task cap `budget.perTaskUsd`, default 0 = off). Only REAL
  MEASURED cost trips a task cap: ten million free tokens trip nothing.
- **Unknown price never reads as $0.** `priceKnownForRoute` (pricing.js) marks
  a route priced/local/mock/$0-priced as KNOWN, priceless cloud models as
  UNKNOWN; the loop exposes it as `usage.priceKnown` per turn, and the
  existing ledger's `unpricedCount` keeps a count so a $0 number is never
  presented as a known price.
- **Hard-stop honesty.** A stopped task ends `fatal: true`,
  `errorKind: 'budget'`, `stopReason: 'task-budget'`, and its stop message
  names the cap AND the measured number
  (`This task's budget of $0.5 is spent ($2.3100 measured so far)`).

### Verified
- `node --test test/budget.test.js` → 5/5: synthetic gate matrix (monthly
  over/under, unknown under cap, free routes, track-mode), live loop with a
  deliberately expensive mock route stopped after EXACTLY one counted call,
  same-workload control without cap (both steps complete), unknown-price
  honesty pins.
- **Discrimination:** per-task gate off → t2+t3 red; monthly gate off → t1
  red; price-always-known → t5 red; gate-on-tokens-not-cost → free-tally
  assertion red; sane baseline 5/5.
- Full suite 350/0/7, i18n clean, bench 7/7 with IDENTICAL token spend
  (24400/22 — the guard costs nothing while off).


## 2026-10-19 (evening, part 2) — Del 2C: clarify-before-touch, failure-driven replan, carried objectives

### Changed
- **Ambiguity is answered with a question, not a guessed graph.** The mission
  compiler may answer `{"clarify":"which file do you mean — X or Y?"}`; MAJIN
  returns `kind: clarify` and launches NOTHING — no workers, no side effects,
  the workspace stays byte-identical until the user answers. The rule costs
  ≈1 estimated token per compile call (measured: bench 24399→24400).
- **After repeated identical failure: change strategy, in one bounded step.**
  When repairRounds exhaust with dead contracts, one replan round (config
  `mission.limits.replanRounds`, default 1, clamp 0..2) re-runs the part with
  a different-method prompt, charged to the same budget, re-verified against
  the SAME contracts. Success carries `after replan`; failure carries
  `[LIMIT:REPLAN]`. Previously those missions just failed with `[LIMIT:RETRY]`.
- **Objectives can change mid-mission without losing verified work.** Passing
  `carry: { nodeId: { value, verified, verifiedSummary } }` to `runMission`
  grafts previously verified parts into the new DAG: they are never re-run
  (zero calls, zero repeated side effects) and the summary names the
  provenance: `carried from previous objective`.

### Verified
- `node --test test/mission.test.js` → 20/20. t17: ambiguous goal → question,
  0 worker calls, workspace untouched; t18: lie → repair-lie → replanned
  worker writes the real sentence with a REAL tool call → VERIFIED
  `contains "survival of the fittest", after replan`, disk inspected; t19:
  replanRounds=0 → no strategy change, `[LIMIT:RETRY]`; t20: changed
  objective → 3 calls total (carried p1 costs zero), provenance marker.
- **Discrimination:** clarify ignored → t17 red; replan dead → t13+t18 red;
  carry bypassed → t20 red; knob ignored → t13+t19 red; sane 20/20.
- Full suite 345/0/7, i18n clean, bench 7/7 (t13's expected marker now
  honestly reads LIMIT:REPLAN — repair still bounded first).
- Side effect of honest testing: the verify loop caught OUR test writing
  empty content via fs.write's wrong arg name — the engine works on us too.


## 2026-10-19 (del 2) — Del 3C/3D: bounded transient replacement + adversarial lock proof

### Changed
- **Scheduler owns mission recovery, exactly one accountable layer.** Swarm
  workers now run with `providerRetries:0`/`providerErrorCap:0`: a provider
  flake inside a mission surfaces immediately instead of hiding behind
  chat.complete's silent backoff retries (invisible cost, invisible latency,
  ~1.5 s→0.6 s in tests). The chat/conversation path keeps its defaults.
- **Bounded transient replacement.** `runSwarm(maxAttempts)` (missions: 1 +
  `mission.limits.transientRetries`, clamped): a node that dies transiently is
  re-queued as a NEW attempt with a FRESH subagent session (`:a2`) and a
  `worker_retry(id, attempt, why)` event — safe replacement, no state bleed,
  never a loop. `isTransientFailure` admits only network/rate-limit/5xx shapes;
  permanent failures (safety refusal, bad args, parse errors…) run EXACTLY
  ONCE and block dependents honestly.
- **Mid-run cancel stays honest.** Aborting mid-flight starts nothing new and
  every pending/in-flight node ends `blocked: cancelled` — never ok, never
  timed-out.
- **Adversarial lock proof.** Racing `fs.patch` read-modify-writes by two
  hostile workers (5 rounds, disjoint edits, one file) lose nothing and tear
  no line; ownership timing is asserted deterministically (queue ≥60 ms,
  FIFO, re-entry safe).

### Verified
- swarm 15/15 + mission 16/16 = 31/31; full suite 341/0/7; i18n clean; bench
  7/7 with byte-identical token spend (24399/22 calls).
- **Discrimination:** everything-classified-transient → permanent-failure test
  red; retry branch off → transient tests red; `locked()` bypassed → lost-update
  test red; hidden retries restored → mission observability test red; sane 31/31.


## 2026-10-19 — Del 4C: hard mission limits (retry/budget/timeout) with LIMIT markers

### Changed
- **One limits policy per mission.** `missionLimits(cfg)` reads
  `mission.limits.repairRounds` (default 1, clamped 0..3), `.timeoutMs` (0=off,
  clamped to 1 h) and `.tokenBudget` (0=off) from `config.js` DEFAULTS. The model
  never limits itself; every cap is enforced by code.
- **Token budget is charged against real measured usage.** Every worker call
  (initial + repair) sums provider usage; crossing the cap aborts the swarm
  (AbortController), prevents not-yet-started workers, and marks the run
  `[LIMIT:BUDGET]` in the summary. `subagentWorker` now forwards `usage` so the
  accounting is real, not estimated.
- **Repair loop is bounded by config, capped at 3.** After the configured rounds a
  dead part fails HONESTLY with `[LIMIT:RETRY]` — no infinite repair, no silent
  pass. Mid-loop budget/timeout interrupts stop repairs with their own marker.
- **Wall-clock timeout reaches the swarm.** `runSwarm` gets both the deadline and
  the abort signal; parts blocked by the deadline read `↷ n: blocked — deadline
  [LIMIT:TIMEOUT]`. Return object carries `limits`, `limitsHit`, `usedTokens`.
- **Parser robustness (found by the limit tests):** `file_contains` needle
  detection now accepts "the exact phrase/line/..." wordings, not only
  "the word/text/string".

### Verified
- `node --test test/mission.test.js` → 15/15. t13: 3 scripted lying rounds with
  repairRounds=2 consume exactly 4 worker calls and fail with `[LIMIT:RETRY]`;
  t14: token cap 40 against a ~600-char answer stops worker #2 before it starts,
  `usedTokens > 40` measured from real usage; t15: 120 ms cap cuts a ~1.7 s mock
  stream, wall time < 1500 ms, nothing marked ok after the deadline.
- **Discrimination:** sabotaging the budget gate turns t14 red; unclamping the
  repair-round bound turns t13 red; removing deadline/signal pass-through turns
  t15 (and the budget-abort dependent) red; sane baseline 15/15.
- Full suite 335/0/7, i18n 0 Swedish literals in 90 files, bench 7/7 with
  byte-identical token spend (24399 tokens, 22 calls) — caps cost nothing when
  not triggered.


## 2026-10-18 (evening, part 4) — Del 4A: verification contracts + evidence provenance

### Changed
- **`src/core/mission.js` — contract engine.** A mission part no longer ships on the
  worker's word: `buildContracts` derives typed contracts from the brief and
  `verifyContract` checks each one against REAL evidence, in code, after the run:
  - `file_exists` — stat of the resolved path (workspace-escape guarded), size > 0,
    sha256[:8] fingerprint recorded in the evidence string.
  - `file_contains` — the file must literally contain the quoted needle from the brief
    (`readFileSync.includes`), so "the file says survival of the fittest" is checked
    against CONTENT, not existence.
  - `count` — "report the number of files in <dir>/" is re-counted independently by
    `fs.readdir` and compared against the worker's "N files" claim; a mismatch is a
    dead contract. The verifier never asks a second model whether the number is right.
- **Repair loop speaks contracts.** A part with dead contracts gets one repair round
  whose prompt lists exactly which contracts died; the part only ships when the
  repaired output re-verifies. Parts without contracts keep the old
  "reported, not independently verifiable" treatment.
- **Provenance in the summary.** Verified parts carry
  `[VERIFIED: store/ has 3 files (independently counted), after repair]` — the reader
  sees WHAT was checked (real disk state), not who claimed what. (PR PR #40)

### Verified
- `node --test test/mission.test.js` → 12/12. New: t10 (file_contains lie → dead contract
  → repair re-writes real content → VERIFIED), t11 (count lie "7 files" against a 3-file
  store/ → code recount catches it → repair → VERIFIED `3 files (independently counted)`),
  t12 (honest count verifies with zero repair rounds).
- **Discrimination:** trust-the-claim sabotage on `count` turns ONLY t11 red; a
  rubber-stamped `file_contains` turns ONLY t10 red; sane baseline 12/12.
- Full suite 332/0/7, i18n 3/3, bench 7/7 unchanged (p50 41 ms, p95 4525 ms).
- Master-audit fix: the okCount assertion in t11 verified against an end-to-end debug run
  (`/tmp/dbgctr4.mjs`) before the suite claim was made.


## 2026-10-18 (kväll, del 3) — Del 1D: crash-resume without duplicate side effects

### Ändrat
- **`src/core/effects.js` (new):** per-session side-effect journal (`<sid>.journal.jsonl`),
  `planResume`/`recoverTask` decide in CODE which steps may run after a crash:
  journal + external evidence (sha256 of the file) both must agree; tampered or
  missing evidence lands in `uncertain` and never in blind-retry. Explicit actions:
  resume | retry | cancel | startFresh (journal archived on fresh start).
- **Wired, not dead code:** `fs.write` events now carry their session; the runtime
  journals every write with the real post-write content hash.

### Verifierat
- `node --test test/resume.test.js` → 6/6 (fail-discriminating proven: sabotaging the
  hash compare turns test 3 red; restored = green).
- Suite 329/0/7, i18n 3/3, bench unchanged (7/7, p50 43ms).
- Matrix: 39 → 41/100 (Del 1: 8/10).

## 2026-10-18 (kväll, del 2) — Completion matrix: honest baseline under the 100-point directive

### Ändrat
- **`docs/COMPLETION_MATRIX.md` (new).** All 100 acceptance points evaluated row-by-row strictly
  on evidence (reproduction command per row) against main v0.5.8 `2c5f308`.
  Score: **39/100** — the 61-estimate was informal and is retired per the directive; rows are
  PASS only with reproducible proof, and a regression revokes already-awarded points.

### Verifierat
- Evidence inventory: `ls test/` (47 files); main suite at `2c5f308` = 323 pass / 0 fail / 7 skipped.

## 2026-10-18 (kväll) — Persistent Session & Agent Handoff Engine

### Fixat
- **Context loss mellan meddelanden (huvudbuggen).** `/api/chat` sparade historik till disk men skickade aldrig tillbaka den till modellen —
  varje meddelande började om utan sammanhang. Nu laster `agent._turnOnce` alltid
  `readHistory(session, 240)` från disk när callern inte skickar historik (role user/assistant).
  Testet bevisar att "Mitt namn är Kalle." når modellens meddelandekedja vid nästa anrop.
- **Ingen checkpoint vid modell/agentbyte.** `agent.handoff({session, to})` skriver
  `<session>.handoff.json` (mål = första användarmeddelandet, plan med status per steg,
  sista framsteg, från→till). Nästa tur konsumerar artefakten EN gång och injicerar
  den som "HANDOFF CONTEXT — continue, do NOT restart" i det medvetna blocket.
  Planer persistenz dessutom i `<session>.plan.json` via `setPlan` → `persistPlan`,
  och `planSnapshot(session)`/`loadPlan` gör att en helt ny runtime hittar checkpointen
  efter full restart.
- **Historikbackade svar trodde att modellen sett gamla svar** även när historik-arrayen
  var tom; isolation garanterad per session (enkäter läcker aldrig över sessionsgränsen).

### Verifierat
- `node --test test/handoff.test.js` → 4/4 (historik→prompt, sessions-isolation,
  modellbyte-handoff, checkpoint efter full restart). Fail-first var 3 röda innan fixen.
- Fullsvit 319/0/7, i18n grön, bench 7/7 oförändrad (p50 49ms).
- Live-rerun mot qwen3:0.6b: mission 3/3 med heuristik-fallback (oförändrat beteende).
- Reality Engine v1 (mission-scan): mission kunde tidigare deklarera sig klar på en
  workers ord. NU verifieras varje del som HLlar bara att ha skrivit en fil i
  verkligheten; sammanfattningen markerar [VERIFIED: path, N bytes]
  och fail-raknaren airlig legenden. Live-bevis mot opencode Go free:
  "write asteroids.txt + volcanoes.txt" → workers kallade fs.write, verifieraren
  latte filerna, summary = "2 verified in the workspace" (Ceres 5 bytes,
  Mount Etna 10 bytes). Fail-first bevisat (test 8/9 roda pa pre-fix med
  okCount=2 for loogna workers), svit 323/0/7, i18n 3/3, live 36 s.
- Live-rerun mot opencode Go free (longcat-2.5-preview-free) vidare: mission gate foerut missed
  inline-numrering (1) (2) (3) → vanlig turn; nu: **3 worker_start + 3 worker_done + mission-event**
  redder samme input. Proof: mission.test.js 7/7 (fail-first 1 roed innan), suite 321/0/7.
  Ceres (1801, dvaer vp) / Vesuvius (AD 79) / Pacific (63 milj. sq mi).

### Fixat (tillägg samma kväll — opencode Go live)
- **`majin.provider add` droppade preset-headers.** Gateway-presets som opencode
  Go kräver skall-headern `x-opencode-session` för routning; den kopierades bara
  på UI-spåret, inte på verktyg-spåret (det enda spår användaren når via chat).
  All opencode-nyckel som lagts till via chat hade alltså 400:at. Nu plattger
  båda spåren — headrarna följer med till config. Proof: `test/provider-flow.test.js`
  rött före (assert på saknad header), grönt efter.

### Verifierat (tillägg — live mot Go-gatewayen)
- GET /models med nyckel: 37 modeller, free-modellerna verkar.
- Direct-wire mot `longcat-2.5-preview-free` (7 856 ms) och `beam-free` (551 ms):
  båda svarar korrekt ("Mars is a planet in our solar system.").
- Full MAJIN turn ×2 med opencode på chat/tasks/tools: "what is 17×3" → 51,
  sedan "the result you just gave, plus 9" → **60** — handoff-motorn biter
  även mot kraftfull live-cloud, allt utan att röka CI-sviten (319/0/7, later
  i18n grön, bench oförändrad).

## 2026-10-18 (GRAND ARCHITECT: the mission compiler ships — chat drives HYPERSWARM in code + measured scheduler fixes)

### Ändrat
- **`src/core/mission.js` (new).** `shouldMission(input)`: deterministic
  heuristic — 2+ list items, 3+ action segments, 3+ comma verb items.
  `compileMission`: ONE model call asking for strict JSON DAG, then ALL
  decisions by code. New fallback: when the model cannot produce JSON
  (real small local models like qwen3:0.6b), a deterministic list-extraction
  builds the graph instead — marked `origin: heuristic-fallback`.
- **Chat wiring.** `agent._turnOnce` mission gate after routing, before the
  tool loop: multi-part goals compile to a DAG, `analyzeSwarm` (code)
  decides worker count, `runSwarm` executes via the proven `subagentWorker`,
  and the result arrives as one aggregated honest summary
  (`Mission done — N/M parts ok`). Any failure falls back to a normal turn —
  a mission can never crash a conversation.
- **`runSwarm` rewritten as a WORK-CONSERVING scheduler.** Free capacity is
  assigned runnable work immediately (no batch waits); a `started`-set makes
  duplicate launches structurally impossible; `AbortSignal` is honored with
  honest `cancelled` markings; deadline exists.
- **Multi-level blocked dependencies now propagate transitively.** If dep(a)
  fails, then both c(a) and d(c) and e(d) are marked blocked with reasons —
  nothing waits forever. Proof: the regression test hung >180 s before the
  fix, terminates in ~1 ms after.
- **Privacy-first diagnostics (`src/core/diagnostics.js`).** allowlist-only
  events, local ring log ALWAYS, transmission NEVER unless explicitly
  `diagnostics.analytics:true` AND an https endpoint is configured. Unknown
  fields are dropped loudly, payload capped, no prompts/keys/filenames — by
  schema, not by redaction.
- Bench: `node scripts/bench.mjs --mission` prints an honest mission summary
  (mock latencies) every run.

### Verifierat
- `test/swarm.test.js` 10/10 (2 new REGRESSION tests: timeout-hung bug
  proven >180 s pre-fix; work-conserving 841 ms → ~0 gap).
- `test/mission.test.js` 5/5 fail-first: shouldMission parser, cycle/limit
  rejection, heuristic-fallback mission, agent chat turned mission with 3
  workers + mission event, single-question never missions.
- `test/diagnostics.test.js` 5/5.
- LIVE against real model: Ollama qwen3:0.6b CPU — chat input
  "1. say asteroid 2. say volcano 3. say eclipse" → mission, 3 workers
  chosen by code, 3 worker_start events + mission event, 3/3 ok, 96 s wall
  (small local model answers are thin, the PIPELINE is the proof).
- Suite 313 pass / 0 fail / 7 skipped (pending final count in CI); i18n
  guard clean; bench 7/7 unchanged.

## 2026-10-18 (LIVE DELIVERY: update-chain status, linux/mac answers, opencode provider, release-bump)

### Ändrat
- **Update state speaks one word, always.** Every `checkForUpdate` result now
  carries `status`: `disabled | error | up_to_date | available`. The UI and a
  future About-surface read ONE field instead of re-deriving it from flags.
- **Linux/mac get a real answer, not a Windows EXE in Downloads.** `installSetup`
  returns `windows_only` **with `releaseUrl`** (repo-slug-derived release page);
  the chip click opens that page. The installer branch is unchanged on win32.
  CLI `majin update` prints what to do on linux/mac (`git pull && npm install &&
  majin restart` for a source checkout) instead of silently downloading a
  useless Windows installer.
- **OpenCode Go preset.** `opencode` (base `https://opencode.ai/zen/go/v1`,
  OpenAI-compatible, free/flash models first) with its REQUIRED
  `x-opencode-session` header - the gateway returns 400 MissingSessionID
  without it. `/api/provider` add now carries `preset.headers` into the saved
  provider (was dropped before: any preset with mandatory headers died at
  call time). Models read live from the catalog during this session:
  glm-5.3-flash, qwen3.8-flash, deepseek-v4.1-flash, beam-free, ...
- **Release bumping is a checked script, not a hand-edit.**
  `scripts/bump-version.mjs`: refuses non-semver, refuses a tag that already
  exists on GitHub Releases (never overwrite), refuses going backwards, then
  syncs package.json, package-lock.json ROOT ONLY (dependency contracts
  untouched), src/core/version.js and installer/majin.iss. Combined with the
  existing build-exe.yml (main-push with raised version => auto build + tag +
  release + sha256 assets) this is the manual-free path: bump => merge =>
  release published by CI.
- **Honest limitation recorded:** the advisory key `oc_sk_...` authenticates
  (model catalog readable) but has NO active Go plan and zero Zen balance, so
  no real calls yet. Everything except the paid-call run is built and pinned.
- `test/update.test.js`: the old windows-only fallback assertion (EXE into
  Downloads on every platform) pinned the defect itself; it now pins the new
  platform-honest behavior with the reason written next to it.

### Verifierat
- `node --test test/livedelivery.test.js` -> **7/7 green**, fail-first first
  (6 red): status in every branch (incl. zero network calls when disabled),
  same-version silence, releaseUrl from repo slug, preset headers carried over
  HTTP into saved config, bump plan guards, bump apply touches 4 files and
  never dependency versions.
- Suite **303 pass / 0 fail / 7 skipped**; i18n guard 0/85; bench unchanged
  7/7.
- `node scripts/bump-version.mjs 0.5.5` demo -> 4 files changed, reverted.

## 2026-10-18 (HYPERSWARM: parallel workers are chosen AND proven — code, not a coordinator-LLM)

### Ändrat
- **`src/core/swarm.js` (new).** `analyzeSwarm(nodes, opts)` answers "how many
  workers does this job deserve?" with deterministic arithmetic only: critical
  path = longest estMs-chain, makespan = list scheduling with critical-path
  priority, spawn granted only if modeled gain clears `max(2x workerOverhead,
  10% of sequential)`. Unknown durations -> conservative single, never a guess.
  No prompt, no model, zero tokens for the decision (GENESIS ZERO principle).
- **`runSwarm({nodes, cap})` (new).** A real DAG scheduler on the existing
  runtime: dependencies unlock as workers finish, independent branches keep
  running when a sibling fails, and every node lands with a typed honest end:
  `ok:true` + value, `ok:false` + error, or `blocked:true` + which dep failed.
  Never a silently dropped node.
- **`subagentWorker()` adapter (new).** Each node inherits the proven subagent
  engine (its own `sub:` session, `tasks` route, max-steps cap) so swarms run
  REAL agent turns — validated in the suite against three concurrent mock
  routes with full text assertions.
- **A failure never poisons siblings** (scheduler): `a fails` -> `b` and
  `d(b)` still complete; only `c(a)` is marked blocked with its reason.

### Verifierat
- `node --test test/swarm.test.js` -> **8/8 green**, failed-first-then-green.
  Judges: 3 independent 60 s tasks -> 3 workers, reason cites the modeled
  gain; pure chain -> 1 worker, reason cites the critical path; 6 x 200 ms
  tasks -> 1 worker, reason cites overhead eating the win; unknown durations
  -> 1 worker, reason admits the estimate gap.
- Overlap is MEASURED, not promised: two-node scheduling shows wall 123 ms <
  half the sequential 360 ms for three 120 ms nodes, and at least two
  started/ended windows genuinely intersect.
- `node scripts/bench.mjs --swarm` -> **66% shorter wall** (363 -> 123 ms)
  on 3 independent tasks doing REAL file IO (8 files written+read each) plus
  120 ms induced latency per task that honestly stands in for model round
  trips; real LLM calls are seconds, so the note understates, not
  overstates, the gain. Printed every run beside the analyzer's decision.
- Regression-free: `node scripts/bench.mjs` (no flag) -> 7/7 unchanged;
  full suite **296 pass / 0 fail / 7 skipped**; i18n guard 0/85;
  Swedish-absence test caught 6 literals in `swarm.js` during the session and
  they are English now.

## 2026-10-18 (GENESIS ZERO: the loop sends 97% less tool-schema — measured, then flipped)

### Ändrat
- **`agent.toolSubset: true` ar nu standard.** Loopen skickar inte langre alla 103
  scheman till modellen varje turn. Per turn valjer `agent.toolSelection()` en
   deterministisk liten subset ur `Registry.search(input)` — noll LLM-tokens
  for urvalet — plus ALLTID `tools.search` som flyktvag, sa modellen sjalv kan
  hamta resten utan att gissa namn.
- **Steg-events biter ratttvis**: `step`-eventen bar nu `toolsSent` och
  `toolChars` — exakt vad som skickades over ledningen den kallelden.
- **Bench-matning sjalvforbjudna**: `node scripts/bench.mjs --subset` kor varje
  scenario dubbelt (all-scheman vs subset) och bokforr paritet + teckensbesparing.
- **Prompten arlig i bada lagen**: subset-pa talar om de synliga scheman
  utvalts och namner flyktvagen; subset-av forblir "all 103 always on".

### Verifierat
- `node scripts/bench.mjs --subset` → **-97% schema-char** (1,012,066 → 25,835
  tecken totalt, paritet 7/7: bada lagen passsar alla 7 scenarier, millisekunder
  inom brus). Detailj per scenario: 97-98% sparat.
- `node --test test/subset.test.js` → 5 pass (skrevs fail-first; pins: readOnly-
  respekt, determinism, okand-input-flyktvag, riktig fil-skrivning i subset-mode).
- `npm test` → 288 pass, 0 fail, 7 skipped · i18n 0/85 · parse 126/126.
- Bench utan flagga (`node scripts/bench.mjs`) → 7/7 green oforandrat.

## 2026-10-18 (GENESIS OMEGA fas 1: capabilities märkta + dynamisk verktygsplockning)

### Ändrat
- **Capability-kontrakt `cap/1`** på varje verktyg (`Registry.capabilities()`):
  id, grupp, beskrivning, tags (grupp + namnsegment), `sideEffects` utledd ur
  risk (read→none, write→local, exec→process, destructive→destructive) och
  inputs = verktygets eget JSON-schema. Samma pipeline som registryt redan
  mäter sig med — inga parallella sanningar.
- **`Registry.search(q)`**: deterministisk, token-fri träffsärkning. Seed-regel:
  en description ord aldrig ensam fram ett verktyg (namn/tag/grupp måste ge
  seed, beskrivning bara boost) — annars drunknar listan i löst prat.
- **Nytt verktyg `tools.search`** (meta/read, 103:e verktyget): agenterna
  hittar rätt capability på vanligt språk; svarar ärligt med `count: 0` + tips
  när ord saknas. Fungerar i readOnly-läge.
- **Systemprompten** berättar för modellen att tools.search finns så den söker
  före gissning — annars hade hela skivan legat oanvänd.
- Test-tejp: fyra antal-pinnar 102→103 med ärlig motivering i samma assert.

### Verifierat
- `node --test test/capability.test.js` → 7 pass (skrevs fail-first: alla 7 röda
  före implementationen; ranking pins: github.research vinner researchfrågan,
  fs.write hittas, browser.fill topp, inga desc-bara seeds, determinism).
- `npm test` → 280 pass, 0 fail, 7 skipped · i18n 0/85 · parse 124/124.

## 2026-10-18 (logo-audit: branden mäter grön, småstorlekarna anklagades felaktigt)

### Ändrat
- **Brand contract test (`test/brand.test.js`)**: från och med nu misslyckas
  sviten om NÅGON logotyp-variant i repot (-assets/majin.png, -assets/majin.ico
  i ALLA sju storlekar 16–256, -src/ui/logo.png) slutar vara "vit/mjus-ljus M
  på rosa". Mätt i pixlar, inte på öga. Det är det som gör att ingen behöver
  granska loggan manuellt varje gång.
- **Installer**: rensar Windows ikon-cache efter install/uppdatering
  (`ie4uinit -ClearIconCache`, tyst, hoppar över om kommandot saknas). Slutet
  på att gamla ikoner fastnar i aktivitetsfältet/genvägar efter en uppdatering.

### Sanningen om krocken
Bilden som såg mörk-och-gammal ut är INTE någon fil i repot. Pixelmätningen
bevisade: varje variant i majin.ico (16-256 px), assets/majin.png och
src/ui/logo.png bär samma design (rosa familj ≈91%, ljust M med ~60 lumen
separation). De små 16/24px-ikoner som såg "gamla" ut är bara samma märke
nedpressat i 16 pixlar. Det som faktiskt kunde bära en gammal ikon är
Windows ikon-cache eller en installation från före v0.2-märket — därav
cache-rensaren.

### Verifierat
- `node --test test/brand.test.js` → 4 pass (skrevs fail-first: fångade först
  min egen felaktiga mättrogenskap, inte tillgångarna).
- `npm test` → 273 pass, 0 fail, 7 skipped · i18n 0/84 · parse 122/122.

## 2026-10-18 (config race: the disk wins, tombstones stay dead)

### Ändrat
- **`cfg.patch()` applies on the freshest disk state, not on stale memory.**
  The file is shared truth (CLI + server can both live), and every mutation
  already goes through patch — so re-reading costs one file-read per patch and
  nothing can silently revert another process's write.
- **Tombstones** (patch value `undefined` = delete) are remembered per-process
  and re-applied after every disk merge, so a removal by this process is never
  resurrected by another merge — while keys added by other processes still
  arrive.
- Disk-backed patches re-run the full `load()` pipeline on the file: DEFAULTS
  fill + `expandEnv`, so a partial file behaves byte-identically to a boot.
- Boot-time `MAJIN_TOKEN`/`MAJIN_PORT` can never be clobbered by an older
  value wandering in from a disk merge.

### Fixat
- **CI installer-verify regression (runs 39128429043 → 39129558163)**: the
  running server's update-check saved its stale in-memory config over the
  marker the verify script's `config set` had just written — restart read
  defaults back and the step failed *config did not survive the restart*.
- **Self-inflicted during the fix (test-caught, never shipped)**:
  (1) merging DEFAULTS into the patch base resurrected tombstoned keys —
  `remove provider` brought the provider back two patches later;
  (2) skipping `expandEnv` in the base turned the literal string
  `{env:DEEPSEEK_API_KEY}` into a "real" key — route fallback died and the
  demo-chat test 401:ed against the real DeepSeek API.
  Both proven with clean A/B replays before the final form.

### Verifierat
- Race one-liner (two cfg objects, interleaved patches) → marker + update both
  survive: `node -e …` → "RACE-TSL: OK".
- `node --test test/config.test.js` → 13 pass, 0 fail (three new pins:
  fresh-disk-wins, tombstone-no-resurrect, env-refs-stay-expanded — written
  failing-first).
- `node --test test/server.test.js` → 11 pass, 0 fail · `npm test` →
  238 pass, 0 fail, 7 skipped · i18n 0/80 · parse 113/113.

## 2026-10-18 (cost truth: prices import themselves, the cap bites)

### Ändrat
- **Pricing self-import**: `GET /models` answers that carry per-model pricing
  (OpenRouter, Kilo) now write themselves into `pricing` — gaps only, never
  over a curated or hand-set price, with provenance per key in `pricingMeta`
  ({source, at}). Wired into both discovery paths: `majin.provider models`
  and `/api/models` (the answer reports `pricingImported`).
- **The budget cap stops money, not just reports**: with `budget.mode 'cap'`
  and the monthly line crossed, the loop refuses the paid call in preflight
  (before it costs anything). Free routes still answer: explicit 0/0 price,
  the mock provider, or your own server (loopback/RFC1918 — same rule as the
  key box). A remote model with NO known price counts as paid — under a cap,
  "unknown" never spends.
- **`usage.summary()` honesty fields**: `unpricedCount` + `unpricedRefs` say
  how much of the month hides behind "no price known" — a silently-$0 month
  is now impossible to miss.

### Fixat
- (Self-review during the slice) an early draft threw the budget refusal out of
  the loop instead of returning the graceful fatal-shape; tests caught it.

### Verifierat
- `node --test test/pricing.test.js` → 6 pass, 0 fail (written failing-first).
- `npm test` → 235 pass, 0 fail, 7 skipped · `npm run i18n` → 0 svenska
  literals i 80 filer · `npm run check` → 113/113 filer parse.
- Live-import against a real provider key is NOT claimed here — the parsers
  are tested against recorded OpenRouter-shaped payloads; the CI run
  dispatched in parallel exercises the build, not a paid key.

## 2026-10-18 (autopilot UI: cards you can talk to)

### Ändrat
- **Reply-to-this-agent on every card**: the card owns a reply row
  (Enter or ↩ send). The follow-up rejoins the SAME task session server-side
  (`body.task` routing, pre-existing) and streams onto the very card you typed
  against — never a new task, never the wrong one.
- **⏸/▶ buttons per card**: pause = new `/api/tasks/action` endpoint
  (running-only, else a plain-words refusal; registry moves for real). Resume
  deliberately rides the reply path with a continue-brief — it streams onto the
  card for free and needs zero second engine path.
- **Live "agents at work" deck** over the chat: every running/waiting/paused
  task from `/api/tasks` — including channel-started ones with no card —
  status dot, age, tool count, 5 s poll, hides when quiet. Real registry data
  only.
- Stream discipline: a paused card's SSE closing no longer masquerades as
  "done" (rec.paused freeze), and finish/stop hides the pause button cleanly.

### Fixat
- Endpoint body arrived as a Buffer (`body.task === undefined`) — refusal
  discipline test caught it; `readJson` now.

### Verifierat
- `node --test test/server.test.js` → 10 pass, 0 fail (failing-first guard test:
  unknown task / unknown action / wrong-state refusals over real HTTP + the
  live pause path when the demo provider leaves one running).
- `npm test` → 212 pass, 0 fail, 7 skipped · i18n 0/75 · parse 105/105.
- Visual click-through (reply row, ⏸/▶, deck) is Windows-human-round material:
  stated, not skipped — no DOM harness exists here.

## 2026-10-18 (job agent, slice 2: prepare + send — with proof or nothing)

### Ändrat
- **`jobs.prepare`**: opens the application form in the task's own browser context,
  detects fields *generically* (label/aria/placeholder/name words + type gates —
  zero site recipes), fills what can honestly be mapped (contact from the CV,
  overrides as args, the CV file attached to file inputs), and moves the
  application to `waiting`. The answer is the EXACT preview of what would be sent,
  plus a `gaps` list of what still needs a human.
- **`jobs.send`** (risk `destructive` — the guard asks every time in the default
  confirm mode, which is precisely the brief's "approval before every submission"):
  clicks the likeliest submit control by vocabulary, then **demands proof**:
  confirmation words on the result page (sv+en), a saved screenshot in
  `jobs/proofs/`, the resulting URL. Accepted → `submitted` with the proof in the
  history. NOT accepted → the status stays `waiting` and the error says so in
  plain words — an unsent application marked sent is the worst lie this product
  can tell.
- Decoration day: `found → started` is now legal (the user's own override), an
  unsend without preparation is refused, a done application refuses resend.
- **94 tools** (was 92). CI live step now also runs `test/jobs.live.test.js`.

### Fixat
- **Scheme-less links into `<input type=url>` silently cancelled every submission**
  (native constraint validation: `github.com/x` is not a URL). Found via local
  replication on a real Chromium against the exact CI form (a 120 MiB playwright
  shell in the sandbox — experimentation beat seven-minute CI guessing loops).
  Fix stack: `coerceForType` adds the scheme; preview flags FILLED-BUT-INVALID in
  plain words; `jobs.send` asks the page `checkValidity()` BEFORE clicking and
  reports exactly which fields the page would refuse. Server-side proof locally:
  POST observed, thanks words read, file field carried.
- **`followNewTarget` rewired sessions to the stale initial `about:blank` tab** —
  the wire evidence (server saw /thanks, browser read about:blank) said the click
  worked and the READS went to the wrong tab. Rule now: only tabs born AFTER
  spawn are followable (`knownTabs` snapshot at birth), source-pinned.
- **`openFor` navigated to `about:blank` on every tool reuse** (since the browser
  foundation): `Page.navigate` returns at initiation, not arrival, so read-after-
  open was an eval-vs-navigation coin flip — green twice, red twice, depending on
  the runner's mood. The live gate caught the flake signature (both suites red in
  the same minute, zero DOM): reuse now returns the handle without navigating,
  and `goto` waits for the document before asking it anything. Source-pinned so
  the race cannot return.
- `extractContact` link capture returned the `www` group instead of the URL
  (linkedin/github always null) — found by the test.
- jobs.live audit before first CI run: prepare is exec-level and would hang the
  guard in the headless runner; both tools test-side auto-approved (risks stay
  pinned).

### Verifierat
- `node --test test/jobs.test.js` → 11 pass, 0 fail (state machine, dedupe,
  match, formfill classification incl. substring traps, proof discipline).
- `npm test` → **208 pass, 0 fail, 7 skipped** · i18n 0/75 · `npm run check` 105/105.
- The end-to-end submit chain (fake employer site → posted fields → thanks words
  → status submitted, screenshot on disk) is pinned in `test/jobs.live.test.js`
  and **CI-observed green on the real Windows runner 2026-10-18 (run
  39 126 567 525)**. On the way there the hard gate caught — in order — a guard
  hang, an eval-vs-goto race, a stale-target `about:blank` wire, and the
  type=url silent-cancel; all fixed above, all before any user could meet them.

## 2026-10-18 (job agent, slice 1: the pipeline is real)

### Ändrat
- **Job-search foundation** (`src/core/jobs/` new): the application state machine
  found → matched → started → waiting → submitted/failed (+ skipped). Illegal moves
  throw plain words; `failed` demands a WHY, `submitted` demands PROOF, terminal
  means terminal ("done is done"). Proof-bearing pipeline stored at
  `<MAJIN_HOME>/jobs/applications.json`; a torn store reads as empty, never fatal.
- **Dedupe = the pipeline itself**: fingerprint from canonical URL (tracking junk
  stripped, real job-id params kept) with a title+company fallback folded for case
  and diacritics. A job seen once is a job never re-shown.
- **Deterministic CV-match** with an honest basis: site-tagged skill demands
  (must_have 1.0 / nice_to_have 0.5) when the site provides them, else the ad's own
  words; null = "cannot score this CV", never an invented score. Swedish/English
  skill vocabulary lives behind `svlex(...)` (input data, exempt from the i18n gate).
- **Platsbanken adapter** (public JobTech Dev API, no key): parser built from the
  production wire shape observed today; errors come back shaped, never thrown.
- **7 new tools → 92**: `jobs.search`, `jobs.match`, `jobs.list`, `jobs.start`,
  `jobs.skip`, `jobs.cv.set`, `jobs.cv.show` — params in the house string-shorthand.

### Fixat
- Matcher's label→canon mapping: `'js' ⊂ 'node js'` promoted *javascript* and
  `.net ⊂ kubernetes` promoted *csharp* — now longest whole-word synonym wins;
  both traps pinned by test. (Found by the test I wrote before trusting it.)
- `normalizeUrl` stripped trailing slashes only after the query string; the slash
  lives on the pathname (also pinned).

### Verifierat
- `node --test test/jobs.test.js` → 7 pass, 0 fail, 1 skipped (live gate).
- `MAJIN_JOBS_LIVE=1 node --test test/jobs.test.js` → 8/8, real Platsbanken
  round-trip green in the sandbox (one-time proof; CI does not gamble on the site).
- `npm test` → 204 pass, 0 fail, 6 skipped · `npm run i18n` 0/74 · `npm run check` 103/103.

## 2026-10-18 (ETA lands on the task cards — and the missing wire it exposed)

### Ändrat
- **Task cards now show real telemetry**: elapsed time (the card's own clock, ticking
  1×/s while live, frozen on finish/stop), tool count, and an average ms/tool *only when
  the card itself has measured ≥2 completions*. Nothing is predicted; a number that
  cannot be counted is not shown.
- **Per-task telemetry in the registry** (`toolsRun`, `avgToolMs`, `curTool`,
  `lastTool`) derived from the same event stream the cards see; `/api/tasks` carries
  it, so channel-started task decks can render honest numbers too.
- **`tool_begin` counts** alongside `tool`/`tool:start` in both server tracking and
  card display — the loop had three spellings of "a tool started" and telemetry
  agreed on all of them.

### Fixat
- **The ETA wire that was never connected**: `registry.exec` measured `ms` and put it
  in the tool result, but the loop's `tool_result` *event* dropped the field — so
  `eta.record()` had been called with `undefined` since v0.6.0's telemetry landed and
  `estimate()` could never have produced an interval. Caught in self-review while
  wiring the card display (the display needs the same field). One field, one line;
  the whole pipeline now counts for real. Also `'steg'` in the card footer is gone;
  shipped UI is English end-to-end.

### Verifierat
- Live browser gate flipped to hard: two consecutive green CI runs on the Windows
  runner (39 119 535 069 + 39 120 606 397) after it caught a real `openFor` bug.
- `node --test test/tasks.test.js` → 8 pass, 0 fail (failing test written before fix).
- `npm test` → 197 pass, 0 fail, 5 skipped · `npm run i18n` 0/70 · `npm run check` 98/98.
- Human/browser round still owed for the visual card tick (no DOM harness here —
  stated, not hidden).

## 2026-10-18 (teamwork: NL fleet commands + real ETA telemetry)

### Ändrat
- **Natural-language fleet routing** (`src/core/intent-tasks.js`, new): sentences like
  "pausa hemsidan", "agent 2, hjälp agent 1", "alla hjälpa jobbsökningen", "visa alla
  agenter" are parsed **deterministically over live task refs** (ordinals "första/andra/
  tredje", "agent N", name stems) — zero model calls for stop/pause/resume/assist/status.
  Anything that is not a fleet command falls through to the model untouched.
- **`/api/chat` intercepts fleet commands** when no explicit task is addressed: stop = the
  task's own stop; pause = stop + status `paused`; resume/assist = a brief fired into the
  SAME session in the background (assist fans out to every other running agent on "alla").
  Non-commands still create/continue tasks exactly as before.
- **Real ETA telemetry** (`EtaMetrics` in `tasks.js`): every `tool_result` records its
  measured ms under the tool name (ring of 100). `estimate()` returns an **interval**
  {n, avgMs, loMs, hiMs} only after two real runs of the same tool, otherwise null —
  "hard to estimate" is a valid answer, invented numbers are not. Exposed at
  `/api/tasks` under `telemetry`.

### Fixat
- None (new capability).

### Verifierat
- `node --test test/intent-tasks.test.js` → 4 pass, 0 fail (incl. empty-fleet honesty).
- `node --test test/server.test.js` → 9 pass, 0 fail (fleet commands over real HTTP).
- `npm test` → **196 pass, 0 fail, 5 skipped** (5 = env-gated browser live suite).
- `npm run i18n` → 0 Swedish literals / 70 files (parser vocab allowed as input data).

## 2026-10-18 (browser-use: upload + smarttab + the live wire)

### Ändrat
- **`browser.upload`** (DOM.setFileInputFiles over CDP): a file is attached to a page
  `<input type=file>` and the confirmation is read back from the input element itself —
  the CV-upload path the job agent will need. 84 → **85** tools.
- **Smarttab**: a click that spawns a new tab (target=_blank / window.open) is followed
  within 1.5 s — the agent never keeps acting on the stale tab. Session routing reads
  the live target dynamically (`send` now re-reads `b.sessionId` per call).
- **Recovery cookbook in the system prompt**: failures recover in deterministic order
  (read → narrower selector → shot once → retry/ask; no more than two clicks on the
  same failing element — three trips the loop guard).
- **CI live wire**: the exe job runs `test/browser.live.test.js` on the real Windows
  runner (Edge + node 22 exist there) with a deterministic local form server —
  `continue-on-error: true` for the first runs by design, gates once stable (noted in
  the workflow itself).

### Fixat
- **`close is not defined` in `openFor`** — my smarttab refactor dropped the `close()`
  definition; only a REAL browser run could see it, and the brand-new CI live step did
  (Windows runner, first dispatch). Restored, plus a safety net: any failure between
  browser spawn and session-ready now kills process/ws and returns the pool slot — the
  leaked handles had held the runner step for 18 minutes.
- My own closure bug: `send` captured the initial tab's sessionId, which would have
  broken smarttab the one time it matters — found during review before running.

### Verifierat
- `node --test`: **190 pass / 0 fail / 5 skipped** (adds `test/browser.test.js` 7/7:
  upload risk-pin, followNewTarget source-pin, cookbook pins); `npm run i18n` 0/69
  files; `npm run check` 96/96. LIVE e2e intentionally skipped locally (no browser in
  the sandbox, node 20 has no built-in WebSocket); its wire proof is owed by the next CI run.

## 2026-10-18 (browser-use foundation) — the agent drives the browser that is already on the machine

### Ändrat
- **New module `src/core/browser.js`** — CDP (Chrome DevTools Protocol) over Node≥22's built-in
  `fetch`+`WebSocket`, against the Chrome or Edge the user already has. No npm dependency,
  no bundled rendering engine, no Python. Everything WebSocket-shaped is lazily constructed, so
  the module loads on older runtimes and fails with a sentence, not a crash.
- **Six tools** (`browser.open/read/click/fill/shot/close`, group `web`): one window with one
  profile directory per agent session (isolation by construction — two agents never share a tab),
  global fleet cap via the task-layer locks (`browser.maxInstances`, default 3 — a fourth session
  queues honestly), `exec`-risk labeling so guarded mode asks before acting.
- **Deterministic loop guard**: `journal.guard()` throws on the third identical consecutive
  browser action — the stuck-42-retries pattern dies in code, not in retries with better luck.
- **Evidence in every answer**: click returns element tag+text and the URL after the click,
  fill returns that the value stuck in the page, read returns the page's own words, shot saves
  a real PNG in the workspace. Nothing reports "done" on faith.
- Tool count 78 → **84** (pins moved accordingly).

### Fixat
- Browser-use existed only as "open the user's default browser" (`majin.ui`) — the brief's
  agent-driven click/fill/verify did not exist at all. Now it does, with autopilot-safe
  isolation (test G requirement) designed in from the first line.

### Verifierat
- `node --test`: **189 pass / 0 fail / 4 skipped**. `test/browser.test.js` 6/6: loop guard
  (3-in-a-row throws, intervening action resets, sessions isolated), slot pool (FIFO claim,
  honest "all busy" on cap-exceeded, idempotent re-claim, full release), discovery tables
  (platform candidates, honest null), closed-fleet answers sentences.
- `node --test test/no-dead-tools.test.js`: 4/4 — all six tools complete + model-visible.
- NOT yet verified against a real browser end-to-end on CI Windows (chromium-headless agent
  turn) — tracked in TODO Hög prioritet; the CDP wire is thin but unproven by suite.

## 2026-10-18 (autopilot UI) — the S.busy wall is down

### Ändrat
- **The chat no longer blocks while MAJIN works.** In `src/ui/app.js` the gate
  `if (!input || S.busy) return false;` is replaced: a new message sent during
  a running task becomes its own parallel task (POST `{autopilot:true}`), and
  slash commands (incl. `/stop`) reach the engine even while busy.
- **Task cards in the chat.** Every parallel message gets a card with the
  server's task id, live status (working/waiting/done/error/stopped — the
  registry's vocabulary), rolling activity line (route/step/tool), streaming
  answer text (~6 paints/s), and its own ⏹ stop button that posts
  `{task: rec.id}` to `/api/chat/stop` and aborts only its own stream.
- Cards read the real SSE `event: NAME` lines (the classic parser looked at
  `data:` only) so the UI binds the resumed stream to the exact task id the
  server named — a stopped second task can never kill the first.
- App language is English in the new surface (plus repo-wide i18n gate holds).

### Fixat
- The long-standing single-stream assumption (`S.busy`, `S.abort`, `S.cur`)
  made a second message vanish silently or freeze the composer — measured in
  code, now pinned by a stability test.

### Verifierat
- `node --test`: **183 pass / 0 fail / 4 skipped**; `npm run i18n`:
  0 Swedish literals in 68 files; `node --check src/ui/app.js` clean;
  contract test pins: no `S.busy` gate, `{autopilot:true}` send,
  stop-by-task-id, task-event binding, all status styles present in the
  palette. UI painting is *not* browser-rendered here (coverage = string
  contract + server wiring); first human click-check is listed in TODO.

## 2026-10-18 — v0.5.3 shipped + autopilot core (backend) on `main`

### Ändrat
- **The silent-update relaunch belongs to our code, not to Inno.** The one-click updater now
  spawns a hidden, detached PowerShell watchdog (`src/core/update.js`, `relaunchScript` /
  `relaunchCommand`) next to the installer: it waits for the installer PID to exit (15-min
  deadline), stops leftover `majin-win-x64` processes, starts the new build
  (`start --no-window`) and logs every step to `%LOCALAPPDATA%\MAJIN\update-relaunch.log`.
  `-EncodedCommand` (base64/UTF-16LE) makes quoting unbreakable. v0.5.3 is live:
  `releases/tag/v0.5.3` @ `a6cbf39`.
- **Autopilot core (backend)**: new `src/core/tasks.js` — a deterministic `TaskRegistry`
  (task id ↔ its own session id, status machine running/paused/waiting/done/error/stopped,
  capped event trail, awareness snapshot) and `fileLocks` (FIFO per-file lock, owner re-entry,
  30 s timeout). `agent.turn` already serialized per *session*, so every independent task
  getting its own session yields real parallelism, isolated history and per-task stop without
  touching the engine. `/api/chat` creation/routing: `body.autopilot:true` starts a fresh task,
  `body.task:<id>` rejoins that task's session (never a duplicate), every turn emits
  `event: task` and is tracked in the registry; `POST /api/chat/stop {task}` stops exactly one
  task; `GET /api/tasks` is the dashboard feed (tasks + live file locks).
- **Shared awareness, zero-LLM.** Each turn's system prompt can carry a `SIBLING TASKS` block
  built from the registry — id, status, input head and the files the task holds right now —
  so an agent can plan around its siblings instead of colliding with them.
- **Files are now collision-safe for parallel agents.** `fs.write`/`fs.patch`/`fs.copy` run
  their writes under `fileLocks` (owner = task session), whole read-modify-write for
  `fs.patch`, and tmp-then-rename atomic writes so a killed task never leaves a torn file.
- Registry guard: an unknown status string throws even on terminal tasks (was silently swallowed).
- Installer keeps `skipifsilent` on the postinstall entry again (see Fixat) with a comment that
  names the CI evidence; interactive installs still auto-start MAJIN via the hidden checkbox run.

### Fixat
- **User-reported on real Windows:** `Setup — Unable to execute file …MAJIN.vbs — CreateProcess
  failed, code 193`. A `.vbs` is not a Win32 program; all launch points (start menu, desktop,
  autostart) now go through `wscript.exe` with the vbs as argument, M-icon intact.
- **CI-proven twice, 17+18-minute hangs**: a *silent* install that launches the app from Inno's
  postinstall hangs the setup process until the job timeout kills it (orphan `majin-win-x64` +
  `conhost` in both job logs — tried once with wscript, once with `runhidden` exe; same result).
  Fix: Inno never starts the app in silent mode; the updater watchdog (above) performs the
  relaunch. First v0.5.3 attempt also hit an Inno quote-grammar wall (5-quote cluster rejected
  on ValueData) — kept at 4.
- The v0.5.2-era chain silently died after one-click updates (postinstall `skipifsilent` meant
  the app never restarted and looked dead) — now handled by the watchdog chain end-to-end.

### Verifierat
- `node --test` (full suite): **182 pass / 0 fail / 4 skipped** locally at `v0.5.3`+autopilot
  (was 176 at v0.5.2; +6 autopilot tests).
- CI run `39111598323` returned `completed success` → run `39113481797` success →
  `releases/tags/v0.5.3` has 4 assets: `MAJIN-Setup.exe` 23.72 MB, `majin-win-x64.exe` 97.41 MB,
  both `.sha256`, published 2026-10-18T09:02:42Z.
- CI Windows smoke (job "the installer must install, run, survive a restart and uninstall"):
  silent install OK → `majin 0.5.3` served (78 tools, window + chips) → port stop clean →
  config survived (`name=verify-090215`) → uninstall removed program files, kept user data,
  removed Desktop icon → reinstall OK. Icon line: `now carries 7 size(s) at id 1`.
- `test/tasks.test.js` 6/6 — registry semantics; same-file FIFO queuing; different-file
  measured concurrency (peak ≥ 2); lock timeout + owner re-entry; **A:** three real scripted
  turns share wall-clock with isolated `task:*` session files and zero history bleed;
  **E:** stopping one task completes its `aborted` result while the second task returns its
  full answer; **B:** two concurrent `fs.patch` calls on one file — both edits land, no lock
  leaked.
- Watchdog script byte-verified on Linux: `relaunchCommand` output base64-decodes to the exact
  script (the same decode path PowerShell uses).
- Not yet verified by a human on Windows: update chip → relaunch UX. CI covers the mechanics.

## 2026-10-17 — v0.5.0, v0.5.1, v0.5.2 + the onboarding rounds

### Ändrat
- **0.5.2** added `majin.doctor` (human-facing capacity health, no network: per-capacity
  `OK/FIX/NOTE` with the exact tool/card that fixes it) and the meta-test `no-dead-tools`
  (all 78 tools complete, model-visible via `registry.schemas()`, readOnly-safe — locked in CI).
- **0.5.0 "Trust & Flow"**: `cfg.get()` returns clones (no more live-config mutation);
  provider lifecycle complete (multi-add, key replace, remove with automatic route repoint —
  or an honest "run setup again"); per-session serialization (`src/core/serialize.js`) so five
  fast messages never interleave while telegram/desktop/vision stay parallel; `moa.policy`
  default `'off'` (opt-in, no hidden 3× spend); build refuses to ship an exe without the pink
  M (hard error if resedit does not report `now carries`); hidden `MAJIN.vbs` launcher
  (wscript, window style 0) kills the console window; ⏻ Quit button truly stops the server;
  downloaded installers sha256-verified against the release hash and refused on mismatch;
  wizard is skip/reopen/remove-friendly; parallel tool results land on their own rows
  (`toolRows` map).
- **0.5.1**: `.sha256` sidecars written by the build scripts themselves (installer + exe), so
  the release glob cannot miss them.
- Onboarding round (unreleased-then 2026-10-17, shipped inside 0.5.x): every provider failure
  is one sentence via `explainError()` (classifies `no_key|auth|billing|model|toobig|rate|
  unreachable|upstream|provider`); permanent failures stop instead of retrying; first answer on
  a fresh install is an answer (127 ms, one step) with no MOA scaffold leakage; `needsSetup`
  turns MOA off per turn; Providers card carries all 11 presets from `state.presets` +
  address box + *get a key ↗* link; empty key box refused with the right sentence;
  `resolveModel()` carries labels.
- Dataset capture shipped (`src/core/dataset.js`): consent-first local JSONL, redaction before
  write with no switch, per-turn "do not save this" opt-out, `keepDays` trim, verdict-only
  turns as labels, **no upload code path at all** (`dataset.upload` rejected by validation).
- `majin start` forwards the flags you actually typed (`--host`, `--no-browser`,
  `--no-channels`); WhatsApp/Baileys backs off (3s→300s cap) and gives up after
  `channels.whatsapp.maxRetries` when nothing ever paired; `/api/selftest` no longer paints a
  fresh install red; mentioned API keys no longer sneaked into config (intent-word proximity
  rule, message-only-key still configures default).

### Fixat
- **0.5.1**: `set-icon.mjs` main-guard used `new URL(import.meta.url).pathname` — on Windows
  that is `/D:/a/...` and never matches `process.argv[1]`, so two releases shipped the default
  icon with exit 0 and zero output. Now `fileURLToPath` + a permanent regression test.
- **0.5.0 root disease**: `cfg.get()` leaked live config data behind validation and the
  deep-merge could never delete a nested key — removed providers survived, adds never hit disk,
  remove lied. Replaced with clone-on-get + the undefined-sentinel deletion the validator
  understands; a gemini-kind validation gap closed with it.
- Installer checksum flow was dead code (broken brace block hashing the *old* file on disk
  instead of the downloaded bytes) — both faults repaired.
- The GitHub-action icon log literally printed `icon: no output` (source of the user's "old
  icon").
- A dozen shipped Swedish strings (Telegram approval prompt, provider/schedule/skill results,
  `install.ps1` Node check + uninstall steps, the TCP timeout line) and the i18n word list's
  missing inflections (`borta/borttagen`, `svarar/svarade/svaret`, …) — caught by the gate now.

### Verifierat
- 0.5.x: `node --test` 173 tests (158 pass) at 0.5.0; releases v0.5.1+v0.5.2 published with
  4 assets each; installer + exe icons verified in job logs (`now carries 7 size(s)`); CI runs
  `39086544929` (0.5.2) success.
- Onboarding round: `node --test` **97/97**, `npm run check` 67/67, `npm run i18n` 0 in 57
  files, `npm run bench` 7/7 `VERDICT: pass`; `dist/majin.cjs` rebuilt and re-run on a second
  fresh home (11 presets incl. `kilocode`, first answer, empty-key refusal, doctor green).
- Explained: everything above verified in the Linux sandbox; Windows/browser rendering and live
  provider/channel traffic were still marked unverified at this date (see 2026-10-18).

## Tidigare (2026-06-18 → 2026-10-16) — version entries kept verbatim

### Ändrat / Fixat
- **0.4.3** — wizard save fixed root-caused (server looked up `preset`, wizard sent `name`;
  now posts `preset`, surfacing errors+hints verbatim) + a first-class **Custom endpoint**
  card (any OpenAI-compatible URL + key through `majin.provider`, no parallel system).
- **0.4.2** — header always shows the running version; installer force-closes a running MAJIN
  before replacing files (PrepareToInstall → taskkill). Never upgrade into your own ghost.
- **0.4.1** — header STOP leaves Simple mode (composer RUN becomes STOP instead; the extra
  brake stays behind the expert toggle).
- **0.4.0** — first-run wizard (`src/ui/onboard.js`, opens only on `needsSetup`: provider card
  → key → save&test → live model list → start), header model picker from the provider's own
  `/models` catalogue, single-model default written to every route with MOA off
  (`test/singlemodel.test.js` proof), config `patch()` validates against merged data.
- **0.3.0** — Imagination Engine slice 1: Live Agent Vision (real event stream as timestamped
  timeline: route/tool/approval/usage/answer), Living Core orb reflecting real state, zero
  extra model calls, textContent-only (model text never becomes markup), reduced-motion,
  fresh canvas per run.
- **0.2.1** — update checker pointed at the archived `rssen-debug/slurps` (never published a
  release → every install looked forever-fresh); default now `rssen-debug/MAJINCLI` with on-sight
  migration. `UsePreviousTasks=no` so an unchecked desktop-icon box stops reproducing forever;
  publisher/support URLs + README links de-archived; the no-network update test made
  deterministic.
- Dataset capture, `$majin.skill`, channels and RE tooling foundations landed across the
  2026-10-17 late rounds (details in git history; the upload-free dataset contract stands).

### Verifierat
- 0.4.0: onboarding structure + single-model resolution + add→models→test flow tests;
  0.3.0: slice-1 layer test-verified inert when removed; 0.2.1: deterministic update tests.
  (Exact per-version suite numbers live in the tags' own CI runs.)
