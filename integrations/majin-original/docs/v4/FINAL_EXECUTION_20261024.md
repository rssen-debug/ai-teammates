# Final execution checkpoint — NOT READY

The requested complete product has not passed acceptance. No requirement is waived,
and PR401 remains draft and unmerged. This checkpoint supersedes older aggregate
claims where they conflict; the complete original requirements remain in
FINAL_RELEASE_REPORT.md, FINAL_FEATURE_PARITY.md and HANDOVER_CONTINUE.md.

## Changes in this execution

- Match the memory-sync root resolver to Windows native path normalization,
  including overlap/alias rejection before any store identity or data write.
- Browser observations report bounded, value-hidden native field validity.
  Observation does not dispatch validation events. Post-click output distinguishes
  a dispatched action from a verified submission.
- A no-op select fill no longer dispatches change/input, preserving dependent
  fields. Real DOM regression verifies this and native validation/privacy.
- Controlled real-model receipts now retain tool input/result traces for diagnosis.
  These traces concern generated local fixture data only.

## Evidence

- Focused real DOM/select/memory tests: 13 passed, zero failed/skipped.
- Browser suite: 124 passed, zero failed, four skipped (128 total).
- Parse: 656/656; i18n: zero stray Swedish literals in 335 files.
- Real Go form attempts 6 and 7: FAIL, 12-round budget exhausted.
- Attempt 8: FAIL, bounded evaluation approval budget exhausted, even with a
  separately declared 24-round/32-call ceiling. One actual multipart submission
  reached the expected server-side validation challenge, with the generated upload;
  no accepted registration or saved verified receipt. This is progress evidence,
  not acceptance. Earlier failures remain. All hosts were isolated disposable
  Ghost test instances; the selected Go provider/model was unchanged.
- Original config/key/pairing/data preservation: 23 checked files unchanged;
  39 restored backup hashes match. No scraper or personal-data cleanup was run.
- Previous pushed head 52d5d04: V4 CI and runner passed; Windows CI failed its
  overlap-path assertion (571 passed, one failed, one skipped). Packaging/native
  and cold-start stages were skipped on that head. This execution fixes that
  assertion's path handling; the new head needs its own CI results.

## Mandatory remaining gates

1. Complete autonomous forms, factual research correction, real desktop execution,
   durable orchestration restart/replan, complete physical mobile execution and
   two eligible model routing/billing acceptance. No claim of universal success.
2. Verify account eligibility/Extra Usage protection; model catalogue is not proof.
3. Actual locked-iPhone push receipt/opening (zero subscriptions at last check),
   speech interruption, explicit 5G reconnect and Ghost microphone/playback.
4. Activate prepared audit/heartbeat/channels/memory-sync in the ordinary Ghost
   process. Last activated runtime e45640a; prepared source is newer. Audit and
   heartbeat endpoints still returned 404 at the last ordinary-host audit.
   Relevant real channel accounts and external audit witness remain unverified.
5. Typed self-configuration/reset, durable graphs, team token/currency budgets,
   remaining OCR/preview/DPI parity. Legacy reset guards are not accepted as safe.
6. Memory backup/restore must preserve sync versions/deletion tombstones and
   preflight memory before any restore writes. Existing export/restore was found
   to omit tombstones/replay put; this execution does not claim that gap repaired.
7. Approved production signing identity/channel, trusted native Ghost installation,
   login startup, actual automatic host/app update activation and rollback.
8. Exact new-head CI and the full original acceptance/release chain.

Automatic review rejected the previously planned ordinary-host child restart with
“blocked by policy.” It has not been bypassed. Prepared source and isolated tests
are not ordinary-host activation evidence; unsigned packages are not trusted releases.

## Final local suite result

Full V4: 574 tests, 567 passed, zero failed, seven skipped. Skips are the
Playwright Chromium-dependent phone/e2e, heartbeat (two), touch, selector and
voice (two) cases: the pinned headless-shell executable is absent. Actual installed
Chrome DOM tests above did run. Skipped physical/mobile gates are not accepted.
The diagnostic trace retention refinement was syntax-checked after these runs;
it preserves events when evaluation throws instead of discarding partial traces.

## Current round 2 form gate (24 October)

PR401 is merged at704de63. Follow-up branch codex/v4-form-autonomy-20261024 now independently passes three distinct real Go safe forms plus the unchanged original failure fixture. Actual server acceptance, requested values, exact file hashes, saved receipts, model rounds, token telemetry and source hashes are preserved in FORM_AUTONOMY_ROUND2.md and evidence/form-autonomy-audit-attempt-3.json. Earlier failed attempts remain. This is a scoped controlled form gate, not universal browser or release READY. Ordinary Ghost activation remains unproven. Mandatory self-improving skill acquisition, host restart/retrieval/adaptation evidence and every original parity/release gate remain in FORM_AND_LEARNING_ACCEPTANCE.md.
