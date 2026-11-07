# ROUND 2/8 — form autonomy acceptance

**Status: PASS for three controlled safe sites and the original regression only.**
**Full V4 release: NOT READY. Learned-skill acquisition: not yet verified.**

Base: actual v4/main merge 704de6320341993adb50303b8e11e646cca64710.
Branch: codex/v4-form-autonomy-20261024. PR401 was already merged; no merged
history is rewritten. No ordinary Ghost restart or production activation occurred.

## General repairs

The existing V1 CDP browser now offers compact semantic form observations and
type-aware batches through V4's existing registry/approvals. Labels, ARIA names,
types, dropdown options, constraints, visible errors and next/submit buttons are
observed from the live page, without echoing field contents. No site-specific
selectors, field names or action sequences are embedded in product code.

Opening a form supplies the useful observation immediately. Batches reobserve
between fields, bind to the same document, detect ambiguous/changed identities,
semantically reground replacements and verify retention. A reverted text field
gets one different native CDP keyboard strategy, then stops on failure. Checkbox,
radio, select and file operations remain type-specific. Exact selected file bytes
are SHA-256 compared to the workspace source, with a bounded 32 MiB limit.
Next/submit clicks are separately grounded and never automatically repeated.
Current form/errors/page text are returned for model-directed recovery. Password,
OTP and visible CAPTCHA require owner handoff. Existing approval gates remain.

The V4 adapter no longer inserts an invalid null into optional string summaries,
and now preserves parameter descriptions. Recovery summaries expose only bounded
counts/strategy enums. A real bridge regression catches the previously hidden
observation schema failure.

Execution remains bounded: 12 model rounds, 24 tool calls, 16 scoped approvals;
batch maximum 12 fields, one alternative input strategy, stop on a failed field,
and evaluation cancellation after three identical failed tool calls. Round limits
were not multiplied; earlier attempt8 had a 24-round ceiling and still failed.
The remaining malformed/low-level calls are retained in receipts rather than hidden.

## Genuine Go acceptance — final attempt 3

Existing route: opencode-go/glm-5.3-flash through the already configured Go endpoint;
no alternative provider, paid fallback or global credential change. Tests use
isolated disposable Ghost homes and actual installed Chrome. They do not activate
the ordinary source host, and do not use the owner's Chrome cookies/profile.

| Fixture | Independent result | Model rounds | Tool results | Failed calls recovered |
|---|---|---:|---:|---:|
| A: dynamic category/conditional fields/dropdowns; trusted native input | PASS | 10 | 9 | 2 |
| B: three-step wizard, checkbox validation and upload | PASS | 11 | 10 | 1 |
| C: intentional server 422, added review field/reupload/resubmit | PASS | 10 | 9 | 2 |
| Original dynamic Team form with server challenge/replaced fields | PASS | 11 | 11 | 2 |

Every final case has one independently server-accepted registration, all requested
values, exact received file SHA-256, an unpredictable actual receipt saved and
read back, unchanged genuine Go route, and no denied/out-of-scope action. Server
handlers and CSP limit submissions to the generated safe loopback fixture. Product
tools choose all fields/actions; the harness provides goals, not selectors/plans.
The original fixture is unchanged. No canned model or mocked success is used.

See [final post-run audit](evidence/form-autonomy-audit-attempt-3.json): it rechecks
actual disposable workspace receipt/upload bytes, accepted server evidence,
current critical source hashes and independently recorded per-goal model telemetry.
A records an actual native_type_retry recovery in the tool event stream.
Reported provider tokens: A 61,476; B 67,064; C 64,980; original 80,711.
Currency cost is unknown; token telemetry is not an account billing receipt.

## History and limits

All original failures1–8 remain. New attempt1 failed all four sites, exposing the
adapter null-summary bug and mixed legacy click arguments. Attempt2 passed the
three new sites but failed the original on old low-level calls/round exhaustion.
Attempt3 follows a real general observation repair and passes all four.

The first post-run attempt2 audit incorrectly included adjacent-task model calls
with a fuzzy timestamp margin. It is retained; the `-corrected` audit selects
actual goal.start ledger segments and supersedes those accounting failures.
Attempt2's current-source mismatch is expected: later repairs changed source.
Final attempt3's source hashes match all listed runtime/evaluation files.

Final targeted DOM/bridge/host/orchestration tests33/33; agent/universal18/18.
Browser/exposure suite132 passed, zero failed, four skipped. These scopes overlap;
they are not added into a fictitious full-suite count. Full exact-head CI must be
observed on the new PR before merge. Physical iPhone acceptance is separate.

This gate does not establish arbitrary-site, shadow-DOM/cross-origin-frame or
universal browser reliability. Remaining priority is the mandatory verified learned
skill workflow (including actual test-host restart and changed related task), then
the other original gates. See FORM_AND_LEARNING_ACCEPTANCE.md for the complete
requirements; signing, native deployment, mobile voice/push, parity and safe
backup/reset/update remain mandatory and have not been removed.

## Immediate owner-requested handover

Read HANDOVER_NOW_20261024.md first. Final real Go attempt4 again passes all three new safe forms and the original regression; evidence/form-autonomy-audit-attempt-4.json rechecks server/artifact/source/token evidence. The follow-up fixes CI prompt-size overflow; local memory/cancellation9/9. Previous1b2fc85 CI failed prompt size plus a Linux browser-startup flake; new exact-head CI must be checked before merge. New local installer rebuild failed spawn UNKNOWN; the older delivered473eb45 EXE is not this code. Mandatory learned-skill acquisition is NOT implemented/verified; every original deployment, parity, physical and signing gate remains. Owner requested transfer to another developer; freeze new engineering work and use the concise handover.
