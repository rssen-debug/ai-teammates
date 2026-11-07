# V6 operations

Everything here is local. V6 never installs software, changes OpenCode's model
choice or edits OpenCode settings automatically.

## Paths

| Purpose | Default |
| --- | --- |
| V6 home | `%LOCALAPPDATA%\MAJIN\v6` or `$XDG_DATA_HOME/MAJIN/v6` |
| Queue | `<v6>\queue\queue.json` |
| Events | `<v6>\events\events.jsonl` |
| Workers | `<v6>\workers\<workerId>.json` |
| Jobs | `<v6>\jobs\applications.json` |
| Profiles (owner-authored) | `<v6>\jobs\profiles.json` |
| Reports | `<v6>\reports\` |
| Gmail credentials (owner only) | `<v6>\secrets\gmail.json` |
| Sync token (owner only) | `<v6>\secrets\github-token` |
| V5 grants (read-only) | `<v5>\owner-mode.json` |

`MAJIN_V6_HOME`, `MAJIN_V5_DATA_DIR` and `--v6-home` / `--data-dir` override the
defaults. V6 refuses to run if its home is the V5 data directory or inside it.

## First run on Windows

```powershell
cd <MAJINCLI checkout>
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\v6\start-v6.ps1 -Action Doctor
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\v6\start-v6.ps1 -Action Config   # print MCP JSON
```

Important expectations:

- `BLOCKED` for the V5 data directory means the path is wrong or MAJIN V5 has
  never run. V6 will not create that profile for you.
- `BLOCKED` for Gmail/sync simply means no owner credentials are present.
- `NOT_TESTED` for Windows/OpenCode lines means exactly that; the launcher ran
  on Linux during development.

### Connect OpenCode (opt-in, backed up)

```powershell
# dry run: prints the proposed mcp.majin entry, writes nothing
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\v6\register-opencode-mcp.ps1

# apply after reviewing: backs up, writes, re-parses, restores on failure
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\v6\register-opencode-mcp.ps1 -Apply
```

Restart OpenCode afterwards. Existing sessions keep their old tool list.

The entry is equivalent to:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "majin": {
      "type": "local",
      "command": ["node", "<repo>\\bin\\majin-v6.mjs", "mcp",
                  "--workspace", "<workspace>", "--data-dir", "<v5>", "--v6-home", "<v6>"],
      "enabled": true,
      "timeout": 300000,
      "environment": { "MAJIN_V6_HOME": "<v6>" }
    }
  }
}
```

OpenCode's default MCP timeout is 5 seconds. Browser and job operations exceed
that; keep the explicit 300000 ms unless you have measured your own workload.

## Commands

```text
majin-v6 doctor [--json]
majin-v6 status [--json]
majin-v6 mcp --workspace <dir> [--data-dir <v5>] [--v6-home <v6>]

majin-v6 worker [--max-tasks N] [--max-runtime-ms N] [--worker-id ID] [--once]
majin-v6 engine stop | clear-stop

majin-v6 queue add --kind KIND [--title T] [--payload JSON]
                   [--dedupe-key K] [--priority N] [--irreversible] [--max-attempts N]
majin-v6 queue list [--state S] [--kind K] [--json]
majin-v6 queue get ID | retry ID | cancel ID | budget
majin-v6 queue budget [--max-tasks N] [--max-runtime-ms N] [--max-tool-calls N]

majin-v6 jobs discover --candidate ID --query TEXT [--limit N]
majin-v6 jobs list [--candidate ID] [--state S]
majin-v6 jobs evaluate --id APP_ID
majin-v6 jobs approve --id APP_ID --ref POLICY_REFERENCE
majin-v6 jobs verify --id APP_ID
majin-v6 jobs quota --candidate ID

majin-v6 gmail status
majin-v6 sync status | local | push [--yes] [--dry-run]
majin-v6 inventory [--deep] [--history] [--write] [--json]
```

`queue retry` refuses `UNCERTAIN` work. Reconcile it explicitly; see below.

## Queueing work

Example: hash a file in the background.

```bash
node bin/majin-v6.mjs queue add --kind tool --title "hash evidence" \
  --payload '{"tool":"re_hash","arguments":{"path":"evidence.pdf"}}' \
  --dedupe-key evidence-hash-2026-10-27
node bin/majin-v6.mjs worker --max-tasks 1 --max-runtime-ms 60000
node bin/majin-v6.mjs status
```

Job discovery and evaluation:

```bash
node bin/majin-v6.mjs queue add --kind job.discover \
  --payload '{"candidateId":"it-candidate","query":"utvecklare stockholm","limit":10}' \
  --dedupe-key discover-2026-10-27
node bin/majin-v6.mjs worker --max-tasks 5 --max-runtime-ms 300000
node bin/majin-v6.mjs jobs list
```

Submission is gated: `job.submit` returns `BLOCKED` with
`SUBMISSION_ADAPTER_NOT_CONFIGURED` unless an owner-provided adapter exists.
No built-in adapter clicks employer portals.

## From OpenCode

Useful prompts that map to real tools:

```text
Use majin_status to show the real MAJIN bridge state and granted lanes.
Search MAJIN tools for file, browser, job and Gmail capabilities, then read the schema of one and call it with a stable operationId.
Queue a job.discover task for candidate it-candidate and start a bounded worker.
Show v6_status. Do not claim an application was submitted without a receipt.
```

The model must call `majin_tools_search` and `majin_tool_schema` before
`majin_tool_call`. Searching and schemas do not execute anything.

## Recovery

| Symptom | Meaning | Action |
| --- | --- | --- |
| `majin_status` fails with `V5_DATA_MISSING` | wrong `--data-dir` | point it at the real V5 profile; do not create a new one |
| Tool call returns `TOOL_NOT_AUTHORIZED` | lane not granted | use the existing MAJIN owner flow to grant it; V6 will not |
| Task `BLOCKED` with `requiresOwner` | CAPTCHA/MFA/credentials | resolve, then `majin-v6 queue retry <id>` |
| Task `UNCERTAIN` | external outcome unknown | inspect the portal/mail; `resolveUncertain` via API or leave it |
| Worker heartbeat `STALLED` | no write within 45 s | check the PID and logs; leases recover automatically |
| `QUEUE_LOCK_TIMEOUT` | another writer holds the lock | wait; a stale lock is removed after 30 s |
| Repeated `FAILED_RETRYABLE` | transient tool/network failure | check `lastError.code`; retries use exponential backoff |

Uncertain task handling is intentionally not exposed as a one-line CLI escape
hatch. A human must confirm the real outcome with evidence; the queue API
`resolveUncertain` requires either a confirmation ID plus time or a failure note.

## Privacy

- Event data is scrubbed (tokens, cookies, passwords, email bodies, CV text,
  verification links).
- Sync uploads counts and event types only, and refuses public repositories.
- Local logs may still contain employer names and application states. They stay
  in `<v6-home>` and are mode 600 where the OS supports it.

## Tests

```bash
npm run v6:test          # V6 unit/integration/live (Linux)
npm test                 # repository suite
node scripts/parse-all.js
```

The V6 suite spawns real node processes and a real MCP bridge; it is not a
fixture-only suite.
