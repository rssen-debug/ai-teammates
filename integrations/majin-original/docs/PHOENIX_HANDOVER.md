# Phoenix UI/UX handover — v0.8.0

Scope: improve the existing Windows app's UI and interactions. No framework migration, swarm engine rewrite, or new cloud product. Baseline: d97e157 (v0.7.2).

## What ships

Neutral graphite surfaces, pink identity accent, system sans typography, 15px/1.85 chat text, 760px conversation/composer width, 244px sidebar. Small windows use the same conversation without the sidebar. `src/ui/phoenix.css` owns the new visual layer; legacy expert controls remain available.

The explorer fetches `/api/models` on every open/provider change. The API returns the complete sanitized catalog, not 400 entries. Browser search/sort/filter is local. Render 60 rows at a time with Show more, allowing access to all results. Selection preserves the exact vendor/model ID, sets all single-model routes and disables MOA. Connecting a provider saves the credential and opens model selection without an automatic inference probe against a stale or paid preset. Configured means a key is present, not verified inference access. Catalogs without prices remain Price unknown. Free means explicit zero prompt/completion prices AND every additional reported pricing field is zero; suffixes alone do not establish price. This is a catalog filter, not a replacement for the backend budget policy. Availability and rate limits can still differ by account.

Errors preserve the submitted message; one card offers model selection, retry and technical details. 401/403, 402, 429, invalid-model and provider outages have different headings. Named SSE events are read even when the JSON has no type field. Error followed by answer/done cannot turn a failed request green. Answer-only events render correctly. Stop aborts the active request and calls the existing backend stop endpoint. Reading old messages suppresses forced chat scrolling. New chat and session changes reset the activity view; switching while busy is guarded.

## Reproduce

```
npm ci
npm test
npm run check
npm run i18n
npx playwright install chromium
npm run test:ui
npm run exe:bundle
```

On Windows with Edge already installed: set `MAJIN_UI_BROWSER=msedge`. Set `MAJIN_UI_OUTPUT` to choose screenshot output; otherwise evidence goes to ignored `work/ui-evidence`. The UI test launches a disposable real MAJIN server/data directory and closes its child process. It never installs over user data or makes paid inference requests.

## Verified here, 2026-10-19

- 14/14 focused catalog, onboarding and imagination tests passed.
- Windows Edge acceptance passed: real startup and token injection; 1,200-entry fixture catalog; pagination, search, Free filter, exact-ID persistence, Escape and focus; six provider error statuses; no false success or routing spam; streamed answer; new chat; 390px viewport; real backend demo response and Stop; 300-message history scroll preservation (165ms in one local run, not a hardware-wide performance guarantee).
- All source files parsed; i18n passed; standalone CJS bundle built with both new browser assets copied to dist/ui.
- Live OpenRouter `/models`: 470 models, 20 verified zero-charge entries. This is catalog access, not proof of account inference access.
- Supplied OpenCode key: one minimal Go inference request attempted using longcat-2.5-preview-free; request timed out without an HTTP response. No credential or balance diagnosis is established. A separate Zen endpoint attempt returned HTTP 403. No successful external-model reply is claimed.
- Local full-suite run after dependencies: 407 tests / 386 pass / 7 fail / 14 skipped. These include Windows-specific shell, path separator, raw CRLF/source assertions. The untouched baseline also fails these categories; environment keys additionally affected two baseline assertions. The setup-payload assertion ran only after build dependencies were installed and rejects Windows backslashes despite the payload containing the files. CI is the Linux regression gate; see the PR's actual checks, not these local counts, for merge readiness.

## Evidence

Browser acceptance screenshots use labeled synthetic model/error data to test edge cases. Live free-model screenshot uses the real provider catalog. Screenshots are reviewed for clipping, legibility and overlap; the initial flex-shrink overlap in catalog rows was corrected before delivery.

## Release / remaining checks

Version is 0.8.0 in the existing version/installer sources. Existing GitHub workflow builds Windows installers and publishes a new version on main; the check job now also runs browser acceptance. Merge only after required CI passes. Building a bundle or passing browser checks does not establish a completed installed-app upgrade.

Still to verify separately: packaged installer launch; upgrade from the owner's v0.7.2; restart/data preservation; successful external-model response with available account quota; offline/reconnect replay beyond EventSource's built-in reconnection; screen-reader and broad manual accessibility audit. Existing preset suggestions outside the new live explorer were not rewritten. Unknown-price catalogs intentionally yield no verified Free entries.

Next safe action: inspect PR CI, merge if green, then verify the generated Windows release and actual installed upgrade. Do not report all Project Phoenix requirements complete based on this UI slice.
