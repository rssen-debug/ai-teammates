# MAJIN V6 — OpenCode integration handover

This is the engineering handover for the V6 orchestration layer. It records
what actually runs, what was measured, and what remains blocked.

OpenCode CLI remains the only interactive AI interface. V6 adds:

- an MCP bridge over the existing MAJIN V5 deterministic driver;
- a durable queue, supervisor, heartbeat and watchdog;
- job-hunter state, candidate separation and evidence rules;
- read-only Gmail verification;
- a structured local event log, status report and optional private sync;
- a Windows launcher and an opt-in OpenCode MCP registration script.

It does **not** add a GUI, EXE, Electron app or a second model runtime.

## 1. Baseline and isolation

| Item | Value |
| --- | --- |
| Source repository | `rssen-debug/MAJINCLI` |
| Checkout commit used for this work | `ea439ec89aeee430d70f7f3afc91a11c4cbec8a2` (`main`) |
| Development branch | `arena/abdefe02-majincli` |
| Reference tag created | `v6-reference-checkout-ea439ec-20261027` |
| Pre-change bundle | `.majin-v6-safety/pre-v6.bundle` (tag-anchored; not committed, excluded by `.majin-*/`) |
| PR #478 head observed | `a47999da38a0d32bf73ff67ea2ee95d7c3819027` (open, not merged) |
| V6 runtime home | `%LOCALAPPDATA%\MAJIN\v6` (or `MAJIN_V6_HOME`) |
| V5 data directory | read-only input for `owner-mode.json`; V6 refuses to adopt or write it |

**Important:** no commit has been labelled "Windows known-working". This work
was performed in a Linux sandbox with no access to `C:\MAJINCLI`, the installed
OpenCode binary, or the owner's V5 profile. The tag above is only an immutable
by-convention reference to the pre-change checkout. Windows acceptance is
listed as `NOT_TESTED` in `docs/v6/ACCEPTANCE.md`.

V6 refuses to start if its home is the V5 data directory or is nested inside it
(`V6_HOME_CONFLICT`). V6 writes driver state under its own home, not into V5.

## 2. Entry points

```bash
node bin/majin-v6.mjs doctor          # environment + readiness, no writes outside V6
node bin/majin-v6.mjs status          # real persisted state
node bin/majin-v6.mjs mcp --workspace . --data-dir <v5> --v6-home <v6>
node bin/majin-v6.mjs worker --max-tasks 10 --max-runtime-ms 900000
node bin/majin-v6.mjs inventory --deep --history --write
```

npm aliases: `npm run v6:doctor`, `v6:status`, `v6:mcp`, `v6:worker`,
`v6:inventory`, `v6:test`.

PowerShell (see `docs/v6/OPERATIONS.md` for full detail):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\v6\start-v6.ps1 -Action Doctor
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\v6\register-opencode-mcp.ps1            # dry run
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\v6\register-opencode-mcp.ps1 -Apply     # opt-in
```

The registration script backs up the existing OpenCode config, preserves all
other keys, adds only `mcp.majin`, verifies the result, and restores the backup
on failure. JSONC configs are refused rather than rewritten. OpenCode's default
5 s MCP timeout is too short for browser work; the generated entry sets 300 s.

## 3. What was verified, and how

| Area | Status | Evidence |
| --- | --- | --- |
| Real MCP handshake and tool execution | **PASS** (Linux) | `test/v6/mcp-live.test.js` spawns the actual bridge, initializes MCP, searches the real catalog, calls `fs_read`, checks the persisted receipt and idempotent replay, and confirms an ungranted lane is denied |
| Durable worker executing a queued tool | **PASS** (Linux) | `test/v6/worker-live.test.js` runs the real worker CLI, calls `fs_write` through the V5 driver, verifies the file, receipt, heartbeat and restart-without-replay |
| Queue durability, dependencies, effect ledger | **PASS** | `test/v6/queue.test.js` |
| Multi-worker claim safety, stall watchdog, budgets, auto-continuation | **PASS** | `test/v6/supervisor.test.js` |
| Job states, exclusions, dedupe, approval policy, receipt rules, email matching | **PASS** | `test/v6/jobs.test.js` |
| Read-only Gmail client, classification, OAuth failure typing, privacy | **PASS with fixtures** | `test/v6/gmail.test.js`; live Google account `NOT_TESTED` |
| Private-sync privacy gate and private-repo check | **PASS with mock transport** | `test/v6/privacy.test.js`; live repository upload `NOT_TESTED` |
| Local report from real state | **PASS** | `test/v6/report.test.js` |
| Launcher and registration safety | **PASS (static)**; PowerShell execution `NOT_TESTED` | `test/v6/launcher.test.js`; `pwsh` is unavailable in this environment |
| OpenCode CLI + DeepSeek live | **NOT_TESTED** | No OpenCode binary, config or model account in this sandbox |
| Windows behaviour | **NOT_TESTED** | Linux sandbox; run the launcher on the target machine |
| Employer-portal submission | **NOT_IMPLEMENTED** | Deliberate: only an owner-provided adapter may submit; otherwise the task is BLOCKED |
| Real Gmail OAuth | **BLOCKED** | No owner credentials here; the client never fabricates access |
| Private telemetry upload | **BLOCKED** | No owner token here; dry-run/refusal paths are tested |
| Browser automation | **BLOCKED on this host** | No browser binary; the inventory reports the real reason |

Full test results are in `docs/v6/ACCEPTANCE.md`. Run `npm run v6:test` to
reproduce the V6 suite and `npm test` for the repository suite.

## 4. Components

| File | Responsibility |
| --- | --- |
| `src/v6/bridge.js` | Authorized MCP-facing tools over `CodexDriver`; live grant reload; V5 isolation |
| `src/v6/policy.js` | Lane mapping, authorization, catalog filtering |
| `src/v6/mcp.js` | JSON-RPC 2.0 MCP server, progress notifications, cancellation, durable-work tools |
| `src/v6/queue.js` | Atomic JSON queue, leases, retries, effects ledger, dependency cascade |
| `src/v6/supervisor.js` | Bounded claim/execute loop, heartbeat, watchdog, budgets, blocker isolation |
| `src/v6/worker-state.js` | External heartbeat file with PID-aware health |
| `src/v6/handlers.js` | Task handlers (`tool`, `health.delay`, job discovery/evaluation/submission gate, Gmail verify) |
| `src/v6/tool-invoker.js` | Converts driver receipts/uncertainty into structured task outcomes |
| `src/v6/jobs/state.js` | Strict application state machine with evidence requirements |
| `src/v6/jobs/store.js` | Durable applications, canonical URLs, candidate profiles, eligibility |
| `src/v6/jobs/hunter.js` | Discovery → match → approval → preparation → receipt → email confirmation |
| `src/v6/gmail.js` | OAuth2 refresh-token client, read-only search, classification, matching |
| `src/v6/events.js` | Append-only JSONL events with rotation |
| `src/v6/redact.js` | Event scrubbing and hard sync privacy gate |
| `src/v6/report.js` | Local status report from persisted state |
| `src/v6/sync.js` | GitHub REST private-sync without `gh` |
| `src/v6/inventory.js` | Calculated V1–V5/MCP inventory |
| `src/v6/cli.js`, `bin/majin-v6.mjs` | Commands, worker startup, MCP stdio loop |

### Task kinds the worker can execute today

- `tool` — call one discovered MAJIN tool with `{tool, arguments}`.
- `health.delay` — bounded delay, used for probes and tests.
- `job.discover` — Platsbanken search with dedupe and exclusions (requires a
  candidate profile; network).
- `job.evaluate` — deterministic CV scoring against the stored listing.
- `job.submit` — always **BLOCKED** unless an owner-provided submit adapter is
  wired in. There is deliberately no built-in clicker.
- `gmail.verify` — read-only verification email check for one application.

## 5. Safety model

- **Owner grants are the boundary.** V6 reads the existing `owner-mode.json`
  live and rebuilds the driver when grants change, so revocation and additions
  apply without restarting OpenCode. It never writes grants.
- **Operation IDs.** Every bridge tool call requires a stable `operationId`; the
  V5 driver rejects a reused ID with different arguments and returns the prior
  receipt for identical arguments.
- **Irreversible work.** Tasks marked `irreversible` get an effect key. Only one
  task may own an effect; a completed effect is never executed again. A worker
  crash during an irreversible task becomes `UNCERTAIN`, never a retry.
- **No uncertain retry escape hatch.** `requeue` refuses `UNCERTAIN`;
  `resolveUncertain` requires owner evidence.
- **Submission evidence.** `SUBMITTED_UNCONFIRMED` requires a concrete
  acknowledgement (reference, URL, evidence path or text). A click or HTTP 200
  is not accepted. `CONFIRMED_RECEIVED` requires a portal ID or matched email
  plus a timestamp.
- **Budgets.** Task count, runtime and per-task tool calls are bounded. `STOP`
  stops workers after the current task.
- **No self-modification.** V6 does not edit its own executable, permissions or
  OpenCode configuration. The registration step is a separate owner-run script.

## 6. Candidate profiles

Profiles live at `<v6-home>/jobs/profiles.json` and are read-only to V6. The
schema is `majin.v6.profiles/v1`:

```json
{
  "schema": "majin.v6.profiles/v1",
  "candidates": [
    {
      "id": "it-candidate",
      "displayName": "Owner IT candidate",
      "cvPath": "C:\\MAJIN\\private\\cv.pdf",
      "contactEmail": "owner@example.com",
      "gmailAccount": "owner@example.com",
      "exclusions": {
        "companies": ["Atea", "Gigstep", "Poolia"],
        "roles": ["säljare"],
        "locations": ["Kiruna"],
        "salaryMin": 40000
      },
      "rules": { "locationsAllow": ["stockholm", "remote"], "minScore": 0.5 },
      "approval": { "policy": "allow-list", "authorizedCompanies": ["Acme"] },
      "quotas": { "maxPerDay": 3, "maxApplicationsPerRun": 2 }
    }
  ]
}
```

V6 never invents a profile; `doctor` reports `PROFILES_MISSING` until the owner
creates one. Exclusions such as Atea, Gigstep and Poolia are enforced per
candidate, including in mixed searches.

Approval: with `policy: "allow-list"` a matched job at an authorized company
moves to `APPROVED` with a policy reference. With `owner-review` nothing is
approved automatically; the owner uses `majin-v6 jobs approve --id ... --ref ...`.

## 7. Gmail

Read-only scope only (`gmail.readonly`). Credentials come from an owner-only
file at `<v6-home>/secrets/gmail.json` (mode 600) or the
`MAJIN_V6_GMAIL_CLIENT_*` / `MAJIN_V6_GMAIL_REFRESH_TOKEN` environment variables.
The client:

- distinguishes marketing mail, verification requests and confirmations;
- matches an email to an application by employer and role;
- records the message ID and timestamp as evidence;
- never follows a verification link, marks read, sends or deletes anything;
- stores no message body in events or telemetry.

Owner steps that remain explicit: CAPTCHA, MFA and any action on a verification
link. A pending verification is reported as `EMAIL_VERIFICATION_PENDING`, not
as success.

## 8. Private telemetry

Local events stay in `<v6-home>/events/events.jsonl`. Optional sync targets the
private repository only and refuses to upload unless GitHub answers
`private: true`. See `docs/v6/PRIVATE_TELEMETRY.md` for the exact field list.
There is no `gh` dependency.

## 9. Known limitations

1. No OpenCode process was available here, so its session/model integration and
   the 300 s timeout behaviour are **NOT_TESTED**.
2. No Windows host was available: paths, Edge/Chrome, PowerShell execution and
   scheduled workers are **NOT_TESTED**.
3. Parallel workers each own a separate driver state directory under
   `<v6-home>/drivers/`. Cross-process duplicate protection for irreversible
   work comes from the queue's effect ledger, not from the driver's per-process
   operation ledger.
4. `job.submit` has no built-in portal implementation. This is intentional and
   must not be described as working until an adapter is configured and tested
   against an authorized test application.
5. Gmail classification is heuristic and fixture-tested only; real inbox
   validation is required before relying on it.
6. `job.evaluate` depends on the existing document extractor for PDF/DOCX CVs;
   scanned image-only CVs will not score.
7. The inventory's historical count is a lower bound from `name:` declarations
   in git history (currently 176 unique declarations); it is not "all versions
   ever registered".
8. OpenCode's model identity and token usage are not visible to MAJIN. The
   report says so instead of guessing.

## 10. Continuing the work

The durable backlog is `docs/v6/BACKLOG.md`. The next tasks, in order:

1. Run `start-v6.ps1 -Action Doctor` on the target Windows machine and attach
   the real output.
2. Register the MCP server with a backup; verify `majin_status` and one real
   tool call from OpenCode CLI.
3. Configure a test Gmail account and run `majin-v6 jobs verify` against a
   controlled message.
4. Build and test an owner-approved submission adapter against a test endpoint.
5. Only then consider invoking real applications, with quotas and receipts.

If a session ends, no work is lost: the queue, profiles, events and receipts
are on disk. Start the worker again with the same `--v6-home`.
