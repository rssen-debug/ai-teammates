/**
 * Unified agent kernel.
 *
 * This is the single autonomous core that used to be split across three
 * codebases:
 *
 *  - **MAJIN V6** (`integrations/majin-original/src/v6`): the durable queue,
 *    lease/recovery/effect-ledger invariants, bounded supervisor with watchdog,
 *    heartbeat-derived health, the privacy scrubber and the lane-based
 *    authorization policy. Ported here with the same rules and covered by the
 *    same kinds of tests.
 *  - **Studdy Buddy Omega** (`studdy-buddy/omega/buddy.py`): the verification
 *    gate — a claim without evidence is never complete.
 *  - **Legacy Buddy** (`packages/core` + `packages/cli`): observation, native
 *    desktop control, permissions and the TUI. It keeps working unchanged and
 *    now runs on top of this kernel.
 *
 * Nothing in this package talks to a model. The kernel executes work that was
 * already queued; model calls stay in the provider layer, which is why the same
 * rules can be tested with zero network access.
 */
export * from './util.js';
export * from './redact.js';
export * from './events.js';
export * from './queue.js';
export * from './worker-state.js';
export * from './policy.js';
export * from './supervisor.js';
export * from './report.js';
export * from './activity.js';
export * from './handlers.js';
export * from './verify.js';
export * from './home.js';
