# Private telemetry (optional)

V6 is local-first. The status command works with no network. Private sync is an
opt-in extra for a **private** repository.

- Target: `rssen-debug/majin2026`
- Transport: GitHub REST API directly. `gh`, `gh.exe` and the GitHub CLI are not
  used or required.
- Token: `MAJIN_V6_SYNC_TOKEN` or `<v6-home>/secrets/github-token` (mode 600).
- Repository check: before every upload V6 asks GitHub for the repository and
  requires `private: true` and an exact `full_name` match. A 404, an auth error,
  a public repository or a mismatched name refuses the upload.
- Dry run: `majin-v6 sync push --dry-run` (also the default without `--yes`).
- Local copy: `majin-v6 sync local` writes the same sanitized payload under
  `<v6-home>/reports/`.

## Exactly what is uploaded

```json
{
  "schema": "majin.v6.telemetry/v1",
  "generatedAt": "ISO timestamp",
  "engine": { "state": "RUNNING | IDLE | STALLED | NOT_RUNNING" },
  "queue": { "QUEUED": 0, "RUNNING": 0, "COMPLETED": 0, "BLOCKED": 0, "UNCERTAIN": 0 },
  "workers": [{ "state": "ACTIVE", "ageSeconds": 12, "lastAction": "tool fs_read started" }],
  "activity": [{ "at": "ISO timestamp", "type": "task.completed", "taskId": "tsk_..." }],
  "jobs": { "total": 0, "byState": { "MATCHED": 0 } },
  "checks": { "gmail": { "state": "NOT_CONFIGURED" } },
  "limitations": ["text"]
}
```

That is the complete allowlist. Event payloads are dropped; only type, time and
task ID survive. Queue counts are aggregate. `lastAction` is a short phrase
written by V6 (for example `tool fs_read completed`); it is scrubbed first.

## What is never uploaded

The payload gate refuses the whole upload if it finds any of:

- passwords, secrets, tokens, API keys, cookies, session IDs, authorization
  headers, refresh/access tokens;
- CV text, cover letters, email bodies or raw HTML;
- verification, reset or login links with query tokens;
- GitHub tokens, private keys, bearer strings;
- credentials of any kind.

Additional rules:

- Candidate names and contact details are not in the payload.
- Employer names and application states are not uploaded; only aggregate job
  counts.
- The local event log may contain employer names, application states and tool
  names. It stays on the owner's machine.
- Model identity and token usage are OpenCode's business; V6 does not have them
  and does not guess.

## Failure behaviour

| Situation | Result |
| --- | --- |
| No token | `TOKEN_MISSING` — sync skipped, local commands still work |
| Public repository | `SYNC_REPO_NOT_PRIVATE` — no write request is sent |
| Repository inaccessible | `SYNC_REPO_NOT_ACCESSIBLE` |
| Token invalid | `SYNC_AUTH_FAILED` |
| Payload contains private data | `SYNC_PRIVATE_DATA` with field paths, upload refused |
| Upload HTTP error | `SYNC_UPLOAD_FAILED`; the local report remains |

Every refusal is appended to the local event log as `sync.refused`; success is
`sync.completed`. Neither event includes the token.

## What the owner can see remotely vs locally

- **Remotely:** aggregate queue/worker/job counts, event types, timestamps, V6
  limitations, and the configured check states.
- **Locally only:** full task payloads, candidate profiles, CV contents, job
  listings, application receipts, Gmail message IDs, browser evidence, worker
  logs and the SQLite/JSON queue state.

If remote visibility is not needed, do not configure a token. Nothing is
uploaded automatically by the worker. Upload only when the owner runs
`majin-v6 sync push --yes` (for example from a scheduled task).
