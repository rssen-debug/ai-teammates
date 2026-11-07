# Batch submission receipts and recovery

The deterministic JobApplicationWorkflow requires an actual portal adapter to
submit. Without it the application is prepared and reports
PORTAL_ADAPTER_REQUIRED, with zero submitted/confirmed counts. It never creates
a synthetic confirmation. This is separate from provider-driven browser work.

Before calling submitApplication, the workflow persists a pending intent under
the job/CV idempotency key. A thrown error or process interruption leaves an
uncertain outcome. Resuming that item cannot repeat the submit unless the portal
adapter definitively verifies no prior submission:
`{ alreadySubmitted: false, definitive: true }`.

An already-submitted unconfirmed item is not resubmitted. A positive new receipt
requires submitted=true, confirmed=true, a confirmationId and
cvSha256Match=true. Missing CV verification does not count as confirmation.
Prior-submission confirmation additionally requires a verified receipt with
the expected CV hash. Adapter evidence must come from the actual portal.

Failures, blockers and unconfirmed submissions leave the batch PARTIAL.
No new permissions are required by these changes. They prevent invented success
and duplicate external actions; they do not turn every job portal into a
supported adapter or retroactively certify old records.
