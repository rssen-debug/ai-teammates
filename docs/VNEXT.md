# MAJIN VNEXT — THE INVISIBLE SUPERAGENT (governing product spec)

_Owner's directive, condensed. Full text lives in the conversation history;
this file is the operative version. docs/IMAGINATION.md is its Phase D detail._

> One Chat. Every Capability. Zero Complexity.
> The existing MAJIN codebase is our investment. Preserve it. Build on top of
> it. Replace only what demonstrably needs replacing.
> Audit → Reuse → Extend → Integrate → Verify → Release.

## Non-negotiables

1. **This is an upgrade, not a greenfield project.** No second agent engine,
   no second update system, no second provider system, no wholesale Hermes/
   OpenClaw import. Extend what exists; integrate only proven gaps.
2. **Consumer product feel:** one chat window, model picker, clear activity
   indicator. Everything else lives in Expert Mode (already behind `b-expert`).
3. **Single model is first class:** one compatible model does everything by
   default; routing must never silently upgrade to a pricier model;
   MOA/multi-model runs only when the user opted in.
4. **Extremely low token overhead:** visualisations themselves must never
   generate extra LLM calls; measure and compare token usage with/without.
5. **Zero-config first run:** provider → API key → verified → model list →
   Start. If working config exists, onboarding is skipped; keys never move
   or disappear without a real migration.
6. **Imagination Engine is a presentation layer, not a new agent engine.**
   Thin adapters over the existing SSE/tool events.
7. **One-click updates must be proven end-to-end** (old → release → chip →
   download → shutdown → install → restart → data preserved). Shipped and
   verified in v0.2.0–v0.3.0; keep extending, never duplicate.
8. **No claim without executable evidence.** Mocks are mocks; say so.

## Implementation order (owner-pinned)

- **Phase A — Audit and preserve** ✅ see docs/AUDIT.md
- **Phase B — Make the simple experience excellent:** providers flow,
  onboarding, live model selector, single-model routing. Must be fully
  working before new advanced UI.
- **Phase C — Complete agent capabilities:** fill verified gaps in browser/
  computer-use and error recovery. No new safety engine; reuse guard.js.
- **Phase D — Imagination Engine:** visual layer over existing events.
  Slice 1 (Live Agent Vision + Living Core) shipped in v0.3.0.
- **Phase E — Smart optional orchestration:** simple Main/Worker(/Verifier)
  choice over existing agent.js/loop.js/moa.js/router.js.
- **Phase F — Optimize and release:** benchmarks (task success, browser,
  coding, long tasks, single model, token efficiency, usability, Windows
  reliability), build, updater verified, versioned release.
