# MAJIN V4 — continuation handover

## Latest verified checkpoint — 24 October, NOT READY

New audit milestone after the real-Go checkpoint: see final chronological entry.
Audit implementation is tested and committed separately; running Ghost source
is still e45640a until genuine process activation is verified. Do not use a new
checkout HEAD as proof that the existing Node process loaded new audit modules.

Current installed/runtime source: e45640a5a5e0de2688e4321c713908a62d231d0d.
Use git rev-parse HEAD for the later evidence/handover commit. Older head notes
below are historical. New code: durable V4 Scheduler binding, actual JSON source
conditions/dedup/run limits, explicit-device encrypted Web Push and PWA shell13.
Real Go created a monitoring task from ordinary chat; actual timer checked public
Node.js GitHub metadata THREE times, exactly one alert, paused at3/3. Receipts:
genesis-monitor-attempt-3.json and genesis-monitor-timer-budget.json. Push state:
ZERO subscribed devices, alert no_subscribed_devices; physical receipt FALSE.
Planned child-restart test was REJECTED by automatic review: blocked by policy.
It did not run; no alternate restart route attempted. No new host-restart PASS.

Real Go software repair3 completed with actual process-tool execution, independent
CLI6/6 and generated tests11/11. Model-created source/test bytes are preserved in
evidence/software-generated with SHA256 manifest; no manual app correction.
Two failed creations and two failed repairs remain recorded. This is scoped
scenarioB CLI success after recovery, not universal-task or form PASS. Five old
form attempts remain FAIL; no new form run. Evaluation-client/demo guard plus
preserved generated-app suite17/0/0. Exact e456 V4 CI and runner SUCCESS observed;
Windows desktop remained in progress, not declared PASS.

Owner says no more questions. Continue independent engineering; do not invent
physical acceptance, billable-model authorization or production trust. Latest
usage observation61% used/39% remaining; account-wide, not a completion estimate.
No further cleanup: owner reports~50GB freed. Scrapers/profiles/backups untouched.
Next: preserve this evidence; integrate V2 audit and other original parity gaps,
then continue real scenarios A/C/D/E/F/G, billing/eligible-model verification,
physical notification/voice and signed native release gates as access permits.
Do not mark complete or merge while those gates are unverified/incomplete.

Status: **NOT READY**. Latest pushed/deployed product before the approval-continuation milestone: `909d758e5c10ce8d58d62cca67cd78a5a8da4bdd`. Initial handover: `f62e6f6f9d27d16e63228125cb041e129324d437`. Use `git rev-parse HEAD` for this updated milestone identity.
Branch `codex/v4-final-integration-20261023`, draft [PR 401](https://github.com/rssen-debug/MAJINCLI/pull/401), target `v4/main`; no merge or production publication.

## Mission and scope

Complete a general-purpose intent -> plan -> real tools -> verification -> artifact
agent, without promising success on every external task. Preserve all original
parity requirements. The owner's Project Genesis objective additionally requires
explicit OpenCode Go billing/catalogue protections, canonical cross-device model
selection, real-model scenarios A–G, durable background monitoring and actual Web
Push received on a locked iPhone 13. None of these is waived by unit-test counts.

## Architecture and existing functionality

V4 uses V1 provider/browser/Windows adapters and V2 kernel, goals, tools, receipts,
teams and graph orchestration. No second agent engine or history store should be
created. `src/v4/server.js` serves authenticated HTTP/SSE and the shared minimal
client. `src/v4/agent.js` executes real-model turns; `models.js` wraps V1 catalogue
discovery. V1 scheduler/heartbeat/channels remain in `src/core` and should be reused.

Verified: real OpenCode Go `opencode-go / glm-5.3-flash`, streaming, actual verified
write/read; dependent graph 8 calls/peak 2; forced child-crash recovery; shared
canonical history across two existing sessions and host restart. CLI/version
migration, durable inline receipts and mobile hidden-overlay repair are saved.
Owner approved chat, restored Kokoro/am_adam and English audio on iPhone 13, while
still reporting latency. Hero is “Majin lets run it.” without suggestion chips.

## Ghost installation, data and provider

Machine DESKTOP-C1RSBUA. Actual source host `%LOCALAPPDATA%/MAJIN-V4-Host`.
Original source `%LOCALAPPDATA%/MAJIN-Ultimate-V4` remains preserved. Data:
`%LOCALAPPDATA%/MAJIN`; never reset it. Private backup outside Git under this
task's `work/private/ghost-backup`: 39 files restored byte-identically, 839 original
installation files checked, Git bundle includes the prior stash. Latest check:
23 original data/config/key/pairing files unchanged, six existing sessions.

Keep the working Go provider, keys and subscription unchanged. Never print or
commit config/auth values. Go is NOT Zen: current official documentation at https://opencode.ai/v2/docs/console/go/
now uses protocol-specific `/inference/go/openai/v1`, `/anthropic/v1` and
`/google/v1beta` bases beneath `/inference/go`. Ghost's preserved working route
is `https://opencode.ai/inference/go/v1`, with live catalogue and read-only usage
on `/models` and `/usage`. Older `/zen/go/v1` is also recognized. `/zen/v1` is
separate Zen. The first identity implementation missed Ghost's compatibility
path; production verification caught it before claiming PASS, and the follow-up
adds all documented exact Go paths without changing the working configuration. Shared hostname/model names do
not establish an entitlement. Verify current official documentation and actual
metadata; unknown billing must say “Cost unknown — verify with provider”. No
automatic paid fallback. The selector now uses one V4-owned durable `v4/model-selection.json` (no V1
credential/config rewrite), version conflicts, endpoint-bound cost authorization,
search, an included-only filter and six-second visible-tab synchronization.
All unverified account entitlements remain UNKNOWN. Zero token prices or a Go
endpoint do not prove subscription inclusion. The previously owner-configured
route is preserved; switching to another unknown-cost route requires explicit UI
confirmation. No alternate-model fallback is attempted on inference failure.
Model listing metadata retains the last verified catalogue after failed refresh,
marks it stale, and keeps known context/tools/price source/time when provided.
Exact HTTPS endpoint distinguishes Go from Zen. The included filter can honestly
be empty until account entitlement is established. This is PARTIAL, not full Go
acceptance: actual entitlement and switching two eligible live models remain open.

Loopback host port 7373; Tailscale HTTPS origin is
`https://desktop-c1rsbua.tailaf5875.ts.net`. Source Node supervisor and local Python
voice worker are running. User-level environment config points at the existing
worker/client and local model caches; no keys belong in this document.

## Voice and in-progress edits

Existing `scripts/majin-kokoro-voice.py` runs Kokoro/am_adam and warm multilingual
Whisper tiny locally. CPU bounded to two threads per engine, ONNX idle spinning
disabled. V4 uses existing V2 command STT/TTS via `local-voice-client.mjs`.
Initial successful synthetic HTTPS STT -> actual model -> WAV: 11.266 s. This is
not a physical latency measurement. Real iPhone natural interruption, explicit
5G reconnect and full Ghost audio acceptance remain unconfirmed.

Segmented WAV streaming now reuses the SAME Kokoro service and authenticated
voice endpoint, with bounded text, abortable playback, sequential segment
validation and URL/listener cleanup. Explicit activation: `MAJIN_V4_STREAM_TTS=1`
and an existing local TTS command. Hosts without it keep the full-WAV route.
PWA shell 11 also carries the canonical selector and prevents old client code remaining cached.

Focused voice tests: 25 passed, 0 failed, 0 skipped. Synthetic loopback benchmark
in `evidence/ghost-voice/stream-latency.json`: first audio 4270 ms, stream completion
13503 ms (three segments), whole-WAV comparison 11563 ms, identical text/model.
Kokoro create_stream alone gave one batch for a normal reply; sentence-sized
inference units fix that first-audio bottleneck. This does NOT measure iPhone
end-to-end latency or prove physical interruption. Streaming code is deployed and enabled on Ghost at `fffa918`.
Authenticated Tailscale HTTPS: first WAV segment 4301 ms, complete 7758 ms,
two valid segments, shell 9 served, existing sessions preserved. Evidence:
`evidence/ghost-voice/stream-https.json`. This is synthetic text, not phone timing.
The temporary 18766 worker has been stopped by verified PID/command. Supervisor
session 55449 keeps production running; host PID was 8784. Recheck current PIDs.
Canonical selector `8ab8434` was fast-forwarded and only the source host child
was restarted by the existing supervisor. Live verification found the Go identity
path omission; the follow-up identity fix and usage display still need deployment
before rerunning `../ghost-model-selection-live.mjs`. No new model or cost was
authorized by the failed check. Actual Go catalogue returns 37 models; usage
endpoint HTTP 200 has rolling/weekly/monthly windows only, no entitlement or Extra
Usage flag. New adapter exposes only validated window status/percent/reset time,
source and timestamp, retaining stale data honestly. It never labels these as
proof of subscription inclusion or disabled overage. Keep full P1 PARTIAL.

Files: `scripts/majin-kokoro-voice.py`, `scripts/v4/benchmark-narrator.mjs`,
`src/v4/voice.js`, `src/v4/server.js`, `src/v4/ui/voice.js`, `src/v4/ui/app.js`,
PWA shell references, and `test/v4/voice-stream.test.js`.

## Latest evidence and failures

See `FINAL_RELEASE_REPORT.md`, `FINAL_FEATURE_PARITY.md`, `GHOST_ACCEPTANCE_20261023.md`
and `evidence/ghost-final-status.json`. Legacy: 1284 passed/0 failed/23 skipped
after resolving 43 reproduced failures. Completed local V4: 505/0/0, but checkout
changed during that run; do not assign it to an immutable latest head. Exact
`0dad743` V4 CI: 501/0/5, 617 sources parsed, i18n passed. At the last observation
for `930e2fb`, runner passed and V4/Windows desktop CI were running; recheck now.
The 18 omitted-module DOM harness regressions were corrected and 18/18 retested.
New combined model/selection/real-client DOM regression: 40 passed/0 failed/0 skipped.
New selector browser regression: 2 passed/0 failed/0 skipped (isolated Edge Chromium
and Windows WebKit, mobile touch + desktop, search/filter, rejected/accepted cost
consent and cross-client propagation). Initial Chromium discovery skipped because
the default revision was absent; explicit existing Edge was then tested successfully.
No physical iPhone or live Go acceptance is inferred from those fixtures.
At `930e2fb`: V4 CI and Windows runner passed; Windows desktop CI was CANCELLED.
Recheck CI against the actual newest SHA before any release decision.

Untracked screenshots, generated benchmark JSON and Python caches in the working
checkout are test outputs, not unrelated owner edits. Do not blindly add them.
The original `browser-run.json` was restored; fresh browser evidence is saved as
`ghost-browser-run.json` to preserve historic reports.

## Remaining requirements and decisions

P0: live-model unfamiliar dynamic form/upload, software build/test/repair,
research, reversible Windows control, durable orchestration/cancellation/resume,
mobile execution and two-model Go acceptance. Existing injected-planner tests
do not prove real-model desktop/browser control. External submissions need the
owner's scoped authorization; no CAPTCHA/access-control bypass.

P1: Implemented canonical selection/version conflicts, search/included filter,
unknown-cost confirmation and inference-side route authorization; exact endpoint
identity and stale catalogue preservation. Remaining: account entitlement proof,
verified included default and meaningful included filter contents, two real eligible
Go models switching through both physical clients, verified price/limit metadata.
Do not label the complete P1 requirement PASS from the local fixtures.

P2: reduce first-audio latency; preserve the approved narrator; test interruption,
background release/reconnection on physical iPhone. Do not re-request already
granted ordinary development authorization. Batch necessary physical tests.

P3: actual login autostart, native installation, production signing, host/native
update activation/restart/rollback, every parity gap: channels/proactive heartbeat,
separate-store memory sync, typed self-config/safe reset, V4 audit/anchors/export,
durable graph resume/replan, team checkpoint coordination and token/currency
budgets, documents/previews/OCR/large files, DPI/multimonitor and background delivery.

Mandatory always-on extension: reuse scheduler/heartbeat; durable natural-language
monitor tasks, deterministic conditions/dedup/budgets, edit/pause/resume/cancel,
restart recovery, real external-source check and controlled threshold test; secure
Web Push subscriptions and notification history/deep links. PASS requires actual
notification on the owner's locked iPhone, not reopened chat or a mocked push.

External dependencies: approved production signer/channel absent. Unsigned native
installer was blocked by Windows application control; never bypass. Scheduled
task failed and is disabled; a user Startup shortcut is registered but its test
launch was blocked by automatic review. Actual logon remains unverified. Browser
opening was denied by saved origin permission even after renewed owner consent;
do not try alternate surfaces/CDP/shell as a workaround. The owner opened the site
manually. Respect that boundary while continuing independent coding/testing.

## Safe next commands and delivery

From the working repository:

```powershell
git status --short
git rev-parse HEAD
node --check src/v4/ui/voice.js
node --test test/v4/voice-server.test.js test/v4/voice-capture.test.js
npm run i18n
```

Streaming is measured/deployed; isolated worker stopped. Complete push/deployment
of the canonical selector, recheck authenticated production catalogue and real
inference using the existing Go route. Never authorize unknown additional costs
on the owner's behalf for switching tests. Then prioritize real-model scenarios
A–G and durable scheduler/heartbeat/push integration, retaining every original
parity requirement and reusable verified-error memory without automatic production
code mutation. Do not spend the budget repeating unchanged full suites.

Git CLI account lacks push rights. Use the authorized GitHub connector's
create_tree/create_commit/update_ref with expected parent; helper
`../index-tree.mjs` exports canonical staged text and Git tree SHA. Verify remote
tree equals `git write-tree`, fetch, verify `git diff FETCH_HEAD --quiet`, and
only then update local HEAD. Pull installed source with `--ff-only`; restart only
the affected supervised process after verifying its exact PID/command. Do not
change global credentials or overwrite someone else's edits.

READY requires all original and Genesis gates, actual model-selection billing
proof, real-model scenarios A–G, installed Windows/mobile acceptance, physical
voice and locked-iPhone push, login/restart/update/rollback/data preservation and
approved production trust. Until then keep PR draft/open and report NOT READY.


### Follow-up focused verification

Go compatibility/canonical endpoint identity and strict usage parser: focused
model/selection/voice-stream set 29 passed, 0 failed, 0 skipped. Previous selector
browser tests 2/0/0 and combined model/client DOM tests 40/0/0 remain distinct
runs; do not add overlapping counts. The working Go config remains unchanged.
Do not infer Extra Usage disabled: official Go docs explain that enabled Console
Extra Usage can bill the existing Go route after allowance exhaustion. Account
verification remains required before claiming no extra charges.


## Live model/canonical selection and host activation — current checkpoint

`evidence/ghost-model-selection.json` records actual authenticated Tailscale
HTTPS: 37 live Go catalogue entries, validated usage windows, canonical
`opencode-go/glm-5.3-flash` version 1 in two existing sessions, stale update 409,
real model workspace_write + workspace_read, independently verified exact file
bytes and original V1 config unchanged. After another source child restart,
selection version 1 and both sessions still agreed. Account inclusion/Extra
Usage remain unknown; no other model was authorized or tested. Full physical
mobile/Windows selector acceptance remains open.

The owner then explicitly said in this chat: full computer access, continue.
Owner Mode was OFF. Using that authorization, activated 63 existing host tools
in files/shell/sys/web/research/net/desktop/screen/computer/audit/learn/flows.
Filesystem grant is ONLY the MAJIN workspace. Existing approval policy remains
unchanged; no system-drive/profile/credential-folder grant. Other lanes were
not needed. Recheck `/api/capabilities` rather than assuming registration means
actual execution. Existing supervisor session 55449 remains active; parent PID
was 15736 and source child was 14980 before the next restart; identify afresh.

Actual Go discovery probe selected sys_info, exec_backends and exec_start, then
correctly waited for process consent. It did NOT finish or create the requested
artifact (`evidence/ghost-tool-discovery.json` records failure/incomplete, not
PASS). That exposed a P0 bug: resolving approval executed only the held action
and prematurely completed the task, abandoning the remaining model plan.

The current verified code fix extracts the EXISTING model loop for fresh and
continued turns (no duplicate agent engine), persists pending batch/model context,
prior tool results, budget counters, request ID and tool exposure, then resumes
at the exact held call after one-use consent. Earlier actions are not repeated.
Valid pending checkpoints survive host boot, including conversations older than
the drawer's 100-row limit. Malformed or legacy checkpoints fail closed. Approval
continuations remain cancellable and session-owned, and model-round exhaustion
now reports incomplete failure instead of success. One-shot approval is retained.

Focused results before the full run: agent/turn/context/client-DOM 52/0/0;
agent/crash/conversation after drawer-limit change 34/0/0. New regressions cover
multiple held actions in one batch, real disk reload/reconciliation, no duplicate
side effects/approval, unreset budgets, invalid checkpoints and cancellation.
A justified full V4 run with concurrency 2 was started after the final shared-loop
code edits, log `../genesis-full-v4.log`, exec session 79719. Do not claim it passed
until completion or change tested source during that run. Source tests can spend
up to their 120-second child timeouts in acceptance/CLI fixtures. Preserve failed
results. Do not kill unrelated Codex/MCP/browser processes by executable name.

Next: finish full run, repair actual failures, commit/push/deploy this milestone,
then repeat the REAL Go host-inspection probe and explicitly inspect any held
process command before approving under the owner's authorized controlled test.
The old pre-fix pending probe has no continuation and must not be claimed resumed;
boot reconciliation will block it honestly. The previous generated read-only
command was a Node OS/platform/CPU query, not an arbitrary shell operation.
Then prioritize previously unseen browser form/upload and software build/repair
with real Go, followed by persistent scheduler/heartbeat/Web Push. Keep the
complete original acceptance matrix and every external release blocker.

Potential budget issue: production defaults are four model rounds/six tool calls
per turn. Do not hardcode a special case or reset counters to make acceptance
pass; longer tasks need an explicitly bounded general budget policy. Persistent
monitoring is still FAIL and locked physical iPhone push is still FAIL.


### Full regression result and integration repair

The full V4 run finished: **524 passed, 1 failed, 0 skipped / 525 tests**,
472.162 seconds. Only failure: the OLD per-conversation model-selection
integration test sent no expectedVersion/cost authorization and expected 200;
the new protective API correctly returned 409. The same sole failure occurred
in exact `909d758` CI: Linux 513/1/7; Windows 519/1/1. Windows runner passed;
packaging was skipped after the failed test gate. Do not call those CI runs green.
The integration test is updated to the requested canonical setting, explicit
cost authorization and actual host restart. Separate repaired integration suite:
5 passed/0 failed/0 skipped. No authorization gate was relaxed.

Review also found that the UI did not show Stop during approval continuation.
Fresh turns and continuations now share startStream/finishStream; Stop includes
both current turn and conversation handles so an old finished journal ID cannot
hide the resumed task. Real-client DOM tests prove continued work remains busy,
completes normally, and can be cancelled: 2/0/0. PWA shell 12 carries this change.
The final current-source focused suite (agent failures/cancel/client DOM/
integration) finished: **45 passed, 0 failed, 0 skipped**, log
`../genesis-final-focused.log`. i18n: 0 stray Swedish literals in 322 files. Full-run browser output was copied to
`evidence/genesis-browser-run.json`; original historical browser-run.json restored.

Do not begin an identical full suite again merely to obtain a green count:
product core was stable during the full run; later changes are the corrected
integration fixture and focused-tested UI busy/cancel handler. New exact-head CI
will provide the immutable complete gate; recheck it. A final release still
requires every whole-suite/release gate and real-world acceptance.

Next scheduler review findings (not yet changed): core Scheduler uses a module-
global file path, non-atomic save that swallows errors, and manual fire does not
exclude an already-running job. Reuse and repair this engine when binding V4,
rather than introducing another scheduler. Cron zero steps/ranges must be
validated BEFORE loops; `*/0` currently risks a synchronous infinite loop.
Read-only deterministic monitors need durable condition/dedup/outbox metadata,
bounded retries and restart recovery; actual Web Push still needs implementation
and owner-granted installed-PWA permission/locked-phone receipt. Preserve all
original requirements, including meaningful approval details after reload.


## Verified execution and browser-isolation follow-up

Latest pushed/deployed source before this follow-up: `01c97b46fa093b4faa368baef294cdcec064add3`.
All three exact-head CI workflows are GREEN: V4 CI 520 passed/0 failed/7 skipped;
Windows desktop 526/0/1 including packaging, native-window smoke and packaged
cold start; Windows runner passed. Generic builder 'signing' log messages do
not establish an approved production identity; signer/channel and Ghost native
acceptance remain BLOCKED. Do not mistake hosted CI smoke for Ghost installation.

Live Go host inspection now COMPLETED after two narrowly inspected one-use
approvals: Node OS/CPU query and its exact exec_wait job. `sys_info`, tools_search,
exec_backends, exec_start, exec_wait, workspace_write, workspace_read each have
exactly ONE successful action receipt. Independently verified JSON: win32 and
four logical CPUs. See `evidence/ghost-tool-discovery-resumed.json`; the original
incomplete attempt remains in `ghost-tool-discovery.json`. Attempt/start events
include waiting and resumed dispatches; do not count them as duplicate executions.

General production budget knobs were explicitly set in USER environment to
12 model rounds / 24 tool calls, rather than resetting budgets or hardcoding this
task. The durable live goal verifies those bounds. V1 config, keys, original
history/pairing files remain unchanged (23 hashes match; 39 restored hashes match).
Supervisor session is now 64738; source child was 17260. Recheck identities before
stopping anything. Startup and physical acceptance remain separate.

Browser review found V4 was passing static session 'v4' to every adapted V1 tool.
The follow-up uses the existing AsyncLocalStorage goal ID for stable, isolated
V1 sessions across consent pauses and delegates. The same original browser engine
is reused. On task completion/cancellation/denial the owned HEADLESS browser is
closed and its fleet slot returned; owner-visible windows are preserved. Waiting
for consent keeps the task page. Two actual local browser processes passed this
isolation/lifecycle test with an INJECTED planner, not Go. Initial Windows sync
cleanup had EPERM; asynchronous guarded test cleanup passed. Do not hide that the
first fixtures failed cleanup, or claim physical/device/model proof from them.

Also fixed the V2 runner's unused deadline timer: successful/throwing/schema-invalid
calls now release it. Three subprocess tests prove natural process exit before
an otherwise-unused 30-second timer, while timeout/consent tests still pass.
Focused browser/host/agent/cancel regression: 175 passed, 0 failed, 5 skips.
Installer/timer/real-browser-lifecycle follow-up: 17/0/0. Eval client/fixture: 6/0/0.
Full ROOT legacy after shared-runner change: 1286 passed, 1 failed, 23 skipped;
only failure was the preexisting ASCII assertion rejecting the PS5 UTF-8 BOM.
The test now checks ASCII BODY after an optional BOM (not a security bypass);
installer tests passed in the 17-test follow-up. This is NOT a final green whole
legacy run. Original benchmark documents were restored; new generated copies are
in work/genesis-BENCHMARKS.md and work/genesis-SWARM_PERFORMANCE.md.

Two owned failed-test Temp folders remain: majin-goal-browser-oy3bC9 and
majin-goal-browser-dcZARi beneath Ghost's Local/Temp. Automatic approval review
REJECTED native PowerShell cleanup as 'blocked by policy', without another reason.
No alternate delete was attempted after that denial. Do not retry around policy.

Reusable LIVE acceptance client and randomized local form fixture are now under
`scripts/v4/evals/`. Client uses the real authenticated MAJIN HTTP/SSE pipeline,
keeps planning in Go, bounds events/approvals, never approves unknown scopes and
refuses to substitute demo. Cookie is never an argument or evidence value.
Explicit `--local-owner-home` reads ONLY an existing paired session and host HMAC
key, creates/rotates nothing, and can target ONLY loopback. Otherwise use an
existing paired cookie in MAJIN_EVAL_COOKIE; never print it. Unit tests prove the
local-owner helper does not modify files or forward credentials to a remote host.

The controlled form has randomized field IDs, dynamic team controls, a genuine
422 server validation step with re-render and cleared upload, actual multipart
file bytes, one saved receipt and duplicate refusal. Backend fixtures passed;
LIVE GO FORM ACCEPTANCE HAS NOT RUN YET. No model actions/selectors are scripted.
Use the CLI only after committing/deploying this follow-up:

```powershell
node scripts/v4/evals/browser-form.mjs --host http://127.0.0.1:7373 --local-owner-home C:/Users/Ghost/AppData/Local/MAJIN --workspace C:/Users/Ghost/AppData/Local/MAJIN/workspace --source-dir C:/Users/Ghost/AppData/Local/MAJIN-V4-Host --out docs/v4/evidence/genesis-form-attempt-1.json --approve-controlled-actions
```

This grants one-use approvals ONLY to this isolated fixture's browser operations
and exact synthetic upload file. It rejects other actions. Keep every failure
artifact; a rerun requires a NEW evidence output path. A PASS here covers the
controlled unknown-form/upload/validation chain, not external auth handoff,
physical mobile execution, cancellation, all A–G or universal success.
Then continue software build/test/repair and persistent scheduler/heartbeat/push.

### Controlled Go form failures and select repair, 2026-10-23

Actual installed source 43003d350704abff768bf381c6e36a0c59b2465e ran two
real Go/glm-5.3-flash form attempts. BOTH FAIL, preserved in
`evidence/genesis-form-attempt-1.json` and `genesis-form-attempt-2.json`.
Neither submitted or uploaded anything; both exhausted 12 model rounds.
Attempt 2 includes actual tool errors: select input reported immediate value
rejection; repeated malformed calls omitted a required string argument. The
first evidence's failure:null was an eval-reporting gap, not absence of failure.
The harness now retains SSE error text and individual tool failures.

The existing browser.fill now accepts an exact internal option value or unique
visible label, refuses ambiguous/disabled/missing options before mutation, and
checks retention against the resolved internal value without exposing typed
values. Unknown labels return bounded current option labels. Schema errors now
name the argument to correct without echoing input contents. No input validation,
consent rule or turn budget was relaxed. No task-specific selectors were added.
Actual local-browser regression passed, including ambiguous/disabled choices,
internal value retention and output privacy. First focused suite 35/0/0; shared
runner/host follow-up 32/0/0. This repair has NOT yet passed live Go acceptance.
Next attempt must use a fresh evidence path after deployment; preserve failures.

All three CI runs for exact 43003d3 verified successful: V4 40029142561,
Windows desktop 40029142247, runner 40029142289. This is hosted CI, not trusted
production signing or physical Ghost native-install acceptance. Overall NOT READY;
all earlier Genesis, persistent scheduler/push and release blockers remain open.

Attempt 3 on deployed 065711d926898268f9b2b3b3c366c3025431a907 is also FAIL:
real Go filled controls and uploaded the file, but no POST/receipt. Preserved
in genesis-form-attempt-3.json. It exposed an independent grounding defect:
GROUND_JS was an ordinary JS template, turning its whitespace regexp into
`/s+/g` at runtime. Anonymous button names containing s then failed the click
identity check. String.raw preserves the intended regexp. Actual browser test
now observes and clicks 'Register session', then changes the name and confirms
the next click is rejected without another action. Identity checks stay intact.
Checkbox expectations without expectSelector now bind to the actual clicked
selector/ref; they still run the existing read-only verifier. Real DOM checkbox
test passes. Browser/grounding/verification regression 49/0/0, plus updated
physical-DOM regression 1/0/0. No physical iPhone or live Go PASS from these tests.
No turn or tool budget was increased. Continue with a fresh live evidence path.

Attempt 4 on exact 37c0a25b561fc85ea5aa0276e5abb546f0a7283b is FAIL and
preserved in genesis-form-attempt-4.json: filled/uploaded/clicked but no server
submission. Failed operations include filling a checkbox and a malformed click
expectation. Twelve rounds exhausted honestly. The model now receives remaining
round/tool counts on each request, guidance to batch independent grounded calls,
re-observe changed identities and reserve outcome verification. Counts are not
reset or increased; the note is not accumulated in conversation history.
Agent failure/continuation/cancel/budget regression 15/0/0. Last controlled form
attempt is number 5; do not continue unlimited attempts or erase failures.

### End of bounded form run — 24 October 2026, NOT READY

Attempt 5 ran real Go on deployed 527b021d8077d1aabf1ea8ef7bb764d3caaf58ca.
FAIL: browser_upload received CSS `[e3]` instead of an actual file-input selector;
the model did not recover before twelve rounds. No server submissions or receipt.
Saved genesis-form-attempt-5.json; all FIVE attempts remain. No more form attempts
in this run. A prior CLI preflight hit ECONNREFUSED during source-child restart;
no model task or fixture was started then. Supervisor recovered; health returned
200, source child PID13020, parent9636 at observation. Existing supervisor exec
session64738 remains live; do not stop it casually.

Current installed/source code head527b021. Last owner consent gives broad computer
access but does not provide production signing identity or override managed
policy. Data recheck at22:00:46UTC: all23 original selected files unchanged,39
restore hashes match. Public-safe receipt in outputs/MAJIN-data-preservation-20261024.json.
No unrelated personal data, credentials or external registration was submitted.
Latest reports explicitly retain all legacy and Genesis gates. End status is
NOT READY, not partial READY. Next work needs a general fix for live control
grounding/tool misuse and bounded durable continuation, then genuine scenarios
A–G and persistent scheduler/heartbeat/push; retain production/physical blockers.
One source-follow-up risk remains: V1 browser calls may outlive V4 tool abort and
reopen after cleanup. Do not claim complete browser crash/resource recovery.

CI527b021 V4 run40030665846 failed:530pass/1fail/7skip. Sole failure was the
test's 'pending task older than drawer cap' assertion: fast Linux creation can
share updatedAt timestamps. The fixture now explicitly ages the pending chat by
60seconds on disk and in its loaded object before creating101 newer chats. No
production ordering/reconciliation rule was changed and the original100-chat
cap assertion remains. Agent suite15/0/0 after correction. Runner40030665849
passed; Windows40030665852 was still in progress at this observation. Keep this
failure record even if the next exact-head CI passes.

### Final observed CI and storage incident, 24 October

Exact2e4e7c59f414a5ba1fdc6c9f946f6c39cf137885 now has all THREE CI runs
successful: V4 run40031125742/job120679344820 (538tests,531pass,0fail,7skip),
runner40031125751, Windows desktop40031125762/job120679486738. Local syntax
632/632 and i18n0/326files. PR401 verified open/draft/unmerged with matching head.
This does not turn any failed live form or physical/production gate into PASS.

Final status export hit ENOSPC: C drive had zero free bytes. A redundant download
`work/alpha3-ci.zip` was removed ONLY AFTER all26 archive entries were SHA256
matched against retained extracted files, including the installer/evidence.
Recovered~132MB; latest free131784704bytes. Original installer, private backup,
credentials, history and personal files retained. No removal of the two previously
policy-denied Temp directories was retried. Their combined/other test temp data
was inspected read-only, not deleted. The source host remains200 healthy and all23
original selected file hashes still match;39 restore hashes remain identical.
Disk capacity is now an ADDITIONAL NOT READY operational blocker; no claim of
stable sustained writes/monitoring under this low-space condition. A zero-byte
failed output export is being replaced with a validated final status receipt in
outputs. Do not count it as a valid report until JSON parsing succeeds.

### Continued engineering — grounded uploads, 24 October

Previous goal turn classified PROGRESS: deployed fixes, five preserved real-model
failures and exact-code CI evidence changed the next action. Current goal remains
active. Re-read the entire latest goal objective file before this continuation.
The five-attempt form cap remains exhausted; no additional live form attempts.

Existing browser.upload now accepts selector OR live ref, matching fill/click.
Numbered refs are not silently treated as CSS. Before mutation it checks unique
target, current grounded identity, file-input type and disabled/inert state. It
checks the retained requested file name/size after the app update. Exact local
file bytes are verified independently in a real local browser regression.
Ambiguous controls, changed refs, unknown refs and bracketed ref-as-CSS input
execute no upload. The V4 owner path/approval boundary is unchanged.
Focused browser/grounding/host suite44/0/0; expanded actual-browser regression1/0/0.
These are deterministic/local-browser tests, NOT a new Go form acceptance PASS.

Disk read-only inventory: Ghost profile~30GB, Windows logical files~37.6GB,
Program Files~2.1GB, x86~5.9GB, MAJIN test Temp files~78MB. Do not delete personal
downloads/models/runtime caches. A guarded native PowerShell removal of ONLY
C:/Users/Ghost/AppData/Local/pip/cache was REJECTED by automatic review as
'blocked by policy'. No alternate API/CLI or retry was used to bypass this.
Owner asked via async input to free at least5GB manually; reply pending. Last
available space~128MB. Smaller independent engineering can continue, but avoid
large downloads/full suites until actual disk headroom is available. Existing
supervisor/source host still alive and health200; do not restart another host.
Account usage read directly:51% used of weekly window, not near98% at observation.
Next: safe common browser cancellation/resource lifecycle and existing scheduler
integration; retain all original parity, signing and physical acceptance gates.

Additional source inspection found browser.upload was in group web, bypassing
the adapter's group-files-only folder check. It now uses the same PATH_ARGUMENTS
mapping and checkPath real-location/grant enforcement as filesystem tools. The
adapter always consults that existing map, independent of lane/group. A targeted
runner regression checks workspace, traversal/outside denial, live grant and
immediate revocation; no browser call executes for an unauthorized file. This is
a closed permission gap, not an expansion of Ghost's grants.
Combined actual-browser/file-access/host regression after this correction34/0/0.

Exact ad1895b CI is now terminal: runner and Windows desktop SUCCESS, V4 Linux
FAIL530/1/7. Sole failure was real-browser-lifecycle 'both distinct task browsers
remain open during consent', after~39.5seconds. Preserve run40031941788/job
120682045655. The assertion is retained; next work must diagnose real startup/
deadline/cleanup rather than skip it or relax isolation. No full release PASS.

### Browser abort/resource follow-up — 24 October

Verified code defects repaired in the existing browser engine: CDP request timers
closed over a mutable request counter, allowing an old timeout to remove a newer
pending RPC; socket close did not settle pending calls. Requests now own their
IDs/timers/listeners, support AbortSignal, and settle on disconnect/send errors.
V4 adapters propagate the actual per-call signal through a derived call context
without mutating shared context. Browser startup/HTTP/socket/navigation and
click/fill/upload mutations now receive/check cancellation. Aborted launches
close their owned browser, release the fleet slot and cannot later register a
session. Existing visible owner windows are not globally enumerated or killed.

Actual local browser stalled-navigation abort test confirms the owned debug
endpoint closes, slot count returns0, no late session appears and a pre-aborted
open claims no slot. Existing two-goal consent isolation and real form-control
regressions pass. Agent/approval/cancel/browser follow-up24/0/0; combined RPC,
browser, host, exposure and actual-browser regressions57/0/0. No actual Go form
rerun and no physical-device PASS. The older intermittent Linux lifecycle CI
failure's root cause is NOT proven to be the RPC defect; its assertion remains,
with tool error diagnostics added for the next failure rather than a skip.

7ec1008 CI: Linux531pass/1fail/7skip, Windows537pass/1fail/1skip, runnerPASS.
Both failures were the same legacy synthetic tool-exposure fixture: fs.stat C:\x
without any allowed root. It now explicitly supplies a temporary workspace and
also asserts that an outside path is denied; enforcement stays fail-closed.
Focused exposure/RPC/host tests38/0/0 before the later combined57-test run.
Owner disk-space question remains pending;~111MB free at last observation.
Do not perform more live form attempts; retain five FAIL receipts and every
original/Genesis release gate. Next independent milestone: existing scheduler
validation/persistence and V4 binding, without starting a duplicate engine.

### Existing scheduler hardening and owner-authorized cleanup — 24 October

Owner explicitly renewed cleanup authorization: clean the computer while
preserving all scrapers. A same-target retry of guarded native pip cache removal
was still REJECTED as 'blocked by policy'. No alternate CLI/API was used on pip,
and the earlier two denied Temp directories remain untouched.
Different, individually verified temporary installer files were safely removed:
- VS Code setup248776320bytes: valid signatures and exactly the already installed
  1.143.0 version; installer process not active.
- ChatGPT-x64.msix486461102bytes: inactive, truncated ZIP/MSIX central directory;
  SHA2569CEF90B1686DBC1A316A8341B4A44FC754A3DA825CB5DFBF590C6C82CF82FC5E.
- GitHub Runner2.338.1 ZIP104210469bytes: ALL276 archived files SHA256 matched
  retained installed copies before removing only the ZIP.
No scraper code/data/environments/browser profiles or original MAJIN installer/
backup was removed. A recursive diagnostic inventory grew to1.5GB RAM and was
stopped by its verified exact PID6920; no scraper process was stopped. Later
inventory used a10second/depth8/skip-reparse bound. Last observed free space
1353191424bytes; below the requested5GB headroom, but no longer zero. At22:44:59UTC
the23 original selected hashes still match and39 restored-file hashes match.

Exact f01dc187e6007f940412dfa2c8fda7623dfe253c CI all THREE SUCCESS:
V4 run40033857013/job120688427577=534pass/0fail/7skip of541;
Windows run40033856808/job120688426945=540pass/0fail/1skip of541, packaging and
native smoke/cold start passed on hosted runner; runner40033856759passed.
Ghost source health200 observed; this is not production signing/native Ghost PASS.

The SAME src/core/schedule.js engine now validates zero cron steps/huge ranges
before loops; start/step0/15 means0,15,30,45; malformed calendar dates/intervals
fail. Next-cron search compiles fields once instead of reparsing each minute.
Scheduler accepts an explicit store path/clock for V4 reuse, retaining the V1
default. Store writes are private, fsync'd temp+rename; corrupt stores throw and
remain untouched, and save failure rolls back add/remove/pause acknowledgement.
Every dispatch checkpoints running/runId before calling a tool; failure to save
dispatches nothing. Completed/interrupted history is bounded50 entries. On boot,
interrupted mutating work is paused rather than replayed. Only an explicit
resumeReadOnlyOnBoot option permits immediate retry of read-only jobs. A held
approval pauses subsequent scheduled dispatch. Concurrent manual/timer attempts
cannot run the same job twice; repeated start no longer leaks interval handles.
Focused scheduler+V1 read-only regression16/0/0, including actual child-process
crash/reload, corrupt-store preservation and failed-start checkpoint. New scheduler
changes are NOT yet connected to V4 tasks/monitoring and NOT an always-on PASS.

Next engineering: bind this existing Scheduler to V4 server lifecycle and its
same agent/TurnJournal/conversations. Refactor the existing handleChat launch into
a shared helper rather than a second agent loop. Add typed approval-gated task
tools, authenticated management, durable conditions/dedup/outbox/budgets and
edit/pause/cancel. Reuse core Heartbeat for delivery/event digests. Web Push and
physical locked-iPhone receipt remain unimplemented/unverified. Do not initialize
legacy schedule.json or any unrelated production automation during tests.
Run: node --test test/core-schedule.test.js test/readonly.test.js

### HTTP safety milestone — 24 October

Owner reports disk remediation completed (~50GB). No further cleanup planned.
Exact cccf09fb3ccdc6e0f37681ad979bb392670a5d75 CI: V4 40035816313,
Windows desktop40035816310 and runner40035816524 all SUCCESS.
web.fetch now accepts GET/HEAD only and rejects bodies/method overrides before
network contact. Raw net.http remains available at external approval tier;
it previously exposed POST/DELETE as read-only. Streaming responses stop at the
byte cap instead of allocating the full response first. Truncated downloads
write nothing, use existing atomic file helper with cancellation, and enforce
live V4 folder grants. Failed rename/cancel retains original bytes and cleans
temporary output. Focused HTTP/read-only/file-access/host suite45/0/0.
No new real-model acceptance is implied by these controlled network tests.
Remaining priority: genuine unfamiliar Go task success, canonical model billing
verification, V4 Scheduler binding, conditions/dedup/budgets and locked-iPhone
push. Original parity, physical voice, signed native release/update gates remain.

### V4 background task binding — 24 October, PARTIAL

HTTP safety changes pushed as daf04bf905ed1ecda8944a5f54ca4cf7ff5c1d56.
V4 now binds SAME core Scheduler to the same startJournalTurn helper used by
foreground chat, agent, conversation/goal stores and approval continuation.
Authenticated GET/POST /api/tasks and discoverable task_list/task_manage support
create/edit/pause/resume/cancel/run. Model creation/modification is external-tier
approval gated. Default20 and maximum1000 total runs, minimum30second interval,
maximum100 tasks. Run counts checkpoint BEFORE dispatch; exhausted tasks pause.
Failures and approval holds pause future execution rather than replay effects.
Cancellation retains task/history. Host close stops scheduler and active turns.
Idle schedules load after restart; interrupted mutating work remains paused by
the existing recovery policy. Journal reconnect buffers remain in-memory;
conversation and goal records are durable. No second agent loop/store added.
Focused background/core scheduler/turn journal/V1 readonly suite31/0/0. Includes
real HTTP dispatch then actual file bytes/history, auth/CSRF refusal, restart
reload, edit/pause/cancel, run exhaustion, creation approval and held-run pause.
These tests use labelled demo/fake callbacks; not live-Go/physical acceptance.

Conditional source evaluation, durable alert dedup/outbox, bounded failure retry,
per-task token/currency accounting, heartbeat delivery integration and Web Push
are still incomplete. No locked iPhone receipt and no always-on PASS claimed.

Real Go software evaluation: two creations and one repair remain FAIL, immutable
receipts genesis-software-attempt-1/-2 and genesis-software-repair-1. Attempt1
CLI cases6/6 but model tests3 failures; harness denied exec_start (equivalent
local tool was not initially allowed). Attempt2 model tests9/9, but independent
prototype-key category case failed; harness exec_wait metadata validation also
incorrectly expected an unstored cwd. Scope now accepts only exact authorized
commands/local backend/current-run metadata; no broad process approval. Repair
used genuine Go and actual patch/process/log tools but regressed CLI shape and
exhausted recovery with invalid arguments; independent checks still fail.
Do not hide either model defects or harness defects, or label scenarioB complete.
Five older form FAIL receipts remain intact; no further form attempt was run.

### Conditional monitoring and encrypted Web Push — 24 October, PARTIAL

New runtime implementation: same Scheduler tasks can inspect actual JSON via
registered read-only web_fetch and deterministic JSON Pointer/comparison. Numeric
types are checked; missing/incomplete/invalid sources fail honestly. Unchanged
checks do not invoke the model. Threshold edges have stable durable IDs and
notification outbox deduplication; chat evidence records observed value/source.
At most3 source failures before pause; owner cancellation during an in-flight
read prevents a late alert. Total-run budgets are checkpointed, exhausted jobs
pause even after an attempted resume. Cancellation/history remain durable.

Added pinned web-push3.6.7 with lockfile integrity. Official implementation
reference: https://github.com/web-push-libs/web-push#readme
VAPID keys generated once and persisted BEFORE exposing the public key, inside
an actual ACL-protected private directory. These local push keys are NOT a
production release-signing identity. Subscriptions require explicit authenticated
user interaction, valid HTTPS push service endpoint/encryption keys, max10
registered devices. Delivery encrypts payload; bounded outbox100/history200,
three transient retries and expired-device removal. History explicitly labels
accepted_by_push_service, never physical receipt. Generic lock-screen body,
stable notification tag, same-origin conversation deep links, enable/test/disable
controls in the existing menu. PWA shell13 invalidates old asset versions.

Latest focused push/core scheduler suite16/0/0 after run-budget/key persistence
hardening. Earlier push/background9/0/0; security/scheduler40/0/0 (overlap; do not
sum). Actual Chrome mobile touch plus Chrome/WebKit model selectors and owner/
exposure32/0/0, zero skips after using existing installed Chrome executable.
Parse641/641 observed before last tiny edits; i18n remains separate.

Exact dabcda6 CI failed3 assertions on Linux and Windows: obsolete exact base-tool
lists and a real model-facing root-union schema defect. task_manage now exposes
an object input schema while retaining typed action validation internally. Tests
explicitly include task_list/task_manage built-ins; host tools still disappear
on revoke and task management still requires scoped approval. No security rule
was relaxed. New-head CI/install/live Go and locked-iPhone acceptance required.

Missing: live-Go natural-language task creation and real external source test,
physical locked iPhone notification receipt/opening, transport acknowledgements
from the physical device, heartbeat digest integration and token/currency budgets.
Network push acceptance is not proof of phone delivery. Native production signing,
app/host updates, other original/Genesis gates remain open; PR stays NOT READY.

### Live monitoring follow-up — 24 October

Owner explicitly requests no more questions; continue all available engineering.
Physical receipt still requires evidence and is not inferred from that consent.
Live Go monitor attempts1/2 were scoped-denied and remain FAIL: no task created.
Attempt2 omitted the deterministic condition and used 'every 1 minute', exposing
missing English interval aliases. Core parser now supports English seconds,
minutes, hours, days and Monday; same schedule engine/representation, no new NLP
engine. Model system/tool descriptions explain actual typed condition setup and
warn that task text alone invokes the model per run. Core/background/exposure
suite21/0/0 before the additional English regression. Keep original failed receipts.

### V2 cryptographic audit binding — 24 October, PARTIAL

V4 now uses SAME V2 AuditChain/AuditBind, anchor and bundle implementation.
GoalStore save hooks record actual receipt identities/hashes (including verified
replacements), filtered telemetry stays on the existing ledger allowlist,
explicit approval decisions are chained, and background observation/push status
events store safe identifiers/hashes instead of source bodies or push endpoints.
Boot, new turns and tool dispatch check chain/anchor integrity. Persistence
failure is surfaced as AUDIT_INTEGRITY rather than silently swallowed telemetry.
GET /api/audit requires a paired session; POST initialize/anchor/export also
requires CSRF. No key is silently rotated/generated at server boot. Explicit
local audit initialization enables checkpoints on completed turns and observed
background/push events while that local private key is available. Public export
reuses V2 bundle verification and never copies private key material. The local
audit identity is explicitly NOT a trusted production release signer; no external
TSA/public witness is configured and no existence-in-time proof is claimed.

Fixed genuine V2 anchor hole: a signed old head must match the ACTUAL prefix,
even when a rewritten internally consistent chain contains MORE rows. Previous
logic returned ANCHOR_BEHIND without verifying that signed prefix. New regression
retains real key/signature and rewrites chain+head with a longer forged history;
it now returns ANCHOR_MISMATCH. Existing full-rewrite diagnostic assertion retained.

V2 anchor/bundle + actual V4 audit integration20/0/0. Agent/history/journal/
universal controlled regressions43/0/0. Follow-up audit+agent failures17/0/0
(after surfacing persistence failures); these overlap, do not sum. i18n/check
separate. No live Ghost audit activation claimed. Earlier restart test remains
automatic-review blocked by policy; do not bypass via another process API.
Current running source e45640a; pull of audit source may prepare future startup,
but cannot establish loaded-module/physical acceptance. Continue original parity
(memory sync/self-config/reset/heartbeat/graph/team budgets), actual scenarios,
billing safeguards and signed host/native release gates. Owner requested no more
questions; preserve unverified external/physical gates instead of inventing PASS.

### Audit/analytics compatibility repair — 24 October

Exact e3d458f Linux V4 run40041014388/job120711842638 failed545pass/1fail/7skip
of553. Failure: existing 'a broken ledger cannot take a turn down' contract.
The first audit binding incorrectly made optional analytics-directory creation
fatal. Repaired without relaxing that test: V2 now exports its SAME telemetry
row serializer, reused by the ledger and the mandatory audit binding. Filtered
rows are chained independently of optional analytics writes. Audit-integrity
failures still stop execution; unavailable statistics alone do not. Existing
fixture is extended to assert the actual audit chain still contains goal.finish.
New-head focused results/CI must be observed separately. Runtime remains e45640a,
prepared checkout e3d458f until this follow-up is pulled; activation remains unproven.

### Existing Heartbeat integration — 24 October, PARTIAL

Exact ee80d8596fdecb7db381d08e31acc5ddfce1e614 CI all THREE SUCCESS:
V4 run40041368486, Windows desktop40041368481, runner40041368503. Hosted Windows
packaging/smoke does not establish Ghost native installation or production trust.

Reused core/heartbeat.js; fixed rate-held event loss, non-durable queue/dedup,
clock-zero dedup, internal-wildcard patterns, dry-run consumption and concurrent
send races. Queue IDs/seen/last delivery/failure state are atomically checkpointed
with fsync/private ACLs; corrupt state is retained and refused. A process-exit
regression proves actual reload. New events survive a digest already in flight.
Three failed deliveries pause further attempts until explicit resume. Legacy
heartbeat control is external-tier (it can send configured channels), not read.
Its optional event/action schema is corrected; synthetic previews no longer
insert test events into the real queue or trigger later background notifications.

V4 lifecycle now feeds only actual failed turns and durable pending approvals
into this engine. Resolved approvals are removed even while collection is paused,
so a resumed watcher cannot issue stale warnings. Default delivery is an existing
shared ConversationStore transcript. Push requires explicit notify setting and
registered devices; stable outbox IDs deduplicate recovery and notification links
open the ACTUAL pending task. No model calls are used for digest aggregation.
Authenticated /api/heartbeat exposes counts/state, preview/flush/configure/pause/
resume with CSRF; internal event details and raw task text do not leak in status.
Existing menu adds opt-in and a conditional Resume control; shell14. No hero
suggestions or extra agent engine/store were added.

Controlled core+V4 heartbeat tests14/0/0. Actual Chrome mobile UI control1/0/0,
and existing Chrome mobile-touch plus Chrome/WebKit model selector3/0/0 (no skips).
Agent failure + turn journal27/0/0 before later control refinements. Latest V4
heartbeat3/0/0 after paused-resolution repair. i18n0 in332 shipped files. These
are overlapping controlled suites, not physical iPhone or live Ghost acceptance.

Current Ghost process last activated e45640a; installed checkout prepared ee80d85.
Audit API still404 at last probe, so new modules were NOT claimed active. Earlier
restart test was blocked by automatic review ('blocked by policy'); no alternate
stop/restart API used. Pulling this code prepares future startup, not activation.
All other original parity/real-model/model billing/voice/native release gates
remain in force. Next: owner-configured outbound channels, memory sync, typed
self-configuration/reset and graph/team budgets, plus remaining real scenarios.

### Channel integration and observed Windows regression — 24 October, PARTIAL

88bde65793d3fa75134fdd74312ea40859552204: V4 CI40042737853 and runner40042737881
SUCCESS, Windows desktop40042737849 FAILED (555 pass, 1 fail, 1 skip). Packaging,
native window and cold-start steps were skipped, not passed. The failing browser
assertion captured a real 401: new heartbeat initialization fetched a private API
before pairing. This follow-up binds controls without fetching, refreshes after
authenticated loadState and menu opening, and resets started state on session
expiry. Failed settings can recover after pairing without a reload. Shell15.
Actual local Chrome: explicit unpaired->pair->heartbeat controls regression plus
existing five-viewport acceptance and authenticated controls3/0/0, no skips.

Reused core channel.send and all five existing outbound transports through V4's
same host adapter/approval runner, with a separate opt-in/revocable channels lane.
Config bridge reads only named channels.* scalar keys from the existing config,
honors MAJIN_CONFIG and existing env references, refreshes at call time and never
rewrites credentials or exposes them in capabilities/JSON. Existing configured
webhook URL/secret now actually used by the tool, preserving byte-level HMAC.
Controlled real loopback socket: no delivery before approval, signed message
delivered once, immediate revoke removes tool; missing credentials fail honestly.
Three new tests pass. Combined old channel contracts/wire + new V4 + inventory
24/0/0. Broader host/owner/channel/inventory suite55/0/0 after the new fixture was
corrected to expect registry null instead of undefined. Parse652/652 before the
last browser-only refinement; current i18n0/333. Original23 files unchanged and
all39 restored backup hashes still match at00:10:40Z; no key contents recorded.
No owner messaging account was used and no third-party recipient was contacted.
Ghost activation/account-specific delivery remain open.

Real Go research attempt1 used unchanged glm-5.3-flash, fetched both official RFCs,
wrote/read its own report; structural/source checks PASS. Independent factual
review found misleading storage guarantee wording and a minimum-supported payload
mislabelled as a protocol maximum. Original receipt/artifact retained; review is
genesis-research-attempt-1-review.json; scenario C remains PARTIAL, not full PASS.

Installed checkout prepared88bde65; running process still last activatede45640a.
No source restart was attempted after automatic review blocked it ('blocked by
policy'). Audit/heartbeat/channel module activation is not claimed. Continue
memory-sync, typed self-config/reset, graph resume/replan and token/currency team
budgets, remaining real scenarios, billing/model eligibility, physical voice/push,
and production-signed host/native update/rollback/login. Five old form FAILs are
unchanged. Original scope and NOT READY retained; do not merge PR401.

### Bounded worker completion correction — 24 October, PARTIAL

a698481b7e4260dfb404b8e78d9b20246e6c6c6f pushed and cleanly pulled into the
Ghost installed checkout. V4 CI40043745540 and runner40043745560 SUCCESS at last
observation; Windows desktop40043745578 still in progress. Runtime remains
last activatede45640a; no restart/activation bypass was attempted.

Inspection of the original team/graph parity found another false-success path:
runSubtask exhausted its final allowed model round while the model still asked
for tools, then returned failure=null and a configured rather than actual round
count. It now marks the work incomplete and reports actual rounds. The existing
graph scheduler consequently fails the node and blocks dependents; graph results
preserve the actual worker failure reason instead of only a generic class.
Controlled real HTTP-provider graph regression repeatedly requests a harmless
read, proves exactly three child requests and zero dependent requests, and
asserts failed1/blocked1/done0. Orchestration/recovery8/0/0; broader actual transport
delegation, universal tools, failure and cancellation24/0/0. These are controlled
provider tests, not a second real eligible Go model or complete budget parity.
Token/currency caps and durable graph restart/replanning remain open. Node syntax
checks and i18n0/333 passed. All earlier external and original parity gates remain.

### Canonical separate-store memory synchronization — 24 October, PARTIAL

Exact a0d59eaf97a71166be8e21f61d27cc63791d3a05 CI all THREE SUCCESS observed:
V4 run40044176481, Windows desktop40044176476, runner40044176512. Hosted packaging/
native/cold-start still does not prove production trust or Ghost installation.

Extended the EXISTING src/core/memory-sync.js entry point for V2 MemoryStore
records; no shadow fact store, new scheduler or duplicate agent. Canonical
namespace JSON holds full entries and atomic version/tombstone metadata. All
eight namespaces, keys, full text, tags, importance, at/id and meta are preserved.
Lamport counters provide deterministic conflict resolution: counter, equal-counter
deletion, actor. A re-add after observing a deletion advances beyond its tombstone.
This is not a global wall-clock last-write guarantee. Each store has one writer;
the two-store operation is not a distributed transaction. Interrupted copying
converges on retry without re-versioning imported entries. Retention and clear
emit tombstones. Existing readers refresh atomically replaced files.

New V4 memory_sync reuses MemoryStore and syncPair, defaults to preview, requires
external-tier approval, checks current folder grants and forbids overlapping
stores. Both stores pass strict schema/capacity checks before data writes; corrupt,
cloned and V1 text stores are refused and retained. V1-to-V2 conversion is never
implicit. Namespace files use fsync+atomic rename; tombstones are retained rather
than silently expired. Size/capacity limits fail without discarding entries.
Preview creates neither files, identities nor a missing target directory.

Also repaired the old text protocol's preview identity writes and 500-delta page
acknowledgment bug. Its export now acknowledges only the emitted page, and refuses
missing retained history instead of silently skipping it. Genuine 501-delta/file
regression and legacy memory/context suites21/0/0. Canonical/tool/process/recovery
focused tests9/0/0 before final review refinements; i18n0/335.

Real Go glm-5.3-flash independently chose memory_sync preview, memory_sync actual,
then memory_search; two scoped approvals. Independent files prove bidirectional
preferences, unchanged preview and full project metadata/text. Attempt1 PASS in
genesis-memory-sync-attempt-1.json (12.4 seconds). Test used an isolated host/data
directory on actual Ghost with the EXISTING Go route; no provider or billing
selection change, production process restart or original memory mutation. Receipt
records pre-commit checkout head/dirty flag plus actual tested source hashes;
it deliberately does NOT claim ordinary Ghost runtime activation or phone proof.
Reusable harness scripts/v4/evals/memory-sync.mjs reads owner credentials in memory,
never records them, and closes only its isolated test listener.

Full local V4 regression FINISHED571/0/0 (482 seconds, actual Chrome, no skips),
before the final empty-directory alias identity guard. The guard now canonicalizes
preview paths and rechecks actual identities; a real directory-junction regression
refuses both preview and actual sync before minting IDs. Final focused canonical/
legacy/context24/0/0; canonical suite now10 tests. Real Go attempt2 re-verifies the
final tested source hashes: preview/sync/search PASS, two approvals, 8.1 seconds.
Attempt1 is retained. Full parse655/655 before the tiny guard; final focused run
loads that guard. Original23 source files and all39 restore hashes still match at
00:37Z; no private keys recorded. i18n0/335.

Next: commit/push source+tests+receipts, pull clean installed checkout without
attempting the policy-blocked ordinary host restart, inspect exact-head CI and
continue typed self-config/reset, graph durability/team token-currency limits and
original gates. Newly noticed follow-up: memory_save currently acknowledges saved
even if low-importance retention drops the new entry; require an actual retained
entry before returning saved=true. Do not label ordinary Ghost memory-sync active
or physically accepted merely because the isolated test passed.

### Memory acknowledgment and research follow-up — 24 October

Memory milestone bfc0e25359705b136e58534bf3c7ae2d2ee3effb pushed and cleanly
pulled into the installed checkout; ordinary runtime still last activatede45640a.
V4 CI40045968416 and runner40045968498 SUCCESS; Windows40045968524 in progress at
last observation. New memory_save guard now reads back the actual retained entry
before acknowledging saved=true. A full namespace of higher-priority entries can
drop a new entry under the existing retention policy; that case now fails honestly
instead of reporting a saved memory. Final canonical/memory/context tests26/0/0
(canonical file now11 cases). No broader suite was unnecessarily repeated for
this small follow-up; exact follow-up CI must be observed separately.

Research harness now accepts optional --review feedback and the actual Go model
reread both primary RFCs and produced a new artifact. Attempt2 structurally PASS
and corrected both supplied findings, but independent primary-text review found
a new inaccurate key-agreement/TTL explanation. Scenario C remains PARTIAL;
genesis-research-attempt-2-review.json records the exact finding. Do not turn the
structural passed flag into factual acceptance. Next engineering work remains
typed V4 self-config/reset, durable graph resume/replan and token/currency budgets;
then remaining real scenarios and original physical/production acceptance gates.

### Latest execution checkpoint — NOT READY

See [FINAL_EXECUTION_20261024.md](FINAL_EXECUTION_20261024.md) for current tests, real Go form failures, Windows CI failure/root fix and the complete remaining gates. Earlier aggregate claims do not supersede this checkpoint. No original requirement is waived.

## Current round 2 form gate (24 October)

PR401 is merged at704de63. Follow-up branch codex/v4-form-autonomy-20261024 now independently passes three distinct real Go safe forms plus the unchanged original failure fixture. Actual server acceptance, requested values, exact file hashes, saved receipts, model rounds, token telemetry and source hashes are preserved in FORM_AUTONOMY_ROUND2.md and evidence/form-autonomy-audit-attempt-3.json. Earlier failed attempts remain. This is a scoped controlled form gate, not universal browser or release READY. Ordinary Ghost activation remains unproven. Mandatory self-improving skill acquisition, host restart/retrieval/adaptation evidence and every original parity/release gate remain in FORM_AND_LEARNING_ACCEPTANCE.md.

## Immediate owner-requested handover

Read HANDOVER_NOW_20261024.md first. Final real Go attempt4 again passes all three new safe forms and the original regression; evidence/form-autonomy-audit-attempt-4.json rechecks server/artifact/source/token evidence. The follow-up fixes CI prompt-size overflow; local memory/cancellation9/9. Previous1b2fc85 CI failed prompt size plus a Linux browser-startup flake; new exact-head CI must be checked before merge. New local installer rebuild failed spawn UNKNOWN; the older delivered473eb45 EXE is not this code. Mandatory learned-skill acquisition is NOT implemented/verified; every original deployment, parity, physical and signing gate remains. Owner requested transfer to another developer; freeze new engineering work and use the concise handover.
