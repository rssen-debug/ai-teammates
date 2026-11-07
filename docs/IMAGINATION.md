# MAJIN IMAGINATION ENGINE — master spec (from the product owner, verbatim)

This document is the source of truth for the V3 era. Implementation is phased;
the status of each phase lives in TODO.md and CHANGELOG.md.

## Design philosophy (top of the spec, highest authority)

> Do not simplify the intelligence or capabilities of MAJIN just to make
> development easier. Build whatever sophisticated architecture is necessary to
> deliver exceptional performance, reliability, autonomy and visual
> intelligence. But completely abstract that complexity away from the user.
> A computer contains millions of interconnected components, yet a child can
> open an application with one click. MAJIN should follow the same principle:
> extraordinary complexity underneath, extraordinary simplicity on the surface.
> The user should never configure the machinery. The machinery should configure
> itself around the user's goals.

> The ultimate MAJIN is not an AI with a hundred buttons. It is an AI that
> understands which single button you need right now.

## Critical requirement — intelligence without token waste

Local-first and token-efficient by design. One cheap model must give the same
advanced visual experience as an expensive one.

1. All animations, graphs, status indicators, local filtering and ordinary UI
   interactions run locally with zero extra LLM calls.
2. The LLM is used only when the task genuinely needs model-based
   understanding, generation or decision-making.
3. Predefined dynamic UI components filled with structured data.
4. MOA/multi-agent is opt-in, off by default.
5. Show actual token consumption and estimated cost per task.
6. Configurable budget cap; no hidden unnecessary API calls.
7. Compare token usage of plain MAJIN vs Imagination Engine for the same tasks.
8. Explicitly test with a single low-cost model.

The user must NEVER need to understand how Imagination Engine works. Choose
provider, paste key, start using MAJIN.

## The vision

User → Text → AI → More Text  becomes:

**User intention → Visual understanding → Interactive imagination → Real
execution → Living result.**

Show, don't just tell. The interface picks the right form for the answer:
job search → job cards; build an app → a live re-editable preview; compare
models → a visual comparison; a task → understandable progress.

## The 15 points (condensed)

1. **Vision:** every answer finds its own form (text, interactive view,
   animation, workspace, preview, or a combination).
2. **Imagination Engine module:** Intent Interpreter, Visual Planner, UI
   Composer, Live State Engine, Interaction Controller, Verification Layer —
   one coherent, testable architecture on top of the existing runtime.
3. **Living Canvas:** central interactive workspace (graphs, plans, previews,
   flows, structures, websites, dashboards, timelines, documents, comparisons,
   real-time tool updates). Plain chat always remains available.
4. **Imagination Before Execution:** Preview / Working / Verified are distinct,
   labelled states. A visualised possibility must never pose as a done result.
   "Mer rosa, mer lyxig" → prototype updates → "Perfekt, bygg den" → then and
   only then real changes.
5. **Generative UI:** declarative, versioned component model with schemas
   (JobCard, WebsitePreview, TaskTimeline, AgentGraph, ModelComparison,
   FileExplorer, ResearchBoard, SystemMap, ProgressVisualization, ApprovalCard,
   DataChart, WorkflowEditor…). The LLM proposes layout+data; it can never
   inject executable JS/HTML. Components show sources, uncertainty, and what
   is verified. A single component crash never takes the window down.
6. **Live Agent Vision:** real-time visual timeline of the agent's work from
   real events with timestamps and outcomes; clickable steps; no fake
   animations ever.
7. **Visual Agent Orchestration:** single model by default; multi-agent shows
   Planner → Executor → Verifier as a simple visual flow; change a role's
   model by clicking it; no multi-agent for simple tasks.
8. **Interact with ideas directly:** drag, click, approve, reorder, diff —
   every gesture becomes a controlled instruction; undo/redo/history where
   possible.
9. **The Living MAJIN Core:** a calm pulsing core reflecting real state
   (idle/listening/planning/working/waiting/complete/error). Energy-efficient
   CSS/Canvas first; respects reduced-motion; toggleable; never steals focus.
10. **Instant visual feedback:** first relevant feedback ≲300 ms where
    realistic; real task state immediately even when generation is slow; no
    fabricated placeholders.
11. **Zero-config experience:** install → provider → key → model (or accept
    recommendation) → use. Everything else pre-configured; works with one
    compatible single-agent model.
12. **Safety, privacy, control:** visible permissions; approval for
    sensitive/destructive actions; a real Stop button; no API keys in flows or
    screenshots; isolated execution for risky code; budgets/timeouts/ACLs;
    privacy-respecting logging; visualisation never bypasses approvals.
13. **Prototype first:** three real scenarios in the same stack before any
    rip-up — A) Website creation with visual editing, B) Browser agent with
    pausable real events, C) AI agent builder with visual model switching.
14. **Quality gates:** visuals match real events; clicks hit the right backend
    actions; an old task cannot paint the wrong canvas; long runs survive;
    previews execute no unauthorised code; keyboard works; window sizes work;
    CPU/memory sane; existing MAJIN features intact; one cheap model gets the
    full experience.
15. **Integrated in the real Windows app:** keep providers, tools, memory,
    single/multi-agent, computer-use, browser-use, safety, user data; ship via
    versioned GitHub releases installable by the one-click updater; honestly
    report what is fully implemented vs prototype vs unverified.

## Final product vision

Don’t build another chat interface. Build an AI imagination workspace where
ideas become visible, interactive and executable. Simple enough for a child,
practical enough for daily work, powerful enough for advanced users.

Design it. Implement it. Test it. Ship it.
