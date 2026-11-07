# CODEX DRIVER backend

Codex makes decisions; Majin exposes deterministic tools over local MCP stdio.
The existing provider mode and UI files are unchanged. The separate backend never
constructs GrandArchitect or ProviderManager. It uses the installed official Codex
App Server and managed ChatGPT login without reading/copying authentication files.

## Start on Windows

Requires Node 22+, `npm ci --ignore-scripts`, and official Codex CLI on PATH.
Tested with codex-cli 0.160.0 and Node 24.14.0 in an interactive Windows session on
25 October 2026. Browser tools need optional Playwright Core and installed Chrome/Edge.

```powershell
# UI backend on loopback port 4556, using the existing Codex account/settings
./scripts/v5/start-codex-driver.ps1 -HostServer
# Also enable general host commands explicitly
./scripts/v5/start-codex-driver.ps1 -HostServer -ProcessAccess
# OR register tools for an existing Codex client, then restart that client
./scripts/v5/start-codex-driver.ps1 -Register
# Physical connection test (opens a new Notepad)
./scripts/v5/start-codex-driver.ps1 -Accept
```

The script's default is stdio MCP, not HTTP. Do not run global registration and
the dedicated backend against the same state directory simultaneously. Each state
directory has one live owner, enforced by a process lock. Different state directories
have independent deduplication ledgers. Keep private workspace/state outside Git.

Equivalent Codex configuration, replacing these example absolute paths:

```toml
[mcp_servers.majin]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\path\MAJINCLI\bin\majin-codex-mcp.mjs', '--workspace', 'C:\path\workspace', '--state-dir', 'C:\path\state', '--desktop', '--browser']
required = true
```

The App Server client passes this configuration through supported `-c` overrides;
starting it does not modify global config. The owner's model, approvals and sandbox
settings remain in effect. Pending approval/elicitation requests are surfaced to
the UI, which returns the owner's decision. No OpenCode Go key is requested.

Trusted launch flags are `--workspace`, `--state-dir`, `--skills-dir`, `--desktop`,
`--browser`, and `--process`. Imported files/skills cannot change them. Files use
realpath workspace checks. `--process` grants commands the host user's OS rights:
the working directory is validated, but this is not an OS sandbox.

## UI handoff

Use `node bin/majin-codex-host.mjs --ui-dir <bundle-directory>` to serve the frontend
bundle on the same origin. A development frontend can proxy `/api/codex/*` to the
loopback host, preserving target Host and same-origin checks. Cross-origin requests
and non-JSON POST bodies are rejected; permissive CORS is not enabled.

| Method / route | Contract |
| --- | --- |
| GET `/api/codex/status` | Transport/auth status and thread/turn IDs; inference is verified only after a completed Codex turn |
| GET `/api/codex/events` | SSE: original notifications/server requests wrapped in `{id,type,payload}` |
| POST `/api/codex/login` | `{}`; official managed ChatGPT login flow |
| POST `/api/codex/message` | `{text, attachments?: [workspacePath]}`; starts/resumes saved conversation and starts a turn |
| POST `/api/codex/attachment` | `{name, base64}`; bounded local file, returns its workspace path |
| POST `/api/codex/steer` | `{text}`; steer with expected active turn ID |
| POST `/api/codex/interrupt` | `{}`; interrupt; wait for terminal event before claiming stopped |
| POST `/api/codex/reply` | `{id,result}`; answer a currently pending approval/elicitation request |

Render `item/agentMessage/delta` as output and tool/turn lifecycle events as work
status. Inspect `turn/completed` status: `completed`, `failed`, or `interrupted`.
Last-Event-ID replays the most recent 500 SSE events; this is not a durable full
transcript. Thread ID is saved and resumed after restart; older history remains
in Codex. Attachments are workspace files read through Majin tools.

The UI workstream must wire its mode selector, chat, events, previews, and requests
to these endpoints. Keep provider mode separate. Do not route CODEX DRIVER goals
through the old GrandArchitect agent loop. This slice does not claim a finished
UI integration or installer.

## Tools and execution

Published tools cover files, public web research, document extraction, canonical
skills, current jobs and keyword evidence. Browser, Windows and process tools are
published only when enabled and available. Existing deterministic implementations
are reused. New narrow Windows primitives are core tools, not alternate agents.
`computer.use`, provider agents, media generation and XP approval are excluded.

Every action needs an `operationId`. Results carry status, result, evidence,
errorCode and blocker. Reusing the same action ID returns the previous result;
different arguments under that ID are rejected. New observations need new IDs.
A crash leaves a running action `uncertain`, never automatically retried. This
prevents local replay, not transactional exactly-once behavior at remote services.

`execution_status` observes an action, and `execution_cancel` or MCP cancellation
stops its worker and descendants (Windows taskkill /T, POSIX process group).
Results stay uncertain because effects may already have occurred. Browser state
must be reopened. Owner-enabled detached commands or remote services can require
their own cancellation; killing a process cannot roll back external effects.
Calls serialize device actions and have bounded timeouts.

Screenshots return actual MCP image content, kept in private local state. Modern
Notepad RichEditD2DPT is supported; `hwnd:<number>` keeps targets stable when titles
change. Ambiguous title matches refuse. `control.inspect` exposes actual child
classes. Windows may deny foreground focus; `desktop_capture_window` can capture
the observed window with PrintWindow. A valid PNG still requires visual inspection.

The inherited isolated browser prepares forms/selects files but blocks submission
and non-read requests. It is not a universal authenticated service connector.
Owner-enabled commands can use authorized service APIs/CLIs. Accounts still need
owner access, and MFA/CAPTCHA can need the owner. No claim is made that every
conceivable task can be completed from one instruction.

## Validation and remaining scope

On real interactive Windows, MCP requests launched Notepad, wrote a unique ID,
read it back and returned a window PNG; Codex visually confirmed the exact ID.
Installed App Server discovered Majin and invoked `driver_status`. A real inference
turn read a fixture, wrote a correct Swedish summary and read it back through Majin.

The universal acceptance script exercises A–F through App Server MCP calls:
document extraction/summary readback, current public data with sources, visible
local form/file selection, rendered generated HTML, observed failing code then
repair/execution, and five current jobs with test-CV keyword evidence. These are
scripted integration scenarios, not proof of autonomous planning in every case.
The separate inference test proves the autonomous document flow.

Driver tests cover G/H: stuck worker/descendants terminate, delayed writes do not
occur, fresh workers recover, append is not repeated after restart, and incomplete
records remain uncertain. No real applications/messages are sent by acceptance.
Private screenshots, CVs, paths and operation state are not committed to GitHub.

```powershell
node --test test/v5/codex-driver.test.js test/wincontrol.test.js
node scripts/v5/codex-accept.mjs <private-output-directory>
node scripts/v5/codex-app-accept.mjs <private-output-directory> --inference
node scripts/v5/codex-universal-accept.mjs <private-output-directory>
npm run check
```

Verified procedure promotion/XP remains in Majin's existing verification system.
This adapter cannot mint receipts, approve skills or set quality gates. Wiring
independent verified outcomes into that system remains, along with UI and installer.
This improves procedures/tools, not Codex model weights.

Reference: [official App Server documentation](https://learn.chatgpt.com/docs/app-server),
checked against schemas generated by installed `codex app-server generate-json-schema`.
