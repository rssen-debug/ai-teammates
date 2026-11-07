# MAJIN V3 developer handoff — checkpoint

**Checkpoint date:** 2026-10-22 (Europe/Stockholm)
**Local branch:** `v3/main`
**Latest source commit:** `fcac710a2dd571228f01d3ddc5ed16697999ea2f` (`fix: align runtime support with Node 22`)
**Latest pre-change checkpoint:** `ca503436c856e41ef2959803ea947cdd8429c194`
**Protected V1 SHA:** `814459ea50fc86c5ac1aeed939ec9d2344dc5bfb`
**Protected V2 SHA:** `b2533097ca3c744fa7e9b152b221a97186507835`
**Score:** 19.00/100 verified, 81.00 remaining; release **NOT READY**.

## GitHub publication status — checked 2026-10-22

The repository branch page and unauthenticated `git ls-remote --heads origin refs/heads/v3/main` both show that **GitHub does not currently have `v3/main`**. The implementation and commits exist only in this workspace's local clone. The earlier push was rejected because Git could not read a GitHub username; no remote changes were made.

The GitHub connector is not available in this conversation, and the GitHub credentials previously pasted into chat are compromised and must not be reused. Do not continue feature development until the developer has a reviewable handoff and publication is handled with a fresh, authorized GitHub authentication path.

## Delivered in the local source commit

- Root package and lock require Node `>=22.0.0`, matching installed dependency engine requirements.
- V3 runtime guard is applied to V3 server and file-deliverable entry points.
- Windows install/build/setup/live-acceptance checks, startup shim, Doctor and product guidance use Node 22+.
- Added a read-only Node 22 V3 CI workflow and runtime-floor regression coverage.
- Full Node `v22.23.4` suite: 1,186 passed, 0 failed, 19 skipped (1,205 total).
- `npm run check`: 452/452 parsed; `npm run i18n`: 0 Swedish literals in 236 files; `git diff --check`: clean.
- The 19 environment skips and Windows/hosted-CI limitations are documented in `TEST_EVIDENCE.md`.

## Developer review and next actions

1. Review the complete `v3/main` history and the handoff bundle. V3 has not been uploaded to GitHub yet.
2. Revoke/rotate the OpenCode and GitHub credentials shared in chat. Publish only through a fresh authorized GitHub login/token stored outside this repository/chat.
3. Verify both protected refs remain unchanged and publish to `refs/heads/v3/main` only. Do not push to V1 `main` or V2 `v2/main`.
4. Pause new feature work until the developer can inspect this checkpoint; then next engineering objective is a narrowly scoped second V3 capability built on the existing Goal/DAG/scheduler contracts with explicit approval, cancellation and recovery tests.
5. Later add Playwright-rendered browser/accessibility checks and real Windows install/desktop/voice/provider/packaging evidence.

## Constraints and blockers

- User-shared OpenCode and GitHub credentials are compromised; never store, repeat or use them. Revoke/rotate both.
- No Windows host is available; installer/Doctor execution, real desktop, microphone and packaged release remain unverified.
- The GitHub Actions workflow has only been source/static-tested, not run remotely.
- Release remains **NOT READY**. No background process is running.
