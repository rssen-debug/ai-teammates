# MAJIN V3 test evidence

**As of:** 2026-10-22 (Europe/Stockholm)
**Current validation environment:** Linux sandbox, Node `v22.23.4`; npm `10.8.2`.
**V3 source branch:** local `v3/main`; runtime-alignment source commit `fcac710a2dd571228f01d3ddc5ed16697999ea2f`; remote `v3/main` is not published.
**Scope caveat:** No Windows desktop, microphone, headed browser or operator credentials were used. The credentials pasted in chat were not used; revoke/rotate them.

## V2 source baseline before V3 code

| Command | Result |
|---|---|
| `npm ci --ignore-scripts --no-audit --no-fund` | On Node `v20.20.2`, completed with `EBADENGINE` warnings: locked packages `canonicalize`, `p-queue` and transitive dependencies required Node `>=22`, while the then-current manifest declared `>=20.11.0`. |
| `npm test` | 1,176 passed, 0 failed, 19 skipped; 1,195 total; 218,475 ms. |

The engine discrepancy was resolved in this round. The baseline above is retained as historical evidence; current package and lock metadata require Node `>=22.0.0`.

## Node 22 clean install

Command: `npx --yes --package=node@22 -c 'node --version && npm ci --ignore-scripts --no-audit --no-fund'`

- Node: `v22.23.4`; npm reported `added 175 packages in 3s`.
- Exit code: `0`; no `EBADENGINE` warning.
- npm emitted a deprecated `prebuild-install` notice and twice warned that the `whatsapp-rust-bridge` tarball data looked corrupt, retried it, and completed successfully.
- `--ignore-scripts` was used for the local sandbox install. The committed V3 CI workflow uses regular `npm ci`; the GitHub-hosted workflow itself has not yet run.

## Runtime contract and V3 vertical-slice tests

Command: `node --test test/v3-runtime-floor.test.js test/v3-vertical-slice.test.js` under Node `v22.23.4`.

- 10 passed, 0 failed, 0 skipped.
- Covers Node version parsing/refusal, manifest and lockfile alignment with required dependency engine fields, entry-point/install/doctor/docs/CI contracts, verified file-goal receipt, traversal and reserved-name rejection, no-overwrite behavior, accessible minimal UI contract, loopback HTTP request-to-verified-result flow, origin/content-type/request-size protections and server responsiveness after rejection.

A follow-up focused run of installer/setup/version plus V3 tests reported 30 passed, 0 failed, 2 skipped, 32 total. The two skips require Windows packaging artifacts unavailable in this sandbox.

## Full post-change suite

Command: `npm test` under Node `v22.23.4`.

| Outcome | Count |
|---|---:|
| Passed | 1,186 |
| Failed | 0 |
| Skipped | 19 |
| Total | 1,205 |
| Duration | 214,758 ms |

The first full Node 22 run exposed three stale assertions that still expected the old Node 20 floor and one compatibility test that flagged a hard-coded semver literal in the new runtime helper. The runtime constant was made compositional and the installer/setup assertions were updated to enforce Node 22; the affected tests passed, followed by the complete passing suite above. The 19 skips are environment-gated and are not evidence of working live providers, Windows desktop control, real voice interruption or V3 browser automation.

## Static and consistency checks

All run under Node `v22.23.4` after the final source/test fixes:

| Command | Result |
|---|---|
| `npm run check` | PASS — 452/452 JavaScript/module files parse cleanly. |
| `npm run i18n` | PASS — 0 Swedish string literals in 236 scanned files. |
| `git diff --check` | PASS — no whitespace errors. |

The broad existing benchmark suite rewrites timing snapshots when run. Its incidental changes to benchmark docs/evidence were restored; they are not part of this V3 change.

## Not run / not verified

- GitHub-hosted V3 CI workflow (workflow added but not pushed/published).
- Windows install preflight, doctor, desktop, installer/package build or update workflow on a real Windows host.
- Playwright-rendered V3 browser UI, keyboard navigation, visual regression or screen reader test.
- V3 browser automation against public or authenticated sites.
- Real microphone, barge-in latency, Swedish/English speech recognition, echo suppression or reconnect behavior.
- V3 model-provider live calls, API-key persistence, failure fallback or cost reporting.
- Crash/power-loss fault injection, Windows filesystem edge cases, concurrent goal checkpoints, objective benchmark, security penetration review or SBOM generation.

No performance or real-world task-success claim is made from mock/unit/integration results.
