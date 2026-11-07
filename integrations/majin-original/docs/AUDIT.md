# Phase A — Repository audit (2026-06-18, main @ 74174fa, v0.3.0)

Method: code + test inspection of the live main; where something was not run
end-to-end on a real Windows machine it is marked UNVERIFIED, not claimed.

## KEEP — working, tested, do not rebuild

| Asset | Evidence |
|---|---|
| Core runtime (`src/core/runtime.js`) wiring agent/memory/tools/scheduler/channels/guard | boots headless; `/api/state` 200 |
| Agent loop + tool calling (`agent.js`, `loop.js`) | 77 tools listed live; tool events stream |
| Model routing (`router.js`, `config.js` routes per job) | route events visible in UI (c-route chip) |
| MOA (`moa.js`) incl. off policy | policy switch in UI; tests |
| Provider presets + adapters (`presets.js`, `provider/`) incl. `GET /models` URL map (`listModelsUrl`) | presets file; API action `majin.provider models` at server/index.js:310 |
| Memory + skills (`memory.js`) | MEMORY panel fills; tests |
| Approvals/permissions (`guard.js`) | approval:request flow works in window |
| Scheduler, Telegram, WhatsApp | state shows channels; schedule events |
| SSE `/api/events` + run event funnel `onEvent()` | feeds Imagination slice 1 |
| Update engine (`update.js`): check/download/install + one-click chip | released v0.2.0; repo pointer fixed v0.2.1; deterministic tests |
| Windows packaging: pkg + Inno + CI on every tag | v0.1.1…v0.3.0 built by CI |
| Imagination slice 1 (Live Agent Vision + Living Core) | v0.3.0, test/imagination.test.js |
| Expert-mode hiding of technical panels | v0.2.0 (`b-expert`) |

## EXTEND — exists, needs connection/polish (highest value per effort)

| Asset | Gap | Planned in |
|---|---|---|
| Model catalog API (`/api/provider` action `models`) | no simple searchable picker in the chat header; user must pick smart defaults today | Phase B2 |
| Single-model routing | possible via config routes, but no one-tap "one model for everything" + no proof routing never upgrades silently | Phase B1/B3 |
| First run | NO onboarding at all — user lands on an empty configured-less window | Phase B1 |
| Cost visibility | usage is in footer/panel; needs per-task chip + budget cap UI | Phase B4 |
| Live Agent Vision | timeline exists; needs clickable steps (approve/preview links) | Phase D slice 2 |
| Computer/browser-use tools | present but behaviour on real Windows UNVERIFIED | Phase C |

## REPLACE — nothing so far
(No evidence that any kept component blocks the product goals.)

## REMOVE — nothing so far
(Dead buttons were a symptom of the `/state&tools=0` bug — fixed in v0.2.0,
not a code-deletion case.)

## UNVERIFIED on real Windows (needs a human pass before claims)
- tray icon + window behaviour across sleep/wake
- one-click update on the user's own machine (simulated flow tested in CI only)
- computer-use / browser tools on a real desktop
- WhatsApp pairing happy path (needs a phone)

## Duplicated / parallel systems
- None found (the spec's fear). One update path, one provider path, one config.
