# Configuration

One JSON file, no env-specific format, no hidden state:

```
Windows: %LOCALAPPDATA%\MAJIN\majin.config.json  (installed)  ·  <repo>\majin.config.json (dev)
POSIX:   ~/.majin/majin.config.json
```

`MAJIN_CONFIG` points at another file, `MAJIN_HOME` at another data home (config, memory,
sessions, skills, rules, logs, out, uploads, cache all live under it). `MAJIN_PORT` and
`MAJIN_TOKEN` override `server.port` / `server.token` at load time — that is what the Task
Scheduler entry and the shims use.

Read it: `majin config get <key>` · `GET /api/config` · the panel.
Write it: `majin config set <key> <value>` · `PATCH /api/config` · **or say it in chat.**
Every write is validated, the previous file is kept as `<name>.bak.<timestamp>`, and a failed
validation returns per-field errors instead of half-applying the change.

## Top level

```jsonc
{
  "version": 1,
  "name": "MAJIN",                 // shown everywhere, including the window title
  "workspace": "<home>/workspace", // default root for fs.* and shell.* cwd
  "persona": { "identity": "…", "tone": "…", "style": "…", "rules": [ "…" ], "extra": "" },
  "providers": { … },              // 11 presets, apiKey lives here
  "models":  { "provider": "deepseek", "routes": { …13… } },
  "pricing": { "deepseek/deepseek-flash": { "in": 0.14, "out": 0.28 } },
  "routing": { … },                // auto-route, escalation, rules[]
  "moa":     { … },                // mixture of agents
  "tools":   { … },                // limits, not on/off switches
  "guard":   { … },                // modes, askOn, neverOn, protectedPaths
  "memory":  { … }, "skills": { … }, "schedule": { … }, "tasks": { … },
  "channels": { "telegram": { … }, "whatsapp": { … } },
  "agent":   { … }, "ui": { … }, "budget": { … }, "logging": { … }, "server": { … }
}
```

No key is required unless you change it. Unknown top-level keys are rejected — the error names
the key and lists what is close to it, so a typo never becomes silent config.

## Providers and models

`providers.<name>` = `{ label, kind, baseUrl, model, apiKey, models[] }`, where `kind` is
`openai` (any OpenAI-compatible endpoint), `anthropic`, `gemini` or `mock`. Presets:
`openrouter`, `kilocode`, `nous`, `groq`, `openai`, `anthropic`, `gemini`, `ollama`, `lmstudio`,
`deepseek`, `demo`.

* `apiKey` may be a literal, `{env:MY_VAR}` (resolved per read, never stored resolved) or `null`.
* `baseUrl` is the only thing you need to change for a proxy or a self-hosted gateway; e.g.
  OpenRouter is `https://openrouter.ai/api/v1` + model `deepseek/deepseek-chat-v3.1`.
* **Kilo Gateway** (`kilocode`) is the same shape: `https://ai-gateway.kilo.ai/api/v1`,
  `Authorization: Bearer <JWT>` — the API key from the Kilo dashboard *is* a JWT, so paste the
  whole thing. Model ids keep the vendor prefix, so a route is `kilocode/anthropic/claude-sonnet-4.5`
  and free tiers are real ids (`poolside/laguna-xs.2:free`). `majin provider models kilocode`
  pulls the catalog from `GET /models` (no key needed) and saves it in config. A 401 means the key,
  a 402 means the account is out of credit — MAJIN says which.
* **The Providers card is the primary way in** — no config file: pick a preset, paste the key, press
  save. `GET /api/state` returns `presets: [{ name, label, baseUrl, keyUrl, needsKey, models }]`
  built from `PRESETS` via `presetCard()`, so the UI never keeps its own provider list (it used to,
  and two presets were unreachable from the browser because of it).
* **A key is required unless the endpoint has none.** `needsKeyFor()` (in `presets.js`) is the single
  rule: the demo needs nothing, `ollama`/`lmstudio` ship a dummy key, and any loopback or RFC1918
  `baseUrl` counts as yours. Everything else refuses an empty box — in `majin.provider add` *and* in
  `POST /api/provider`, which is what the save button calls. Nothing is written when it refuses.
* **Provider failures are one sentence with a next action**, produced in exactly one place:
  `explainError()` in `provider/chat.js` (`auth`, `billing`, `model`, `toobig`, `rate`, `unreachable`,
  `upstream`, `no_key`, `provider`). `complete()` attaches the verdict as `err.majin`, and the loop
  ends the turn at once for every `stop` kind — a rejected key costs one call and about 30 ms, not
  four steps and 12 seconds. The turn result carries `errorKind` and `errorHint`; the SSE `error`
  event carries `kind`; `/api/provider/test` returns `kind` too. Wording changes go in `explainError`,
  never in a caller — `test/onboarding.test.js` pins both the sentences and the call count.

* The gateway answers a `stream:true` request with either SSE or plain JSON; both work. If it
  answers with nothing at all you get `sent an empty stream` with a hint, never a silent blank.
* `demo` is the offline mock: it answers without a key so the loop, the UI and the tests work on
  a plane. It is deliberately **not** counted as setup: `needsSetup` stays true until a real
  provider has a key.

`models.provider` picks the default model; `models.routes.<job>` overrides per job. Thirteen
jobs: `chat, tasks, tools, summarize, router, vision, code, re, analysis, plan, research, final,
aggregator`. A route value is `provider/model` (`"deepseek/deepseek-v4-pro"`) or just `model`
when it is unique across providers — and an explicit `provider/model` always wins over fuzzy
matching, so `openrouter/deepseek/deepseek-chat-v3.1` is not mangled.

`pricing` maps a ref to USD per million tokens (in/out). Without an entry MAJIN reports token
counts and leaves cost at 0 instead of guessing.

## Routing and escalation

`routing.auto` classifies each turn (`router` job — a cheap model on purpose) and writes the
choice to `models.routes`. `routing.rules[]` are yours: `{ id, match, job, weight }` where `match`
accepts `"/regex/flags"` or a plain substring, and `weight` (default 1.2) decides who wins when
several hit. Escalation is event-based, never time-based:

* `escalateAfterErrors` (2) — that many tool errors in a row promotes the step to
  `routing.escalateJob` (`analysis`)
* `escalateOnDisagreement` (0.35) — MOA disagreeing that much reruns the question on the heavier
  model
* `llmTiebreak` + `llmTiebreakAbove` (0.45) — a weak classification gets one extra model call
* `escalateOnErrors` — errors alone may also promote

## MOA (Mixture-of-Agents)

```jsonc
"moa": {
  "enabled": true, "policy": "always",          // always | hardOnly | auto | off
  "hardJobs": ["re","code","analysis","plan","final","research"],
  "width": 3,
  "references": [ { "model": "deepseek/deepseek-flash", "temperature": 0.1 }, … ],
  "aggregator": "deepseek/deepseek-v4-pro",
  "referenceMaxTokens": 900, "aggregatorMaxTokens": 3000, "referenceTemperature": 0.5,
  "disagreementFloor": 0.25
}
```

`policy` is the interesting one: `always` answers with MOA on every turn except trivial chat,
`hardOnly` runs it for the jobs in `hardJobs`, `auto` decides per turn from the tools used, the
attachment size and a `moa?`/`hard?` marker in your message, `off` disables it. `width` (1–6)
overrides how many `references` are used, so you can dial cost without editing the list.

The answer you see is the **aggregator's** text; references are kept separate and never leak into
the history. `disagreementFloor` is below which the merge flags disagreement (and can escalate).
A degraded MOA (some refs failed) still answers, and the UI shows the state.

## Guard

```jsonc
"guard": {
  "mode": "confirm",                  // strict (Assist) | confirm (Approval) | off (Full auto)
  "askOn":     ["/regex/"],           // force confirmation
  "neverOn":   ["/regex/"],           // hard block, no approval can override
  "protectedPaths": ["C:\\Windows", "/etc", …],
  "pathWriteRoots": ["auto"]          // auto = workspace + data dirs, or explicit dirs
}
```

Plus `tools.shell.requireApproval` (`dangerous` | `all` | `off`) and `tasks.approvalTimeoutMs`
(default 180000 = 30 min; the timeout means *no*). `guard.autoApprove` accepts `"fs.write"` or
`"fs.write:<hash>"` — a hash of the exact arguments, so approving one command does not approve the
family.

`strict` maps writes **and** exec; `confirm` maps exec and destructive only; `off` asks for
nothing but still honours `neverOn` and the protected-path rules. `majin doctor` shows the mode and
how many approvals are waiting; `GET /api/approvals` lists them, `POST /api/approve` answers them.

## Tools and agent

`tools.allow: "*"` — always. The keys under `tools` are limits: `maxOutputChars` (long results
spill to a file and the model gets a pointer), `shell.timeoutSec`, `files.maxReadBytes`,
`files.followSymlinks: false`, `web.provider: "auto"` (`searxng` for a self-hosted search
instance), `http.allowPrivate` (fetching localhost/LAN; set false to fence the agent off your
network), `re.maxFileBytes`, `re.external: "auto"`, `re.yaraRules: []` (extra `.yar` files or
directories).

`agent.maxSteps` (60) bounds one turn; the last budgeted step is reserved for a tool-free final answer; `contextTokens` (48000) triggers compaction. `subagents.{enabled,maxParallel:3,maxSteps:14,shareMemory:true}` back `agent.delegate`.
`historyInPrompt` (40) controls how many turns travel with the prompt; `stepJob` (`same`) keeps the initial specialist route for follow-up steps (or set a job such as `tasks` explicitly).
Tool batches run in parallel only when every tool is read-only and stateless; writes and browser actions are serialized. Exact failed calls are blocked from being retried unchanged.

`tasks.concurrency` (3) limits parallel tool work; `tasks.approvalTimeoutMs` the approval queue.

## Channels, schedule, budget

```jsonc
"channels": {
  "telegram": { "enabled": true, "botToken": null, "apiBase": "https://api.telegram.org",
                "allowedChatIds": [], "pairingCode": null, "pollTimeoutSec": 30,
                "parseMode": "HTML", "proxy": null, "reactions": true },
  "whatsapp": { "enabled": true, "transport": "baileys",          // baileys | cloud
                "baileys": { "sessionDir": "whatsapp", "verbose": false },
                "cloud": { "accessToken": null, "phoneNumberId": null, "verifyToken": null,
                            "apiVersion": "v23.0", "appSecret": null, "allowedNumbers": [] },
                "allowedJids": [], "replyPrefix": "", "maxMessageChars": 4000, "maxRetries": 6 },
  "shared":   { "forwardToChat": true, "requirePairing": true, "idleSessionCloseMin": 720,
                "deliverTo": null, "replyWhileStreaming": false },
  "webhook":  { "enabled": false, "host": "0.0.0.0", "port": 8788, "path": "/whatsapp",
                "tunnel": "none" }
},
"schedule": { "enabled": true, "timezone": "local", "maxConcurrent": 2, "tickMs": 20000,
             "readOnlyDefault": false },
"budget":   { "mode": "track", "monthlyUsd": 0, "warnAt": 0.8 }
```

`schedule.readOnlyDefault: true` makes every *new* job read-only: it may run any `read` tool and
every tool that changes state is refused with `read_only` (and the answer says so). Per job it is
`majin.schedule add … readOnly:true|false`; the default is `false` so nothing changes underneath
you. A job's `model` field is honoured too — it overrides the route for that turn only.

`enabled` on a channel means "start it if a token/creds exist" — nothing dials a tool off. With
`transport: "baileys"` and no session on disk, MAJIN shows a QR in the window; a QR nobody scans
retries with exponential backoff and then stops (`maxRetries`, default 6, ends in state `stopped`
rather than reconnecting every three seconds forever). `cloud` talks to Meta's Graph API instead and
needs `accessToken` + `phoneNumberId`; the webhook URL is `http://<host>:<webhook.port><path>`.
`allowedChatIds` / `allowedJids` are the allow-lists; empty means only the paired chat (a pairing
run stores your chat id). `budget.mode: "cap"` refuses to start a turn that would cross
`monthlyUsd`; `"track"` only warns at `warnAt` (80 %) and the UI chip turns amber.

## Dataset (learning from your own runs)

```jsonc
"dataset": {
  "capture": false,          // nothing is recorded until you or the user says so
  "dir": null,               // null = <data dir>/dataset
  "keepDays": 90,            // trimmed on start-up
  "include": { "answer": true, "toolArgs": true, "plan": true }
}
```

One JSONL line per turn: instruction, plan, tool sequence with arguments, answer, usage, error and a
`rating` that stays `null` until you label it. Redaction runs before every write and cannot be
switched off; a turn that says "do not save this" is skipped entirely. There is **no** `upload` key —
`dataset.upload` is rejected by validation, because the only way data leaves the machine is you
carrying the exported file. [docs/DATA.md](DATA.md) documents the record shape, the switches and the
CLI (`majin dataset on|off|list|export|purge`).

## UI

`ui.title`, `ui.tagline`, `ui.theme` (`jarvis` is the only built-in look; the ◐ button in the
header toggles light/dark and stores it in `localStorage`, not in config), `ui.voice`
(`enabled`, `lang`, `wakeWord`, `tts`, `rate`, `pitch`), `ui.transparency`
(`showTools: verbose|summary|off`, `showThinking: …`, `showTokens`), `ui.density`,
`ui.autoOpen`. `majin doctor` warns if the window cannot open or the port is taken.

## Saying it instead of writing it

Natural-language config is a route, not a hack: `POST /api/intent {"text":"…"}` shows what a
sentence **would** change, and the same parser runs inside a turn. It handles keys, per-job model
choices, whole-route ("use X for everything"), `om <condition>` → routing rule, MOA on/off and
width, delete-approval-off, "confirm everything dangerous", persona appends, `max N steps`, a
monthly budget cap, and "store no memories". Unrelated sentences return `matched: false` and patch
nothing — a mis-heard voice command must not rewrite config.
