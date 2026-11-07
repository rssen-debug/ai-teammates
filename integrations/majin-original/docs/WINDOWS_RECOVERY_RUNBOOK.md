# MAJIN Windows recovery runbook (W11, 2026-10-20)

For when something goes sideways on the installed app. Every step here is
real functionality — dry-run first, nothing is silently removed.

## Prinsipp: plan → verify token → apply

```
reset.plan({})                       // measures only — touches nothing
reset.apply({confirmToken: "<from the plan>"})
```

The token binds the measured file set. If anything changed on disk between
the two calls, the apply refuses with `token_mismatch` and you re-run the
plan. Sessions, memory, and config.json are NEVER inside a recovery kind —
recovering those is a manual, deliberate act (back them up first).

## Known failure modes → actual recovery

| Symptom | What happened | Recovery |
| --- | --- | --- |
| Disk full in `workspace/exec` | old exec runs (`exec.backends/start`) accumulate artifacts | `reset.plan({types:"exec-artifacts"})` → inspect → `reset.apply` with the returned token |
| App sluggish after long uptime | temp spill/cache > 48h | `reset.plan({types:"temp-spill"})` → apply |
| Flows/heartbeat alarms stale | queue history from older crashes | `reset.plan({types:"stale-flow-state"})` → apply (indices stay) |
| A stuck approval blocks a chat | approval pending past its TTL | the ApprovalWatch auto-transitions to `timed_out`; run `majin.heartbeat({action:"status"})` to confirm the transition was logged |
| A mission must resume after crash | checkpoints under `missions/<id>` | resume runs the carried verified nodes only — see mission-checkpoint design; do NOT delete missions state unless the goal changed |
| Config corrupted (won't boot) | `config.json` invalid JSON | DO NOT delete. Copy `config.json` to `config.json.broken`, then start the app once to regenerate defaults, re-enter provider keys |
| Cursor overlay stays after abort | overlay PS1 process orphaned | `cursor.overlay({op:"quit"})` or kill `powershell` hosting `pink-cursor.ps1` |
| `chokidar` watcher leaks handles | a flow was removed while watching | `flows.remove({id:"…"})` stops watchers via `TriggerHub.stopFileTrigger` |

## NEVER

- Never delete the `sessions/` dir to "fix" chat oddities (use the chat
  delete action; it removes only that chat's files with title confirmation).
- Never delete `memory/` or the chat index to "speed things up".
- Never retry a delete with a guessed token when `token_mismatch` fires —
  re-plan to see the truth.
