# MAJIN on Windows

Windows is the first-class target: the agent is meant to sit on your own machine with your files,
your shell and your programs — and be reachable from your phone.

## What `install.ps1` does

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

1. **Checks Node** — needs 22.0.0+ on `PATH` (`winget install OpenJS.NodeJS.LTS`).
2. **Copies the app** — `src/`, `rules/`, `scripts/`, `package.json`, the icons and the shims into
   `%LOCALAPPDATA%\MAJIN` (override with `-Home <dir>`). Nothing goes into `Program Files`, so no
   elevation is required.
3. **Writes the launchers** into `%LOCALAPPDATA%\MAJIN\bin`:
   * `majin.cmd` — the CLI; sets `MAJIN_HOME` to the install dir unless you already set it
   * `majin-start.cmd` — `majin start --no-browser` (window opens itself via `majin window`)
   * `majin-serve.cmd` — headless, what the scheduled task runs
4. **PATH** — prepends `…\MAJIN\bin` to the *user* PATH (skip with `-NoPath`).
5. **Shortcuts** — Start Menu **and** Desktop entries named *MAJIN*, with the Majin icon
   (`majin.ico`, 16–256 px).
6. **Logon task** — `Register-ScheduledTask -TaskName MAJIN -AtLogOn`, no time limit, allowed on
   battery (skip with `-NoTask`).
7. **`npm i --include=optional`** — installs `@whiskeysockets/baileys` + `qrcode` for the WhatsApp
   channel. Only with `-WhatsApp`; otherwise the channel is simply reported as not installed.

It never touches Windows Defender, the firewall, services or the machine-wide PATH.

Afterwards:

```powershell
majin doctor          # node, config, workspace, keys, rules, port, tools, guard
majin                 # start + open the window
majin url             # the token URL, if you want to open it yourself
```

## Data layout

`MAJIN_HOME` defaults to `%LOCALAPPDATA%\MAJIN` (the install dir), so everything lives together:

```
%LOCALAPPDATA%\MAJIN\
  majin.config.json      your config: keys, routes, MOA, guard, channels, persona
  bin\                   majin.cmd, majin-start.cmd, majin-serve.cmd
  src\  rules\  scripts\  assets\  the app itself
  workspace\             default root for fs.* and shell.* — the agent's sandbox-without-a-box
  memory\                facts.md, events.jsonl
  sessions\              one .jsonl per conversation
  skills\                auto-harvested how-tos as .md
  rules\                 majin.yar (seeded) + your own .yar files
  logs\  out\  uploads\  cache\
```

`MAJIN_HOME` is read once at startup. The wrappers set it only if you did not set it yourself, so
`setx MAJIN_HOME D:\majin-data` moves everything (config included) and survives updates.

## Ports and the token

The server binds `0.0.0.0:8787` by default. That is deliberate — the phone/Telegram side and LAN
access need it to be reachable — and it is guarded:

* loopback (`localhost`, `127.0.0.1`, `[::1]`) is trusted, so the window works with no token
* every other origin needs the token in `?t=`, `authorization: Bearer`, the `majin=` cookie or
  `x-majin-token`; the **first** run instead shows a "key required" page and never the app
* `server.trustLocal: false` → token required even on loopback
* the trusted-host exemption only applies to packets that actually arrive from loopback: with
  `server.allowRemote: false` (default) a request from `10.x.x.x` that *claims* `Host:
  localhost:8787` is still refused — DNS rebinding cannot buy its way in

If you would rather not open a listening port at all: `majin config set server.host 127.0.0.1`
and use Tailscale/SSH tunnelling for the phone. Windows will ask once about allowing Node on the
network — the private profile is enough; the script does not add a rule for you.

## Uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

Removes the scheduled task, the shortcuts, the `bin` entries, the PATH entry and the install dir.
Your `majin.config.json` (with the keys) is kept under `workspace`-adjacent storage only if you
asked for it — otherwise it goes with the folder. `uninstall-majin.cmd` in the install dir calls
the same path. Delete your Telegram bot (BotFather) and revoke any key you pasted, if paranoia is
warranted — that is the part the script cannot do for you.

## Common stumbles

| symptom | cause and fix |
|---|---|
| `majin` is not recognised | open a **new** shell (PATH changes need it), or run `%LOCALAPPDATA%\MAJIN\bin\majin.cmd` |
| window says *key required* | no provider key yet — `majin config set providers.<p>.apiKey sk-…` |
| `EADDRINUSE` on 8787 | an instance is already running — `majin status`, or `majin config set server.port 8790` |
| WhatsApp says "not installed" | `install.ps1 -WhatsApp`, or `npm i --include=optional` in the install dir |
| Antivirus flags the exe | an unpacked single-file Node binary trips heuristics; run `majin doctor`, keep the artifact hash, or use the repo install |
| Corporate proxy for the API | `majin config set providers.openai.baseUrl https://gateway.internal/v1` — OpenAI-compatible endpoints need no code change |
| Task never starts at logon | Task Scheduler → MAJIN → "Run only when user is logged on", and check the node path in `majin-serve.cmd` |

## Also works, uninstalled

`majin-win-x64.exe` (built by CI, see [EXE.md](EXE.md)) is the whole app in one file: no Node,
no install, no PATH — `majin-win-x64.exe doctor` and you are running. The folder next to it (or
`MAJIN_HOME`) is used for data.
