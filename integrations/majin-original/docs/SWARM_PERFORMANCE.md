# MAJIN — SWARM PERFORMANCE SCORECARD (GODLIKE V4 §3C)

Baselines are measured, never estimated. Starred values (*) are live-measured.
This file is the scoreboard for HYPERSWARM OMEGA optimizations; raw evidence
lives in test logs and CI run logs cited per row.

## Baselines (2026-10-19, main v0.7.2-prep)

| metric | value | evidence |
|---|---|---|
| verified task success (CI suite) | 380 pass / 0 fail / 404 collected | node --test test/ |
| parallel-vs-sequential mission wall | **4.29× median speedup*** (47 499 → 11 065 ms) | scripts/live-bench.mjs + test/live-bench.test.js |
| live mission json verified write | 72 511 tokens measured* | test/domains-live.test.js |
| live acceptance A1/A2 usage | 43 379 / 281 891 tokens* | test/acceptance-live.test.js |
| bench (deterministic, mock) | 7/7 green, 24 400 tokens, $0 | scripts/bench.mjs |

## V4 §7 — rate-limit orchestrator (this wave)

Simulator `test/ratelimit-sim.test.js` 8/8 (deterministic, offline — sim proves
the LOGIC and violation/throughput relationship; real quotas remain
owner-configured per provider, pass-through is the honest default):

| sim | claim | bots (sabotage) counter-proof |
|---|---|---|
| S1 naive burst vs rpm=2 | ≥3 guaranteed 429s | — |
| S2 admission 6 calls | 0 violations, all complete, wall 1 046 ms, queued-wait 2 893 ms | SB reservations-removed → red |
| S3 Retry-After floor | max(ra, exp+jitter) honored | SC floor-removed → red |
| S4 queued cancellation | AbortError lands on caller's promise, zero unhandledRejection | — |
| S5 priority (interactive>background) | iv admitted first | SA3 sorts-both-removed → red |
| S6 AIMD | 8→4→2 halving on 429s; +1 calm recovery | — |
| S7 err classes | 6-class table | — |
| S8 pass-through | no quota configured → instant admit | — |

Open measurement debt: real opencode quotas are not yet published in
config (`limits.opencode`) — the owner decides actual RPM/TPM numbers;
until then the orchestrator is verifiably pass-through in production.

## Rate-limit incidence to date
Edge policy flake class (browser launch): 2 events, fixed (bounded retry).
Provider 429s in this session's work: 0 observed; opencode free quotas held.

<!-- PERFLAB:BEGIN -->
## WAVE 5 (§19) perf lab A/B/C/D — topology variants (2026-10-22T10:30:32.082Z, scale 0.4, median of 3)

Measured by running the REAL scheduler (`runSwarm`) on synthetic DAGs with declared
durations (real sleeps). No model calls. Raw JSON: `docs/evidence/perf-topology-2026-10-22.json`.

| lab | scenario | variant A | variant B | ratio/finding |
|---|---|---|---|---|
| A | wide fan-out (8 indep, cap 2) | CP-first 139 ms | legacy 140 ms | **×0.996** |
| B | deep chain + 6 shorts (cap 2) | CP-first 217 ms | declaration-order 217 ms | **×1.001** |
| C | 11× est-overrun (est 10, actual ~110, cap 3) | adaptive 178 ms (contractions: 2) | legacy 89 ms (always 0) | trade, not speedup: frugality on broken model |
| D | ranker on 2 000 nodes + 200-node pass-through grid | rank-2000: 3.93 ms | grid-200: 16 ms | overhead guard; ranks computed: 2000 |

Honesty notes: CI timing noise is real — A/B are direction-asserted with wide margins in
`test/w5-perf-lab.test.js`; C reports a deliberate trade (wall-clock for spawn-frugality);
D is a regression guard for ranker cost. Nothing here is a live-model metric.
<!-- PERFLAB:END -->
