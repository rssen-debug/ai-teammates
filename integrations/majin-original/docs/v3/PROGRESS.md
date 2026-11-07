# MAJIN V3 verified progress

**As of:** 2026-10-22 (Europe/Stockholm)
**Branch:** `v3/main` (local)
**Release status:** **NOT READY**
**Current checkpoint:** V3 vertical slice plus Node 22 runtime alignment. Source commit `fcac710a2dd571228f01d3ddc5ed16697999ea2f` is local on `v3/main`; GitHub has no `v3/main` branch yet. Remote push status is reported separately.

## Score

- **Previous:** 18.00%
- **Current:** **19.00%**
- **Change:** **+1.00%**
- **Verified points:** **19.00 / 100.00**
- **Remaining points:** **81.00**

Scoring uses only `VERIFIED` criteria in `ACCEPTANCE_MATRIX.json`; `IN_PROGRESS`, `BLOCKED`, `NOT_STARTED` and `REGRESSION` earn zero. Progress is not based on code volume or confidence. The release stays NOT READY because most mandatory real-world gates are not tested.

## Points by category

| Area | Earned | Required | Evidence summary |
|---|---:|---:|---|
| V1/V2 audit and source isolation | 2.00 | 5.00 | Exact refs recorded; separate V3 branch; complete behavioral audit remains in progress. |
| V3 architecture and core runtime | 2.00 | 10.00 | V3 boundary and reuse design documented; generic runtime/entrypoint remain incomplete. |
| Realtime voice | 0.00 | 12.00 | No V3 realtime voice or Windows microphone evidence. |
| Computer/browser control | 0.00 | 12.00 | No V3 browser/desktop integration or live acceptance. |
| Goal execution and recovery | 3.00 | 12.00 | One persistent create-only file goal completes through verified V2 receipt; natural replanning/recovery remain open. |
| Multi-agent coordination | 0.00 | 8.00 | Not implemented in V3. |
| Models and providers | 0.00 | 8.00 | Deterministic slice makes no model calls; V3 provider selection not wired. |
| Living memory | 0.00 | 8.00 | V2 store inspected; V3 memory controls/retrieval not integrated. |
| Clean UI/UX and workspace | 3.00 | 10.00 | Minimal inline local shell with semantic controls, reduced-motion/focus rules and visible result; browser-rendered QA remains open. |
| Security and permissions | 3.00 | 5.00 | Loopback/origin/body and single-file boundaries verified; complete tool permissions/injection model remains open. |
| Verification and QA | 5.00 | 7.00 | SHA-256 receipt and full post-change suite/syntax/i18n checks pass; live objective benchmark remains open. |
| Windows release and packaging | 1.00 | 3.00 | Node 22 floor is aligned and covered by full Node 22 suite/static contract tests; actual Windows execution is still open. |
| **TOTAL** | **19.00** | **100.00** | **81.00 points remain.** |

## Current milestone

**Core — early progress (5–20% planning range).** This is a planning marker only; it does not award points. The verified V3 feature is a narrow local file task, not a general AI operating system.

## Release blockers

- V1/V2 deep behavioral audit is incomplete.
- No V3 realtime voice, browser/desktop control, provider UI, adaptive goal engine, multi-agent runtime or full memory experience.
- Windows install/voice/desktop tests and real browser acceptance are not available in this sandbox.
- Although package/lock, runtime guards, Windows preflights, doctor and V3 CI now consistently require Node `>=22.0.0`, the Windows scripts and GitHub-hosted workflow still need real execution.
- Remote `v3/main` is not published; push attempt was blocked by missing GitHub authentication. Do not treat the local branch/commits as published.

See `ACCEPTANCE_MATRIX.json` for criterion-level status/evidence and `TEST_EVIDENCE.md` for exact commands/results.
