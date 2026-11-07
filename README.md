# MAJIN

**Everything on — always ready.** A local agent that lives on your own machine (Windows first),
runs its own configuration, and answers to you — in the browser window, from Telegram, or from
WhatsApp on your phone. No subscription, no hosted runtime: your keys, your models, your files.

MAJIN is a single Node.js process (or a single `.exe`) with a built-in web UI, 89 tools, a
tool-calling agent loop, Mixture-of-Agents answering, persistent memory and self-modifying
config. It ships with a real reverse-engineering stack (PE/ELF/APK/pcap parsers, a mini-YARA
engine, entropy and string analysis) because "read this file and tell me what it is" should not
need a second program.

```powershell
# Windows — from a clone of this repo
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
majin                      # starts the server and opens a window (Edge/Chrome --app mode)
majin doctor --full        # keys, tools, rules, port, workspace — everything at a glance
```

```bash
# Anywhere with Node 22+
node src/cli/majin.js doctor
node src/cli/majin.js
```

---

## Docs

* [docs/CONFIG.md](docs/CONFIG.md) — every config key, what it does, what it costs
* [docs/REVERSE.md](docs/REVERSE.md) — the 22 RE tools, the mini-YARA engine, rule files
* [docs/WINDOWS.md](docs/WINDOWS.md) — installer, data layout, ports, uninstall, stumbles
* [docs/EXE.md](docs/EXE.md) — how the single-file exe is built and why CI builds it
* [docs/BENCHMARKS.md](docs/BENCHMARKS.md) — deterministic scenario harness + reference numbers
* [docs/DATA.md](docs/DATA.md) — what MAJIN may record about its own runs, and how to keep it off
* [docs/v6/HANDOVER.md](docs/v6/HANDOVER.md) — OpenCode V6 orchestration: what runs, what is blocked
* [docs/v6/OPERATIONS.md](docs/v6/OPERATIONS.md) — V6 commands, Windows launcher, MCP registration
* [docs/v6/PRIVATE_TELEMETRY.md](docs/v6/PRIVATE_TELEMETRY.md) — optional private sync and its exact payload
* [docs/v6/ACCEPTANCE.md](docs/v6/ACCEPTANCE.md) — measured status, including NOT_TESTED items

## What it does

| | |
|---|---|
| **All tools, always** | No enable/disable ceremony. The model gets every tool, every step, and chooses. |
| **MOA by default** | Mixture-of-Agents: 3 reference models answer, an aggregator merges. Runs on every non-trivial turn. |
| **Self-configuring** | "use deepseek-v4-pro for analysis, always", "add my key", "confirm every dangerous thing" — MAJIN parses those and patches its own config, no config editing needed. |
| **Owns its keys** | Keys are stored in your local config file, never on a server. Add one in the UI, with `majin config`, or from your phone via a one-time pairing code. |
| **Image and speech generation** | `media.generate_image` and `media.speak` use a configured OpenAI-compatible media model and save results locally; generation may cost money. |
| **Browser automation** | Nine `browser.*` tools powered by Playwright Core: open, inspect, click, fill, check radio/checkboxes, select options, attach files and close. Form submits and non-read HTTP requests are blocked. |
| **Reverse engineering** | 22 `re.*` tools: structured PE/ELF/Mach-O parsing, entropy, strings, yara (built-in mini engine + real `yara` if installed), APK/ZIP/pcap containers, hexdump, decompilers through external tools. |
| **Persistent memory** | Facts, events, sessions and auto-harvested skills as plain files under `~/.majin` (`%LOCALAPPDATA%\MAJIN` on Windows). |
| **Everywhere** | The same agent answers the browser window, Telegram and WhatsApp. Scheduled jobs run on their own. |

## Install

### Windows, from an executable

1. Grab `majin-win-x64.exe` from the latest release — the `v*` tag triggers the **build-exe**
   workflow, which packages it and attaches it to the release (see [docs/EXE.md](docs/EXE.md)).
   One line, no git needed:

```powershell
curl.exe -L -o majin-win-x64.exe https://github.com/rssen-debug/MAJINCLI/releases/latest/download/majin-win-x64.exe
```

   It is unsigned, so SmartScreen will ask once (*More info → Run anyway*) — that is expected for a
   personal build, and `majin-win-x64.exe doctor` tells you the file is intact.
2. Put it anywhere, then double-click it — it starts the server and opens a window. Or:

```powershell
.\majin-win-x64.exe doctor
.\majin-win-x64.exe start --no-window      # for Task Scheduler / service use
```

Nothing is installed system-wide. The exe unpacks nothing, writes nothing outside its data
directory, and needs no Node.js.

### Windows, from the repo (recommended while MAJIN is young)

```powershell
winget install OpenJS.NodeJS.LTS        # if you do not have Node 22+
git clone https://github.com/rssen-debug/MAJINCLI.git && cd MAJINCLI
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

`install.ps1` copies `src/`, `rules/` and the shims to `%LOCALAPPDATA%\MAJIN`, writes
`majin.cmd`/`majin.ps1` into `%LOCALAPPDATA%\Programs`, puts them on `PATH`, creates a
**MAJIN** task-scheduler entry that starts the server at login, adds a Start Menu shortcut
(with the Majin icon), and writes `~/.majin` (or `%LOCALAPPDATA%\MAJIN`) as the data home.

Flags: `-WhatsApp` (installs the Baileys optional deps), `-NoPath`, `-NoTask`,
`-Home <dir>`, `-Uninstall`. Details: [docs/WINDOWS.md](docs/WINDOWS.md).

### First run

Double-clicking starts the server and opens a window. There is no second step: with no key
anywhere, the first message still gets an answer — MAJIN says plainly that it is in demo mode and
points at the card that fixes it. A wrong or empty key never turns into a silent failure either.

**No terminal, no config file.** In the window: the **Providers** card on the right → pick the
provider → paste the key → **save**. Every route then points at that provider and the next message
is answered for real. The little *get a key ↗* link opens the provider's own key page, and the
address box is only for your own machine (Ollama, LM Studio, a box on the network) — that is the
whole setup. An empty box is refused with a sentence instead of a fake "saved".

The four things that actually go wrong each get one plain sentence with a next action, and MAJIN
does not spend four retries on a failure that cannot fix itself: wrong or deleted key, account out
of credit, model name the provider does not know, address it cannot reach.

Same thing from the terminal, for the people who like it:

```powershell
majin config set providers.deepseek.apiKey sk-...
majin config set models.provider deepseek
```

…or say it in chat: *"use the key sk-… for deepseek"*, or from your phone with
`majin pair telegram`.

Supported presets: OpenRouter, Kilo Gateway, Nous, Groq, OpenAI, Anthropic, Gemini, Ollama,
LM Studio, DeepSeek, plus a `demo` mock provider that answers offline so you can try the loop
with no key at all. A gateway (OpenRouter, Kilo) is just `baseUrl` + `vendor/model` as the id.

## The CLI

```
majin                      start the server and open the window
majin start [--no-window]  run without a window
majin window               open another window on a running server
majin doctor [--full]      providers, keys, tools, RE rules, port, workspace
majin status | url | logs  what is running, the token URL, the log tail
majin config [get <key> | set <key> <value> | path]
majin pair telegram|whatsapp      connect a chat channel (one-time code)
majin send "text"                 one question through the agent
majin re <file> [--json]          RE analysis, no server needed
majin dataset [on|off|list|export|purge]   the local trajectory record (off by default)
majin test                        the test suite
```

Useful env vars: `MAJIN_HOME`, `MAJIN_CONFIG`, `MAJIN_TOKEN`, `MAJIN_PORT`, `MAJIN_WORKSPACE`,
`MAJIN_LLM`, `MAJIN_VERSION`, `MAJIN_SHELL`.

## The window

The UI is one HTML file plus two classic scripts — no build step, no framework, no CDN. It
streams the agent's reasoning, tool calls and results live, and holds the controls you actually
use:

* **chips** for the current route, MOA state, tool count and cost, Telegram/WhatsApp status
* **mode** (Assist / Approval / Full auto) — what MAJIN may do without asking
* **panel** with provider keys, the 13 model routes, MOA width and policy, channel setup,
  scheduled jobs, memory, skills and the RE drop zone
* drag a file onto the window to analyse it; the report lands in the chat as evidence

Theme `jarvis` is default. Voice (wake word "MAJIN", speech in Swedish or English) is wired to
the browser's Web Speech API and off until you turn it on.

## Tools

89 tools, always all on. Risk is per tool, not per group — that is what the guard reads.

| prefix | count | tools |
|---|---|---|
| `fs` | 12 | list, read, write, patch, search, grep, move, copy, delete, stat, mkdir, tar |
| `shell` | 5 | run, bg, jobs, stop, env |
| `sys` | 7 | info, ps, ports, fs_usage, procs_top, services, notify |
| `net` | 5 | dns, tcp, http, serve, serve_stop |
| `screen` | 2 | capture, claim |
| `web` | 3 | search, fetch, download |
| `browser` | 9 | open, inspect, click, fill, check, select, upload, press, close |
| `media` | 2 | generate_image, speak |
| `re` | 23 | analyze, strings, hexdump, search, entropy, sections, imports, exports, yara, iocs, overlay, extract, apk, pcap, diff, modules, tool, tools, disasm, unpack, hash, rules, spec |
| `majin` | 17 | configure, routes, provider, moa, guard, memory, skill, plugin, schedule, channel, status, selftest, tools, backup, ui, control, dataset |
| `agent` | 4 | plan, delegate, moa, approve |

Every tool's parameters and examples: `GET /api/tools` (or the Tools card in the panel), and
`majin doctor` prints the count plus which subsystems are ready. Browser automation needs `npm install`
and an installed Chrome, Edge or Chromium; `browser.open` starts an isolated MAJIN profile. The
browser can fill and prepare forms, but native submits and all non-read HTTP methods are blocked.
`majin.plugin` can create custom JS tools at runtime; they are hash-checked on restart and require
exec approval. Plugins run with MAJIN process privileges, so install only trusted code. Media
generation needs a provider/model that implements the matching endpoint and may incur charges.
MAJIN uses its configured model for planning but does not depend on a particular provider.
Notes on the RE set and how the built-in parsers, YARA rules and external tools fit together:
[docs/REVERSE.md](docs/REVERSE.md).

## Guard rails

`guard.mode` is the only dial:

| UI label | `guard.mode` | behaviour |
|---|---|---|
| Assist | `strict` | every write, exec and destructive call is confirmed |
| Approval | `confirm` (default) | exec + destructive calls are confirmed |
| Full auto | `off` | nothing asks; `neverOn` still blocks |

`guard.neverOn` is a hard block list (regex), `guard.askOn` forces confirmation for patterns,
`guard.autoApprove` exempts `name` or `name:<hash>`, `guard.pathWriteRoots` limits where writes
may land (`auto` = workspace + data dirs). Deleting a workspace root, your home or a drive root
is refused outright — `fs.delete` on those returns `protected`, and quoting or `rm -rf /` inside
a shell string does **not** launder it. Destructive commands are matched on the parsed tokens, so
`echo "rm -rf /"` is not a threat while `rm -rf /` is.

Approvals time out (`tasks.approvalTimeoutMs`, default 30 min) and the timeout counts as *no*.

## Chat channels

```powershell
majin pair telegram      # print a code, send it to @yourbot
majin pair whatsapp      # QR in the terminal, or the QR card in the window
```

Telegram uses the Bot API over long polling (no public port). WhatsApp uses
`@whiskeysockets/baileys` (installed with `install.ps1 -WhatsApp` or
`npm i --include=optional`) and shows a QR code. Both channels get the same agent, the same
tools and the same guard — plus an allow-list, so strangers cannot order your computer around.
The raw WhatsApp webhook (`POST /api/webhook/whatsapp`) verifies `x-hub-signature-256` against
your app secret.

## Scheduling

`majin.schedule` / the panel's schedule card creates jobs: cron-ish or `every 30m`, a prompt, an
optional model route and a target channel. Jobs run in the same loop, isolated sessions, and post
the answer wherever you asked. `GET /api/schedule` shows the next run; `POST /api/schedule/run`
runs one now.

A job can be `readOnly: true` — it may then look at anything but change nothing, which is
what you want for the morning sweep you never watch. `schedule.readOnlyDefault: true` makes
that the default for every new job.

## HTTP API

Everything the UI does is HTTP with a token. `majin url` prints the URL with `?t=`.

```
POST /api/chat                SSE stream; ?stream=false gives one JSON object
GET  /api/state               config (redacted), routes, moa, guard, tools, usage, channels
GET  /api/events              log + tool event stream (SSE)
GET  /api/config              PATCH /api/config to change it (validated, diffed, backed up)
POST /api/intent              dry-run a natural-language config sentence
GET  /api/logs | /api/usage | /api/memory | /api/skills | /api/schedule | /api/approvals
GET  /api/sessions | /api/history?session= | /api/report | /api/file?path=
POST /api/re/upload?name= | /api/re/analyze | GET /api/tools | POST /api/tool
POST /api/approve | /api/provider/test | /api/session/clear | /api/usage/reset
POST /api/restart | /api/shutdown | GET /healthz | POST /api/webhook/whatsapp
```

Loopback (`localhost`, `127.0.0.1`, `[::1]`) is trusted without a token so the window works;
everything else needs `?t=`, `authorization: Bearer`, the `majin=` cookie or `x-majin-token`.
Set `server.trustLocal: false` to require a token even locally. The loopback trust only applies to
packets that really come from loopback, so a remote request forging `Host: localhost` gets 401 —
`server.allowRemote: true` is what opts into host-based trust from any peer (tunnel/VPN first).

## OpenCode V6 (experimental)

V6 turns the existing MAJIN tools into a durable, observable layer behind
**OpenCode CLI**. OpenCode keeps its own model (DeepSeek via your existing
setup); V6 never starts a second provider or a second chat UI.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\v6\start-v6.ps1 -Action Doctor
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\v6\register-opencode-mcp.ps1           # dry run
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\v6\register-opencode-mcp.ps1 -Apply    # opt-in, backed up
```

V6 adds an MCP bridge with dynamic tool discovery, a durable task queue and
bounded worker, a heartbeat/watchdog, a strict job-application state machine,
read-only Gmail verification, a local JSONL event log with a real status report,
and optional private sync without `gh`. It never writes the V5 profile or your
OpenCode settings. **No employer-portal submission adapter is included**, so
`job.submit` reports a blocker instead of pretending to apply. See
[docs/v6/HANDOVER.md](docs/v6/HANDOVER.md) for verified capabilities and the
NOT_TESTED Windows/Gmail items.

## Development

```bash
npm install
npm run check            # syntax-parses every source and test file
npm test                 # 59 tests, no network, no keys
npm run doctor
node src/cli/majin.js send "what is in this folder?"
```

The test suites are `config`, `selfconfig`, `router-moa`, `tools`, `re`, `agent` (end-to-end
against the `demo` mock provider) and `server` (a real child process on a free port).
Building the exe and the CI recipe: [docs/EXE.md](docs/EXE.md). `npm run bench` is a deterministic mock-only plumbing check. To test actual configured-model tool use, run `npm run eval:live -- --yes`; it runs two live scenarios (up to eight model steps each), may incur charges, uses a temporary workspace and refuses OpenCode/Qwen routes. Details and limitations: [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

## Layout

```
src/cli/majin.js        CLI: start, doctor, config, pair, send, re, test, window
src/core/runtime.js     one mount point: config → memory → skills → registry → agent → channels
src/core/agent.js       turn: route → loop → MOA → memory
src/core/loop.js        the tool loop (shared with subagents)
src/core/router.js      natural language → config patch
src/core/routes.js      job classification
src/core/moa.js         Mixture-of-Agents
src/core/guard.js       modes, askOn/neverOn, approvals
src/core/server/        HTTP + SSE + static UI, token auth
src/core/tools/         the 89 tools, eleven groups
src/core/binary/        PE, ELF, Mach-O, containers, entropy, strings, YARA subset
src/core/channels/      telegram (long poll), whatsapp (baileys)
src/core/provider/      openai-compat, anthropic, gemini, mock/demo
src/ui/                 index.html + app.js + panels.js + logo.png
rules/*.yar             your YARA rules, seeded into <home>/rules on first run
scripts/                build-exe.mjs (esbuild + pkg), bench.mjs, parse-all.js, clean.js
install.ps1             Windows setup (bin, PATH, task, start menu, icon)
```

## Privacy and limits

* MAJIN sends your prompt (and file excerpts you drop in) to whichever provider you configured.
  Nothing is sent anywhere else; `web.*`/`net.*` only do what you or the agent asks for.
* MAJIN can record its own turns as training data, but only if you say so (`dataset.capture`, off by
  default, redacted on write, trimmed after `keepDays`). There is no upload code path and no upload
  key — sharing means you export `trajectories.jsonl` yourself. See [docs/DATA.md](docs/DATA.md).
* Keys live in `<home>/config.json` (0600 on POSIX). Redaction is enforced on every read
  endpoint: no route returns a raw key.
* `majin re` reads files; it never executes them. External decompilers are only used if you have
  them installed, and `re.tool` refuses politely when they are missing.
* The agent can delete and can run commands. That is the point, and the reason the guard exists.
  Read [the guard section](#guard-rails) before you turn on Full auto.
* Windows-first, not Windows-only: the core runs on macOS and Linux; `install.ps1`, the task
  registration, `.lnk` and the icon are Windows-only. Screen capture and clipboard go through
  whatever OS tools exist, so they degrade instead of crashing.

MIT — see the license field in `package.json`.
