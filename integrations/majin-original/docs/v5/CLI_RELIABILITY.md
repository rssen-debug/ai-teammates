# CLI long-running tasks and context cost

The local CLI uses a native HTTP request for goal execution, with no fetch
response-header deadline. A disconnected request is never automatically retried:
the running task may already have submitted a form. Inspect saved state first.
This removes one timeout failure mode; it does not prevent provider/network outages.

Provider requests now default to an 80,000-character context budget including
tool schemas, capped by the selected model's usable context. `--context-chars`
can override the default. Older atomic tool turns are replaced with a checkpoint
in outgoing requests only; the complete conversation remains on disk. Mandatory
instructions/current turns can exceed the budget and are reported as overBudget.
This is a character target, not a token guarantee or a reduction in tool access.

PARTIAL browser work keeps the existing driver and filled page for follow-up
within the same host. Shutdown and access configuration changes still close it.
Completed goals retain their existing cleanup behavior. Browser visibility is
owner-controlled; the execution trace now shows the effective headless setting.

An empty fs_list path lists the workspace. Explicit paths still pass the same
owner folder checks. No application is considered submitted merely because a
form was filled or a tool call succeeded; independently checked portal receipt
criteria remain necessary for a verified COMPLETED result.
