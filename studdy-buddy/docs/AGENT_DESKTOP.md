# AGENT_DESKTOP

How Buddy sees Windows applications, and what was actually verified about the
integration.

## What `agent-desktop` is

[vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop) is a CLI
and C library that exposes the OS accessibility tree (Windows UI Automation, macOS
AX, Linux AT-SPI) as JSON, with a `ref` for every element an agent can act on. It
contains no model; the agent loop lives in the caller.

Install: `npm install -g agent-desktop` (native binaries for x64/ARM64 are bundled).

## What was verified here, and what was not

The package **was installed and executed** in this environment (Linux, package
version 1.2.0, protocol version 2.6). This is a real observation, not an
assumption:

```
$ agent-desktop version
{"version":"2.6","ok":true,"command":"version","data":{"os":"linux","target":"x86_64","version":"1.2.0"}}

$ agent-desktop --version
agent-desktop 1.2.0
```

Three facts matter for the adapter and were confirmed by running it:

1. **The JSON envelope shape is `{version, ok, command, data}` or
   `{version, ok, command, error}`.** `data` is the payload; `error` carries
   `code`, `message`, `disposition {delivery, retry}`.
2. **There is no `--json` flag.** Every command prints JSON by default; passing
   `--json` fails with `INVALID_ARGS`. The first iteration of the adapter passed
   it and would have failed on every call.
3. **Exit codes: 0 success, 1 command/error envelope, 2 invalid CLI usage.** Errors
   are *not* signalled by a non-zero exit alone; the envelope must be parsed.
4. `list-windows` requires `--app`/`--window-id` filtering rules and returns
   `data` as an **array**, not `{windows: [...]}`.
5. `snapshot` returns `data.tree` (nested `role`/`name`/`ref_id`/`children`) plus
   `snapshot_id`, `ref_count`, `complete`. Refs look like `@s8f3k2p9:e8` and belong
   to their snapshot; a stale ref yields `STALE_REF`.
6. `status` reports per-platform permission state
   (`accessibility`/`automation`/`screen_recording`).

On this Linux host the accessibility bus is absent, so window enumeration returns
`PLATFORM_NOT_SUPPORTED` with a D-Bus suggestion. On Windows the same code path
uses UI Automation; **that path has not been run here** and is marked
IMPLEMENTED_NOT_VERIFIED / BLOCKED in `BUILD_STATUS.md`.

## How the adapter uses it

`apps/desktop/electron/desktop-adapter.ts`:

* shells out with `execFile`, a hard timeout (8 s) and `windowsHide`, `maxBuffer`
  4 MB — no daemon, because a packaged app should not require a background service
* parses the envelope, not the raw stdout shape, and turns a failed command into a
  structured `{ error }` rather than an empty list that looks like "no windows"
* maps `data` entries to `WindowInfo` (id, title, process, bounds, appKind) and
  `snapshot` to `UiSnapshot` (`accessible: false` when nothing could be read)
* rejects `stale` refs before any action
* is injectable (`runner`), so all of the above is unit tested without the binary

`APP_PROCESS_HINTS` classifies `PacketTracer.exe` / `chrome.exe` / `msedge.exe`.
Classification is a convenience for the UI; nothing security-relevant depends on it.

## Deliberate boundaries

* **Read before act.** The agent loop observes, interprets, plans, then asks. Acting
  requires `computer.actions` *and* `APPROVED_ACTION` mode, per action.
* **No pixel automation.** `agent-desktop` provides coordinate commands
  (`mouse-click`, `--headed`). Buddy does not use them by default: a semantic click
  on a verified ref is auditable, a coordinate click is not.
* **Screenshots are opt-in and downscaled.** `screenCapture` returns base64 to the
  renderer and writes nothing to disk.
* **No secret handling.** `type`/`set-value` support `--stdin` so text stays out of
  process arguments; Buddy never fills password fields at all.

## Follow-ups (untested, listed honestly)

1. Replace the assumed `list-windows` mapping with the documented array shape — done
   in the parser, but only proven against fixtures.
2. Drop the `--json` flag from every call — done; add a test that fails if it
   reappears.
3. Prefer a persistent MCP stdio session (`agent-desktop mcp`) over one process per
   call, once latency is measured on Windows.
4. Windows permission pre-flight via `agent-desktop status` before enabling
   `application.observe`, so the student sees the real reason it will not work.
