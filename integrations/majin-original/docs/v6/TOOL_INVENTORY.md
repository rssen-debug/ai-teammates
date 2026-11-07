# MAJIN V6 — Calculated Tool Inventory

Generated: 2026-10-27T15:15:46.255Z  
Platform: `linux`

This file is generated from the repositories, not hand-written. A registration is not a working integration; read the availability columns.

## Counts

| Measure | Value |
| --- | --- |
| currentV1Universe | 157 |
| currentV1Entries | 157 |
| currentV2Builtins | 3 |
| openCodeDriverAdapters | 97 |
| openCodeAvailableNow | 93 |
| openCodeUnavailable | 64 |
| openCodeMcpTools | 11 |
| lanesAvailable | 17 |
| lanesTotal | 20 |
| historicalUniqueDeclarations | 176 |

Browser runtime: unavailable — no browser binary found (npx playwright install chromium)

## OpenCode driver (deep catalog)

Registered: **97**, available: **93**, unavailable: **64**.

Unavailable tools carry a concrete reason in `inventory.json`; categories:

```json
{
  "available": 93,
  "superseded": 11,
  "platform": 14,
  "missing-dependency": 16,
  "host-service": 23,
  "lane-not-granted": 0,
  "legacy-unported": 0,
  "unregistered": 0
}
```

## V1 tools

| Tool | Lane | Risk | Executable on this host | Unavailable reason |
| --- | --- | --- | --- | --- |
| `fs.list` | files | read | yes |  |
| `fs.read` | files | read | yes |  |
| `fs.write` | files | write | yes |  |
| `fs.patch` | files | write | yes |  |
| `fs.search` | files | read | yes |  |
| `fs.grep` | files | read | yes |  |
| `fs.move` | files | write | yes |  |
| `fs.copy` | files | write | yes |  |
| `fs.delete` | files | destructive | yes |  |
| `fs.find` | files | read | yes |  |
| `fs.stat` | files | read | yes |  |
| `fs.mkdir` | files | write | yes |  |
| `fs.tar` | files | write | yes |  |
| `shell.run` | shelltools | exec | yes |  |
| `shell.bg` | shelltools | exec | yes |  |
| `shell.jobs` | shelltools | read | yes |  |
| `shell.stop` | shelltools | exec | yes |  |
| `shell.env` | shelltools | read | yes |  |
| `sys.info` | sys | read | yes |  |
| `sys.ps` | sys | read | yes |  |
| `sys.ports` | sys | read | yes |  |
| `sys.fs_usage` | sys | read | yes |  |
| `sys.procs_top` | sys | read | yes |  |
| `sys.services` | sys | read | yes |  |
| `net.dns` | net | read | yes |  |
| `net.tcp` | net | read | yes |  |
| `net.http` | net | exec | yes |  |
| `net.serve` | net | exec | yes |  |
| `net.serve_stop` | net | exec | yes |  |
| `screen.capture` | screen | read | no | Windows-only (this host is linux) |
| `screen.claim` | screen | read | no | Windows-only (this host is linux) |
| `sys.notify` | screen | read | no | Windows-only (this host is linux) |
| `web.search` | web | read | yes |  |
| `web.fetch` | web | read | yes |  |
| `web.download` | web | write | yes |  |
| `browser.open` | browser | read | yes |  |
| `browser.read` | browser | read | yes |  |
| `browser.click` | browser | write | yes |  |
| `browser.form` | browser | read | yes |  |
| `browser.form_fill` | browser | exec | yes |  |
| `browser.form_submit` | browser | exec | yes |  |
| `browser.fill` | browser | write | yes |  |
| `browser.shot` | browser | read | yes |  |
| `browser.upload` | browser | write | yes |  |
| `browser.verify` | browser | read | yes |  |
| `browser.elements` | browser | read | yes |  |
| `browser.clear_marks` | browser | write | yes |  |
| `browser.close` | browser | read | yes |  |
| `media.generate_image` | media-service | exec | yes |  |
| `media.speak` | media-service | exec | yes |  |
| `re.analyze` | re | read | yes |  |
| `re.strings` | re | read | yes |  |
| `re.hexdump` | re | read | yes |  |
| `re.search` | re | read | yes |  |
| `re.entropy` | re | read | yes |  |
| `re.sections` | re | read | yes |  |
| `re.imports` | re | read | yes |  |
| `re.exports` | re | read | yes |  |
| `re.yara` | re | read | yes |  |
| `re.iocs` | re | read | yes |  |
| `re.overlay` | re | read | yes |  |
| `re.extract` | re | write | yes |  |
| `re.apk` | re | read | yes |  |
| `re.pcap` | re | read | yes |  |
| `re.diff` | re | read | yes |  |
| `re.modules` | re | read | yes |  |
| `re.tool` | re | exec | yes |  |
| `re.tools` | re | read | yes |  |
| `re.disasm` | re | read | yes |  |
| `re.unpack` | re | write | yes |  |
| `re.hash` | re | read | yes |  |
| `re.spec` | re | write | yes |  |
| `re.rules` | re | read | yes |  |
| `majin.configure` | majin-service | write | yes |  |
| `majin.routes` | majin-service | write | yes |  |
| `majin.provider` | majin-service | write | yes |  |
| `majin.moa` | majin-service | write | yes |  |
| `majin.guard` | majin-service | write | yes |  |
| `majin.memory` | majin-service | write | yes |  |
| `majin.skill` | majin-service | write | yes |  |
| `majin.schedule` | majin-service | write | yes |  |
| `majin.channel` | majin-service | write | yes |  |
| `majin.status` | majin-service | read | yes |  |
| `majin.doctor` | majin-service | read | yes |  |
| `majin.selftest` | majin-service | read | yes |  |
| `majin.tools` | majin-service | read | yes |  |
| `majin.backup` | majin-service | write | yes |  |
| `majin.ui` | majin-service | read | yes |  |
| `majin.control` | majin-service | write | yes |  |
| `majin.dataset` | majin-service | write | yes |  |
| `majin.adapter` | majin-service | write | yes |  |
| `majin.plugin` | majin-service | exec | yes |  |
| `agent.plan` | agent-service | read | yes |  |
| `agent.delegate` | agent-service | read | yes |  |
| `agent.moa` | agent-service | read | yes |  |
| `agent.approve` | agent-service | read | yes |  |
| `jobs.search` | jobs | read | yes |  |
| `jobs.match` | jobs | read | yes |  |
| `jobs.list` | jobs | read | yes |  |
| `jobs.start` | jobs | write | yes |  |
| `jobs.skip` | jobs | write | yes |  |
| `jobs.cv.set` | jobs | write | yes |  |
| `jobs.cv.show` | jobs | read | yes |  |
| `jobs.prepare` | jobs | exec | yes |  |
| `jobs.send` | jobs | destructive | yes |  |
| `marketing.channel_report` | marketing | read | yes |  |
| `marketing.plan` | marketing | read | yes |  |
| `marketing.status` | marketing | read | yes |  |
| `marketing.analyze` | marketing | read | yes |  |
| `github.verify` | github | exec | yes |  |
| `github.research` | github | read | yes |  |
| `trading.plan` | trading | read | yes |  |
| `trading.research` | trading | read | yes |  |
| `tools.search` | meta | read | yes |  |
| `control.focus` | desktop | exec | no | Windows-only (this host is linux) |
| `control.inspect` | desktop | read | no | Windows-only (this host is linux) |
| `mouse.move` | desktop | exec | no | Windows-only (this host is linux) |
| `control.list_windows` | desktop | read | no | Windows-only (this host is linux) |
| `control.type` | desktop | exec | no | Windows-only (this host is linux) |
| `control.read` | desktop | read | no | Windows-only (this host is linux) |
| `control.click_button` | desktop | exec | no | Windows-only (this host is linux) |
| `research.run` | research | read | yes |  |
| `exec.backends` | shell | read | yes |  |
| `exec.start` | shell | exec | yes |  |
| `exec.wait` | shell | exec | yes |  |
| `exec.cancel` | shell | exec | yes |  |
| `exec.logs` | shell | read | yes |  |
| `flows.add` | flows | exec | yes |  |
| `flows.list` | flows | read | yes |  |
| `flows.enable` | flows | write | yes |  |
| `flows.remove` | flows | write | yes |  |
| `flows.trigger` | flows | exec | yes |  |
| `flows.webhook.recorded` | flows | write | yes |  |
| `channel.send` | channels | exec | yes |  |
| `majin.heartbeat` | majin-service | write | yes |  |
| `computer.use` | computer | exec | no | Windows-only (this host is linux) |
| `cursor.overlay` | computer | exec | no | Windows-only (this host is linux) |
| `reset.plan` | host-service | read | yes |  |
| `reset.apply` | host-service | exec | yes |  |
| `majin.self_audit` | sys | read | no | Tool is missing from the loaded lane export on this build |
| `memory.sync` | memory-service | write | yes |  |
| `ma.learn` | learn | write | yes |  |
| `ma.verify_lesson` | learn | write | yes |  |
| `ma.lessons` | learn | read | yes |  |
| `team.manage` | agent-service | write | yes |  |
| `team.run` | agent-service | exec | yes |  |
| `power.propose` | power | write | yes |  |
| `power.approve` | power | write | yes |  |
| `power.apply` | power | exec | yes |  |
| `browser.inspect` | browser | read | yes |  |
| `browser.check` | browser | write | yes |  |
| `browser.select` | browser | write | yes |  |
| `browser.press` | browser | write | yes |  |
| `browser.download` | browser | write | yes |  |
| `browser.tabs` | browser | write | yes |  |
| `desktop.open_notepad` | desktop | exec | no | Windows-only (this host is linux) |
| `desktop.capture_window` | desktop | read | no | Windows-only (this host is linux) |

## V2 builtins

| Tool | Tier | Purpose |
| --- | --- | --- |
| `read_file` | read | read a small file inside the workspace root |
| `write_file` | write | write a small text file inside the workspace root |
| `verify_now` | read | run a V2 verifier kind (file/json/http/pixel/dom/memory) on a spec |

## MCP surface exposed to OpenCode

| Tool | Purpose |
| --- | --- |
| `majin_status` | Read the actual MAJIN bridge status, owner grants and available tool count. Performs no action. |
| `majin_tools_search` | Search the real owner-authorized MAJIN tool catalog. This is not a capability wish-list. Follow with majin_tool_schema, then majin_tool_call. |
| `majin_tool_schema` | Read the exact inputSchema for one authorized MAJIN tool. Does not execute it. |
| `majin_tool_call` | Execute one owner-authorized MAJIN tool through the existing persistent driver. Read its schema first. Supply a stable operationId; reuse it only for identical arguments. Never invent a new ID to retr |
| `v6_status` | Read the real persisted V6 work state: queue counts, worker health, recent task events and checks. No action is performed. |
| `v6_queue_add` | Queue a bounded background task. Use kind "tool" with payload {tool, arguments} for a MAJIN tool, or "job.discover"/"job.evaluate"/"gmail.verify". Deduplicate with a stable dedupeKey. |
| `v6_queue_list` | List durable tasks, optionally filtered by state or kind. |
| `v6_task_get` | Read one task including attempts, progress, lease and last error. Use this instead of guessing why work stopped. |
| `v6_task_cancel` | Cancel queued or retryable work. A running task is cancelled at the next safe point; an uncertain external effect is never replayed by cancelling. |
| `v6_work_start` | Start a detached, bounded V6 worker process that continues queued work without another chat turn. Requires explicit task and runtime budgets. |
| `v6_work_stop` | Ask running V6 workers to stop after their current task by writing the STOP marker. Does not fabricate a completion. |

## Lanes

| Lane | Available | Loaded tools | Reason |
| --- | --- | --- | --- |
| desktop | no | 0 | Windows-only (this host is linux) |
| computer | no | 0 | Windows-only (this host is linux) |
| screen | no | 0 | Windows-only (this host is linux) |
| net | yes | 5 |  |
| files | yes | 13 |  |
| shell | yes | 5 |  |
| shelltools | yes | 5 |  |
| sys | yes | 6 |  |
| power | yes | 3 |  |
| web | yes | 16 |  |
| research | yes | 1 |  |
| jobs | yes | 9 |  |
| flows | yes | 6 |  |
| github | yes | 2 |  |
| channels | yes | 1 |  |
| audit | yes | 1 |  |
| learn | yes | 3 |  |
| marketing | yes | 4 |  |
| re | yes | 23 |  |
| trading | yes | 2 |  |

## Historical declarations

unique `name:` declarations added in git history for tool source paths (lower bound): **176** unique names.

## Notes

- A registered tool is not proof of a working integration.
- deep mode reflects this host at this moment; Windows-only tools are unavailable on non-Windows hosts.
- Credential boundaries are marked by lane; no credentials are inspected.
- Historical counts are unique declarations found in git history, not runtime registrations.
- No Windows acceptance has been performed from this environment.
