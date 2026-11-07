# V6 durable backlog

Status vocabulary: TODO / IN_PROGRESS / BLOCKED / DONE / WONTFIX (with reason).
Do not mark an item DONE without a reproducible check.

| # | Task | Status | Notes / exit criterion |
| --- | --- | --- | --- |
| 1 | V6 core: queue, supervisor, heartbeat, watchdog, budgets | DONE | `npm run v6:test` (48 tests); live worker test writes a real file |
| 2 | MCP bridge over V5 driver with discovery, schemas, operation IDs | DONE | Live MCP test: `fs_read`, receipt replay, lane denial |
| 3 | Jobs: dedupe, candidates, exclusions, state machine, receipts | DONE | Fixture tests; Atea/Gigstep/Poolia enforced |
| 4 | Gmail read-only client and classification | DONE (unit) | Live account NOT_TESTED |
| 5 | Local report and event log | DONE | Report derived only from state |
| 6 | Private sync with privacy gate and private-repo check | DONE (dry run) | Live upload BLOCKED (no token) |
| 7 | Windows launcher + opt-in OpenCode registration | DONE (static) | Execution on Windows NOT_TESTED |
| 8 | Run doctor/launcher on the real Windows host and attach output | TODO | Requires `C:\MAJINCLI` + V5 profile |
| 9 | Register MCP in OpenCode and verify `majin_status` + one tool call from OpenCode CLI with the existing DeepSeek model | TODO | Blocked: OpenCode not present in sandbox |
| 10 | Verify real Gmail OAuth read-only against a controlled message | TODO | Blocked: owner credentials |
| 11 | Build an owner-approved submission adapter against a test endpoint | TODO | Must produce a real acknowledgement, never auto-click production |
| 12 | Browser acceptance: navigation, upload, origin permission, blocker isolation | TODO | No browser binary here; use Windows/Edge |
| 13 | Memory/skills migration (V1–V5 → V6) with conflict handling | TODO | Not started; do not merge silently |
| 14 | Self-repair development workflow with isolated worktrees | TODO | Not started |
| 15 | Multi-worker browser context isolation | TODO | Today workers share the queue only |
| 16 | Scheduled private sync (owner opted in) | TODO | Only after live Gmail/job evidence is stable |
| 17 | Rate-limit/retry policy tuning against real providers | TODO | Current bounded exponential backoff is generic |

## Known defects

- `job.evaluate` scores only extractable text; scanned CVs score 0/unscorable.
- Gmail heuristics may miss unusual ATS senders; no manual override yet.
- Parallel workers use separate driver state directories; duplicate prevention
  for irreversible work relies on the queue effect ledger.
- `v6_work_start` allows up to four live workers; there is no fairness scheduler
  beyond priority.
- The launcher's PowerShell execution is unverified on Windows.
- The release-gate/i18n policies required markers on Swedish Gmail input
  vocabulary; those are input-only strings, never rendered.

## Resume procedure

State is durable. To resume after any interruption:

```bash
node bin/majin-v6.mjs status
node bin/majin-v6.mjs queue list
node bin/majin-v6.mjs worker --max-tasks 10 --max-runtime-ms 900000
```

Never convert `UNCERTAIN` work to `QUEUED` without inspecting the external
outcome. `queue retry` refuses it on purpose.
