# MAJIN: upstream reuse vs. reinvention (2026-10-20)

Purpose: avoid copying multiple agent runtimes into one Windows executable. Reuse a
component only when its license, language, maintenance, platform and isolated
end-to-end tests justify the integration. New functionality must pass the existing
approval/guard pipeline and its result must be independently verifiable.

| Upstream | License | Approach | Decision |
| --- | --- | --- | --- |
| [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | Apache-2.0 | Maintained TypeScript Playwright-based browser MCP server | **Reuse the existing Playwright stack first.** MAJIN already has browser CDP tools, screenshots and live form-submit tests. Consider the MCP server as a separate opt-in integration after measuring capability gaps; do not create a second competing browser state automatically. |
| [browser-use/browser-use](https://github.com/browser-use/browser-use) | MIT | Python browser agent | **Not bundled:** separate Python runtime adds large packaging and desktop complexity. Consider an optional sidecar only if benchmarks show better recovery. |
| [langchain-ai/langgraphjs](https://github.com/langchain-ai/langgraphjs) | MIT | Durable state graphs | **Evaluate, do not replace blindly:** MAJIN already has mission compiler, effect journal, checkpoints, and swarm. Test crash recovery and actual completion before changing the core orchestration. |
| [microsoft/UFO](https://github.com/microsoft/UFO) | MIT | Windows desktop agent research | **Research reference, not drop-in:** different runtime and desktop support constraints. MAJIN's current Win32 lane has separately verified write/read/button click; benchmark against UFO before adopting. |

Integration gates:
1. License and pinned upstream version reviewed. No code copied without its
   license and attribution.
2. A deterministic fixture must prove failure and recovery, not just count
   methods or launch processes.
3. Agent must complete a real goal using an actual LLM, tools and artifacts.
4. No broad automatic permission grants: destructive/exec actions keep MAJIN's
   production approval requirement. QA runs in a fresh isolated workspace.
5. Release requires CI + interactive Windows acceptance + installer/update
   verification separately. A 23/23 subset never implies whole-product parity.

New gate: `a01` in `scripts/qa/qa-scenarios.mjs` is a live OpenCode Go
goal-completion/repair probe. It is designed to fail when the agent only claims
to have created a file; the exact artifact must exist inside the isolated
QA workspace. It is **not verified green** until its GitHub run completes.
