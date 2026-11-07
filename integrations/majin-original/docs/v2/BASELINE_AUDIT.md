# MAJIN V2 — BASELINE AUDIT (Phase 0/1, evidence-first)

Created 2026-10-21 by the V2 architecture pass. Every number below was measured
against the repository during this pass; nothing is aspirational.

## 1. V1 production baseline (the thing we protect)

| Fact | Evidence |
|---|---|
| Production branch | `main` |
| V1 baseline commit | `b8dfc3e1b8` (Merge PR #234); `v2/main` itself was cut from `282a8ff` (Merge PR #235 v1.0.9 update-distribution, still pure V1 line, the latest verified V1 tip at cut time) |
| V1 single version literal | `src/core/version.js` = `1.0.9`; package.json/lock agree |
| Latest published V1 release | tag `v1.0.8`, published 2026-10-21T18:52:58Z |
| Release publisher | `.github/workflows/build-exe.yml`, tags `v*` (guarded on V2 line) |
| Windows self-hosted runner | `MAJIN-INTERACTIVE-01` (labels: self-hosted, Windows, X64, interactive-desktop, majin-qa) |
| Owner mission brief said "1.0.8" | Actual single source of truth in repo is 1.0.9; recorded as fact, not error |

## 2. Test baseline measured during this pass

| Suite | Result | Command |
|---|---|---|
| Full node suite on `v2/main` after V2-identity ripple fixes | 947 total / 930 pass / 0 fail / 17 skipped | `npm ci && npm test` |
| Same measurement basis as V1 main tip | 947/930/0/17 pattern holds on V1 main (V1 gate results in CI PR #234) | CI |
| skip class | 17 tests self-skip (environment-gated: IT lanes/eGPU/builders); normalised honest degradation, never presented as fail | reporter |

## 3. V2-identity ripple (found + fixed, with stronger assertions, not weaker)

Switching to 2.0.0-alpha initially broke 12 tests across 6 files. Root causes and
resolutions, all implemented on `v2/main` only:

| File | V1 assumption | V2 resolution |
|---|---|---|
| src/core/version.js | `1.0.9` literal | `2.0.0-alpha` + comment pinning V2 identity |
| package.json / package-lock.json | 1.0.9 twice | 2.0.0-alpha in all three positions |
| installer/majin.iss | fallback `MyAppVersion "1.0.9"` | `"2.0.0-alpha"` |
| scripts/publish.ps1 | default `$Version = '1.0.9'` | `'2.0.0-alpha'` |
| test/version.test.js | regex `/^\d+\.\d+\.\d+$/` ("plain semver, because the updater compares these as numbers") | channels regex + 6 NEW assertions: alpha<beta<rc<stable ordering, rc<N<beta, and "V2 prerelease NEVER prompts a downgrade to latest V1 tag". Updater code (`update.js compareVersions`) already understood prerelease suffixes; the test contract did not — that mismatch was the true defect |
| test/kokoro-narrator.test.js | hardcoded `/1\.0\.9/` probe on 3 packaging files | probe updated to `/2\.0\.0-alpha/`, test renamed 'V2 release identifiers align (2.0.0-alpha)' |
| test/voice-handsfree-regression.test.js | same pattern | same fix |
| test/cli.test.js | `majin --version` regex required plain semver | accepts optional V2 channel suffix, still requires exact shape |
| test/setup.test.js | stub header plain semver | accepts optional channel suffix |
| test/w6-release-gate.test.js | (cascade from broken publish.ps1 mid-edit) | passes once publish.ps1 parameter restored |

## 4. V1↔V2 isolation implemented today

| Step | State |
|---|---|
| `v2/main` created from `b8dfc3e1b8` | YES (this branch) |
| build-exe.yml tag trigger scoped to `v1.*` on V2 line | YES (V2 cannot publish production installers even by accident) |
| `.github/workflows/v2-fast-ci.yml` added: push `[v2/**]`, PR `[v2/main]`, contents:read only, V2 identity gate + full node suite | YES |
| Branch topology: main=V1, v2/main=integration, v2/*=features | policy recorded here; PRs V2 → v2/main only |
| V1 maintenance fixes | go to main as before; V2 never force-pushes anything |
| V2 identifies itself | `2.0.0-alpha` (prompt requirement satisfied) |

## 5. Repo inventory (structural, measured)

- `src/` = cli / core / ui. Core holds ~60 modules incl. agent.js, loop.js, computer-use.js,
  desktop-vision.js, wincontrol flows, provider adapters (provider/ dir), session/chat stores,
  updater (`update.js`), config (config.js), goal-artifact.js, pink-cursor.js.
- `scripts/` = build-setup.mjs, build-installer.mjs, publish.ps1, qa/ (owner-desktop-live.mjs,
  fixtures), windows/ (live-acceptance-run.ps1), remote QA bridges.
- `.github/workflows/` = 40+ workflows: build/publish (build-exe.yml), Windows hardware lanes,
  QA corridors, hardening gates (w5/w6), remote command channel (majin-remote-command.yml),
  interactive runner preflights.
- `test/` = 900+ node:test files incl. version.contract, release gates (w6), computer-use,
  voice (kokoro-narrator, voice-handsfree-regression), desktop-eval, live-provider-chaos.

## 6. Capability classification — first pass (deep audit next)

**VERIFIED (measured this session):** single-version-literal contract; CLI `--version/-h`
without server; test suite 930/0/17; installer payload version wiring; prerelease-aware
update comparison (`compareVersions`); setup payload integrity.

**PARTIAL (exists, V1-evidence requires re-audit on V2):** computer-use loop (computer.js +
computer-use.js; interactive runner evidence exists for V1 lanes: run 39588560481, 39586059993),
photo/pixel W12 overlay verification (pink-cursor.js), Windows hardware gating (w5),
OpenCode Go routing (provider/), voice narration (kokoro integration, voice-handsfree UI).

**NOT_TESTED on V2 yet:** full Windows interactive lane against 2.0.0-alpha, installer build
for 2.0.0-alpha, updater end-to-end on V2 channel, Kokoro on Windows runner for V2 line.

**NOT_IMPLEMENTED:** goal compiler / execution DAG / verifier loop as a coherent runtime
(PHASE 2), session memory store, multi-agent supervisor, Studio artifact cards,
conversation-grade voice interrupt loop, MAJIN GAUNTLET benchmark harness.

## 7. Next (roadmap order, per prompt §118)

PHASE 1 continued: deepen the capability audit to every V1 module with evidence links,
then ARCHITECTURE.md (typed runtime: goals/tasks/events/verification), PRODUCT_SPEC,
ACCEPTANCE_MATRIX, and the first runtime improvement (goal-state machine + receipts)
implemented behind a feature flag on its own `v2/agent-runtime` branch.
