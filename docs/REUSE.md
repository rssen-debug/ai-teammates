# MAJIN REUSE registry (W6 power transfer)

Proven components absorbed rather than reinvented, with evidence of how each
piece was validated in this codebase.

| source (upstream) | what MAJIN absorbs | where it lives | validation evidence |
| --- | --- | --- | --- |
| **chokidar@4** (MIT, v4.0.3; paulmillr/chokidar) | cross-platform file watcher incl Windows/UNC, `awaitWriteFinish` | runtime dependency, used by `src/core/flows.js:TriggerHub` | file-add detected in live tmp-dir E2E (round 5), esbuild bundle-proof |
| **browser-use / set-of-marks pattern** (MIT-inspiration, pattern only) | numbered interactve elements + `data-majin-ref` click targeting | `src/core/browser-ground.js` (adapts pattern to MAJIN's OWN CDP bridge — zero framework copied) | unit 6/6 + live Chromium: ground→click-by-ref worked, marks drawn/cleared, re-ground stable (round 12) |
| **Microsoft/UFO (MIT)** | UIA/Win32 "survivor-lane" analysis: what actually survives measurement on windows-2025 | `docs/ABSORB-*.md` + implemented decisions in `src/core/tools/wincontrol.js` | win-control-poc v2.6 reproduced twice on windows-latest (round ~pre-raggoc) |
| **TauricResearch/TradingAgents (Apache-2.0)** | opt-out subprocess bridge to the REAL upstream tool | `src/core/tools/trading.js` (README pointer policy — upstream not copied) | W6 e2e: REAL spawned stub child exercises the envelope (ok/HOLD/not_installed/raw-text-refusal/timeout-honesty) + demo-provider refusal + junk-ticker rejection + ordersPlaced=0 through the tool surface (test/trading-e2e.test.js 5/5) |
| **@yao-pkg/pkg**, esbuild, js-yaml (devDeps) | exe packaging + bundling + YAML for config | build chain | esbuild bundle asserted (chokidar+flows included), pkg blocked only by network gate (decisioned HONESTLY) |

Rule: every absorbed component gets a row here + an evidence entry in the
matching test file. No "vibe-reuse". Licenses verified at absorb-time.
