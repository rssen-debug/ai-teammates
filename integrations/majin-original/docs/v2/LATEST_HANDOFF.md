# MAJIN V2 — LATEST HANDOFF (owner-facing, 2026-10-21)

V2 HEAD (v2/main): studio-doctor merged (preflight panel over HTTP; secret fingerprint-only asserted) ← 317b2910 (deps-guard) ← defd17a6 (models live) ← 935822a6 (studio bundle)

COMPLETED (this working day, verified):
- v2/main created from V1 tip 282a8ff; V1 untouched (policy: only v2/* branches carry V2 code)
- V2 identity 2.0.0-alpha sealed in 5 places; production publisher scoped to v1.* tags
- v2-fast-ci.yml: green on v2/main pushes (runs 39674378385, 39677942161)
- Goal kernel: 12-state machine, tamper-evident receipts, COMPLETE-gate on verified acceptance, crash-resume (8/8 tests)
- DAG + scheduler: dependency graph, p-queue bounded concurrency, transient-retry per normalized failure class, failure propagation, JSON resume (8/8 tests)
- Failure class table: 19 classes (prompt §23 list) + retry policy + error shape → class mapping
- Dependency audit with evidence: p-queue adopted (MIT), node:sqlite deferred (needs Node>=22.13 floor at packaging), better-sqlite3/xstate/toposort rejected with reasons — docs/v2/DEPENDENCIES_AND_LICENSES.md

VERIFIED:
- Full suite local: 963 tests / 946 pass / 0 fail / 17 skip (npm test, twice)
- CI: v2-fast-ci green on v2/main, v2/agent-runtime x2, and this PR pre-merge

CI (state at handoff): v2-fast-ci GREEN on v2/main tip

WINDOWS (owner PC): not re-run against 2.0.0-alpha yet (phase 4 activity; channel majin-remote-command ready)

BENCHMARK: baseline 930-pass pattern recorded in BASELINE_AUDIT; no changes to perf budgets yet

FAILED: none open on v2/main

BLOCKED: none

OPEN PRS: scheduler PR (merge tracks end of this turn)

INCIDENT POSTMORTEM (2026-10-21, documented per anti-coverup policy):
 1. PR #249 merged while branch CI was FAILED (poll loop went on completed, not conclusion). 2. Cause: .gitignore "memory/" silently swallowed kernel src dir src/v2/memory/; local suite was green only because files existed untracked. REPAIRS: #250 negation rule + store.js; CI green branch + post-merge (f7a24225). GUARD: merges require conclusion==success now; ignored-file check in add-source routine.

NEXT (roadmap order):
1. Hardware lane vs 2.0.0-alpha on the owner PC via majin-remote-command (PHASE 4 prep, gauntlet as scenario base)
2. Context engine + memory store (PHASE 7) with JSON-first persistence, sqlite decision at alpha packaging
3. Voice pipeline scaffolding check (PHASE 6); promptfoo candidate for model benchmarking milestone

(Noterat 2026-10-22 — levande registry: opencode-go-gateway listar 36 modeller; statiska profiler ligger efter: +29 till (bl.a. glm-5.3, kimi-k3, qwen3.8-max, deepseek-v4-pro) −1 bort (longcat-2.5-preview-free). Avsiktligt INTE tyst uppdaterat — drift är dokumenterad, inte dold.)
