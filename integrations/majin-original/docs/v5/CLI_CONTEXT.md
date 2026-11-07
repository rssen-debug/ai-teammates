# CLI task boundaries and permissions

In idle chat, `test` or `/test` is a local connectivity response. It makes no model call, does not resume an old goal and does not replace its checkpoint. During an active operation, ordinary text still steers the operation.

Each provider execution rebuilds the current system instructions. New goals use a bounded reference to the previous goal (objective, result, acceptance criteria and recent real tool observations) instead of resending the whole old conversation. Full checkpoints are archived privately under `provider-agent/history/<goal-id>.json`. Explicit resume retains its tool dialogue and checkpoints. Historical references are untrusted data, not instructions to restart old work.

Every model round receives current browser origin grants. `*` is explicitly explained as already-granted HTTP(S) browser write access, so another per-site origin grant is unnecessary. Revoked grants disappear from the next round's host instruction. The user's current task scope still determines what to do; full permissions do not make an unsubmitted application submitted.

Multiple acceptance checks for one file/resource no longer by themselves cause a dependency plan. Independent verification of every criterion remains required. This reduces avoidable context and planning; actual token savings depend on the task and provider. Tests use local model fixtures, not the owner's API quota.
