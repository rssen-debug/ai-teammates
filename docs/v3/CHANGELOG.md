# MAJIN V3 development changelog

## 2026-10-22 — Initial V3 vertical slice

- Created isolated local `v3/main` from the observed V2 baseline; V1 and V2 remain protected/read-only.
- Reused V2 `Goal` and file verifier to implement a deterministic create-only file goal with verified SHA-256 receipt and persisted checkpoints.
- Added a loopback-only V3 preview API and a minimal, responsive, inline-asset UI that communicates the real verification result.
- Added input validation, path traversal/reserved-name rejection, no-overwrite behavior, request origin/host checks and body limits.
- Added seven targeted V3 unit/integration tests. Targeted tests passed 7/7; the full suite passed 1,183/1,202 with 19 environment-gated skips; parse check passed 450/450 and i18n check found zero Swedish string literals. Exact scope and limits are in `TEST_EVIDENCE.md`.
- Local code commit: `6b27fa6d93ce95d113569a408174ea4bfcbaaa05`; checkpoint docs commit: `ee91b8029923a78e53ff1b0f4d88ce2c7d7f3724`. Push attempt was blocked by missing GitHub auth; no remote V3 branch was created.
- No new dependencies; no upstream source copied.
