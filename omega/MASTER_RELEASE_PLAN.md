# OMEGA — MASTER BUILD CONTRACT (Hermes-grade autonomous agent, original Omega implementation)

This document is the operating specification for releases after Omega V3.
The target is the functionality and reliability class of modern autonomous
agents (including Hermes Agent), NOT a copied product or a promise of sentience.

## Mission and non-negotiable rules

Omega is a **real, useful, respectful agent**, not a scripted personality demo.
It should respond in natural Swedish to Swedish messages, keep task context,
reliably operate approved tools, learn from verified work, and run out-of-band
inside a separately provisioned worker VM when the user chooses.

- Build from the existing `omega/` engine and its tool and SQLite history.
  Do not throw away functional skills, memories, or tool permissions.
- **One Enter = one message**, with an instrumented input-to-queue latency.
- The terminal TUI must be fast and never block the input thread with database
  access, network calls, wrapping enormous transcripts, or rendering.
- No hard-coded fake replies, fake tool results, inflated levels or learning rates.
  Growth is proven by benchmark comparisons and accepted reusable skills.
- No silent provider fallback, no fake green status, no secrets in Git/logs/echo.
- Any irreversible effect, money movement, message sending, job submission or
  changes to account security still requires the appropriate scoped approval.
- Never equate VNC with isolation: host desktop VNC disturbs the user.
  A separate guest VM with independently verified screen/input is mandatory.
- Work in reviewable PRs with CI; merge only after required checks pass and
  rollback is available. Do not advertise a 1M-user release without evidence.

## Five deliverable phases (complete in order, each independently mergeable)

### P0: Input/UX reliability — BLOCKER

1. Single-pane keyboard-first TUI, Omega pink/mint/charcoal theme, no Electron.
2. Explicit first-Enter submission and exactly-once queue semantics, including
   repeated Enter and rapid consecutive messages; multiline uses a separate key.
3. Quantile telemetry for key-to-queue and key-to-visible-echo, without content
   or API-key capture. Freeze UI rendering while large DB/tool work runs.
4. Stable stream rendering for 1, 100, 1,000 and 10,000 stored turns; avoid
   O(total transcript) rewrap per token.
5. Terminal resize, long Swedish text, paste, emoji, clipboard, IME, Ctrl+C,
   exceptions, narrow windows, TTY/no-TTY and no stdout corruption tests.
6. Manual Windows acceptance: 100 consecutive messages; every single Enter
   queues exactly once; p95 submission/echo latency under 100 ms on a stated
   reference machine, or report measured failures and do not pass the gate.

### P1: Hermes-class agent memory and skill learning

1. Separate user profile, agent working memory and immutable session transcript.
2. Session search and context retrieval: recall provenance and allow correction.
3. Skill extraction only from actually successful, verified procedures.
4. Versioned skills with rollback, quality gates and a test corpus.
5. Agent tool calls produce evidence; distinguish observed vs inferred claims.
6. Measure improvement on held-out tasks; compare model, skill and tool baselines.
   No wall-clock auto-level promises and no unverifiable intelligence claims.

### P2: Agent runtime and safe delegation

1. First-class model provider profiles (OpenRouter 1017 exact ID and Go profile).
2. Per-request budget/quota control, retries with idempotency and explicit errors.
3. Isolated subagents with restricted tools, timeouts, budgets, trace IDs and
   final summaries; stop/cancel behavior and durable work state.
4. Skills as on-demand documents with minimal context injection.
5. Explicit checkpoints and restore before writable local changes.
6. Durable task queue, scheduled tasks and restart recovery with no duplicate
   external effects.

### P3: Separate VNC/VM work environment

1. Confirm guest VM identity and private/loopback tunneled endpoint. No bare
   Internet-facing VNC. Require explicit owner opt-in.
2. Worker captures and controls only the guest, not the interactive host desktop.
   During VM mode, block host desktop/screen/browser actions fail-closed.
3. Make environment state obvious in TUI: HOST READ-ONLY / VM ACTIVE / DISCONNECTED.
4. Browser runs inside guest. Login state is not secretly copied from host.
5. Tool screenshots have provenance, retention and opt-out controls.
6. VM disconnect/reconnect, permissions, sleep/wake, and agent cancel tested on
   real Windows/VM setup; coordinate-only VNC is not equivalent to DOM access.

### P4: Distribution, security, capacity and scale

1. Signed Windows installer, rollbackable versioned releases and migration tests.
2. Key vault and log redaction red-team tests; least privilege and network policy.
3. Dependency and supply-chain scanning, secure defaults and incident response.
4. Opt-in telemetry with privacy controls and no raw prompt/secret collection.
5. Automated Windows E2E with real terminal input injection; smoke tests of
   each provider; VM integration tests on a dedicated runner.
6. Load tests with defined user concurrency, request distribution and provider
   rate limits, and modeled infrastructure costs. Public scale claims require
   measured throughput, availability, recovery and controlled rollout.

## Release rules

For each PR: record source SHA, changed behavior, new tests, risks, rollback,
per-platform CI results and manual test requirements.
A green unit suite is necessary but insufficient for hardware-specific E2E.
Never merge P0 regression failures. Stop on failing security/permission tests.
Use a staged alpha -> private beta -> public beta -> GA progression.

## Reference architecture (inspiration, not copied assets)

Hermes Agent by Nous Research demonstrates useful patterns: persistent
memory, searchable sessions, skills built from experience, optional isolated
execution, toolsets, delegations and scheduled tasks. Adapt patterns on the
existing Omega stack; do not rename Omega, copy Hermes branding or assume
these capabilities are already built merely because they are in this plan.

## Immediate next implementation

Start a dedicated PR for P0 with measured input event -> queue -> echo traces.
Build a focused Windows-console E2E harness. Reproduce the user's multi-Enter
issue and verify one-key fixes before declaring it solved. Then work through
P1–P4; keep every claim tied to evidence.
