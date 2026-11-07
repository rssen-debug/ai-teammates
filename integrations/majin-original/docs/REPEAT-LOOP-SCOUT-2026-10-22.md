# MAJIN repeat-loop improvement — 2026-10-22

Research references:

- [OpenRouterTeam/typescript-agent](https://github.com/OpenRouterTeam/typescript-agent): deterministic doom-loop detection with repeated calls and round-set streaks. MAJIN already has a `RepeatDetector` plus a recovery budget; we adapted the relevant **canonical argument identity** idea without taking a framework dependency.
- [yunaremaia/agent-call-graph](https://github.com/yunaremaia/agent-call-graph): post-run analyses of redundant tool calls and circular reasoning. Candidate for an offline, redacted MAJIN trace auditor.
- [NousResearch/hermes-agent issue #41490](https://github.com/NousResearch/hermes-agent/issues/41490): repeated identical blocked calls and the need for differentiated recovery feedback. A reason not to silently retry.
- [folathecoder/agentling](https://github.com/folathecoder/agentling): returning actionable tool errors rather than crashing the agent loop.

This round: canonicalize nested object keys for repeat detection, so JSON key reordering does not evade the existing hard stop; preserve array order and cycle safety. Display the strategy-recovery phase with a subtle lilac pulse inside the existing composer (no additional panel).

Tests check equivalent JSON argument order, different array order and cyclic fixture robustness. This is a bounded safety/reliability enhancement, not a claim that all agent loops or desktop tasks are solved.
