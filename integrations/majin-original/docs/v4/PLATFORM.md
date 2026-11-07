# MAJIN V4 — platform contract

The reason this is V4 and not "yet another rewrite" is that new capability should
be a module or a flag, not a fork.

## Versioned interfaces

| Interface | Version | Contract | Where |
|---|---|---|---|
| Kernel API | `1` | `registerTool/Provider/Voice/Memory/Surface`, manifest schema | `src/v4/kernel.js` |
| Goal schema | `majin.v2.goal/v1` | acceptance, receipts, transitions | `src/v2/runtime/goal.js` |
| Receipt schema | `majin.v2.receipt/v1` | hashed evidence, `verified` flag | `src/v2/runtime/receipts.js` |
| Conversation schema | `majin.v4.conversation/v1` | messages, requests, modelId | `src/v4/store.js` |
| Tool contract | `majin.v2.tool/v1` | zod input/output, tier, execute | `src/v2/tools/registry.js` |
| HTTP API | `v4` | `/api/health`, `/api/me`, `/api/auth/*`, `/api/chat`, `/api/models`, `/api/conversation(s)`, `/api/goal`, `/api/kernel`, `/api/sessions`, `/api/cancel`, `/api/approve`, `/api/model` | `src/v4/server.js` |

Breaking any of these means a new version field and a documented migration —
not a silent change.

## Adding capability without touching the core

1. **A new tool** → add to `createToolRegistry` (built-in) or ship a plugin.
2. **A new provider** → already data: add it to the V1 config; V4 discovers it.
3. **A new voice engine** → `registerVoice` in a plugin, behind a flag.
4. **A new surface** → `registerSurface`; the mobile PWA stays the default.
5. **An experimental feature** → `MAJIN_V4_FLAGS=<name>=1`, gated off by default.

## Plugin lifecycle (as implemented)

```
scan dir → validate manifest → permission check → flag check → API check
        → spawn worker (stripped env) → activate → capabilities registered
        ↳ any failure: worker stopped, registrations rolled back,
          directory moved to plugins-quarantine/ with a written reason
```

Statuses in `GET /api/kernel`: `active`, `failed`, `rejected`, `incompatible`,
`flagged-off`. Management: `npm run v4:plugins` (list), `... quarantine`,
`... restore <name>`.

## Voice lanes

| Lane | Where | Honest status |
|---|---|---|
| Browser `SpeechSynthesis` / `SpeechRecognition` | phone | default; tap-to-talk, no always-listening |
| `buffer` | server | offline, deterministic; proves the pipeline, silent WAV |
| `command` | server | operator-configured local binary (`MAJIN_V4_TTS_COMMAND`, `MAJIN_V4_STT_COMMAND`); preflight-gated, argv-only, scrubbed env |
| `edge-tts` | server | real voice, needs network; not verified in CI |

Configure a local engine (example, path without spaces):

```powershell
setx MAJIN_V4_TTS_COMMAND "C:\tools\piper\piper.exe -m C:\tools\piper\sv.onnx -f {OUT}"
setx MAJIN_V4_STT_COMMAND "C:\tools\whisper\whisper-cli.exe -m C:\tools\whisper\base.bin -f {WAV}"
```
Template comes from configuration only — never from a chat message or an HTTP body.

## Measured quality

`npm run v4:bench` runs seven fixed scenarios and records pass rate, p50/p95
latency, tool calls and receipt coverage to `docs/v4/benchmarks/<date>-<mode>.json`.
`--compare <file>` prints a regression diff against an earlier run. The report
states plainly that latency is local host overhead, not model latency.

## Scaling rules

- Stay a modular monolith while one process is enough. Splitting early buys
  latency, not reliability.
- Everything that must survive a restart lives on disk with a schema field.
- Anything that can fail gets a class from the V2 failure vocabulary.
- No capability is advertised before it has executable evidence in the matrix.

## Explicit non-claims

The platform is designed to *reduce* future rewrites. It is not future-proof and
it does not anticipate every requirement. When a real constraint appears, the
answer is a versioned interface and a migration — documented, tested, reversible.
