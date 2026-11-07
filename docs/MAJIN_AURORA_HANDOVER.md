# MAJIN Aurora Studio — v0.9.0 handover

Base: main 5941439 (v0.8.0). Scope: UI/UX, preserving the existing server, providers, task registry and tool execution. The supplied multi-screen reference informed the restrained dark/pink identity and organic motion; its illustrative counts, model IDs, agents and percentages were not copied into production data.

## Implemented

- A quiet chat with one coherent layout: composer lives inside the conversation column, navigation spans the window height, and the workspace is closed by default.
- Subtle organic CSS rings driven only by actual connecting/thinking/working/waiting/done/error/stopped states. Idle is static. Reduced-motion and hidden-page behavior are supported. Error/cancelled states cannot turn into success because a late event arrives.
- Contextual Workspace tabs: Activity, Files, Preview and Settings. Settings contains the existing advanced routing, permissions, MOA, providers, channels, usage, self-test, appearance, voice and Quit controls. It does not switch the main chat into a technical dashboard.
- Interactive task cards read `/api/tasks` snapshots, show exact states and observed tool counts, expose task details, and stop the selected task through `/api/chat/stop`. No invented specialist roles, progress percentages or dependency claims. Chat and Workspace share acknowledged cancellation: a failed Stop preserves the actual response and never reports a false stopped state. The visual connecting lines are list organization, not declared backend dependencies. Stale snapshots cannot resurrect terminal tasks.
- Files come from successful tool_result events with real paths. Preview reads the file via the existing authorized `/api/file` endpoint. HTML is opt-in, sandboxed, and scripts/external resources stay disabled. Other supported files use escaped read-only text. Download returns original bytes; Widen preview changes the actual workspace width.
- Model explorer: intersecting Free, Tools, Vision and 128k+ context filters; search, name/input-price/context sorting; exact-ID selection; detailed price/context/capability view; pagination without a catalog cutoff. Missing metadata is unknown, never a fabricated capability or zero price.
- Chat search filters real session metadata. New chat keyboard shortcut, narrow-window sidebar, panel/tab keyboard navigation, focus restoration and immediate Escape during asynchronous model loading are implemented.

## Source map

- `src/ui/phoenix.css`: Aurora tokens, surfaces, typography, layout, contextual views and motion.
- `src/ui/studio.js`: workspace state, task/file/preview interactions and navigation.
- `src/ui/imagine.js`: existing event trail, now contextual; state and file preview delegate to Studio.
- `src/ui/onboard.js` / `catalog.js`: model explorer and deterministic metadata filtering.
- `scripts/phoenix-browser.mjs`: browser behavioral acceptance and screenshot evidence.

## Verification

```
npm ci
npm run check
npm run i18n
npx playwright install chromium
npm run test:ui
npm test
npm run exe:bundle
```

For installed Windows Edge, set `MAJIN_UI_BROWSER=msedge`. Set `MAJIN_UI_OUTPUT` for screenshot location. `MAJIN_UI_LIVE_CATALOG=1` opts into a real OpenRouter catalog check; normal CI uses deterministic fixtures and makes no paid inference calls.

Local Windows Edge acceptance covers 1,200 catalog entries; combined capability filters and sorting; model details and exact IDs; rapid Escape/open; modal nesting; task state/detail/stop requests; original file download; real authorized HTML preview with script execution blocked; wide preview; contextual Settings/appearance; reduced motion; 390px and 1920px windows; error recovery; streaming; actual local demo backend and Stop; 300-message scroll preservation. Focused UI/catalog tests: 37 passed. Source syntax and i18n passed. Bundle builds without a framework migration.

Live catalog check returned 470 models / 20 with zero reported catalog charges on 2026-10-19. This verifies metadata access, not account inference access. No new successful external-model inference or installed-owner upgrade is claimed.

## Screenshot interpretation

- Home and narrow-window views: actual running application with disposable configuration.
- `aurora-live-catalog.png`: real provider catalog; background chat uses the clearly labeled local demo backend.
- Activity screenshots: controlled API task fixtures verify exact status rendering and control routing; they do not claim a live specialist swarm mission.
- Preview screenshots: a real local HTML acceptance file read through the backend; they do not claim a deployed website.
- Model detail fixture images prove metadata, filtering and selection behavior, not live availability of synthetic test models.

## Release and remaining limits

Version 0.9.0 uses the existing CI Windows installer/update release path. Merge only after current-head check and exe jobs pass. Final PR/merge/release evidence is recorded in the delivery report.

Still outside this UI slice: external-provider inference quota/credential diagnosis, an upgrade on the owner's installed copy, full interactive web-app hosting (the file preview is deliberately read-only), persistent cross-session file indexing, a screen-reader audit, and backend dependency edges not currently exposed by the task API. Existing advanced functions are retained, not replaced with placeholder controls.
