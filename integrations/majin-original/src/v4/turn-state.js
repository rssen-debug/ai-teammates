/**
 * MAJIN V4 — per-turn context that tools can read without changing their shape.
 *
 * V2's tool contract is `execute(input)`. V4 needs two tools that act on the
 * *turn* rather than on their input: `tools_activate` (make a discovered tool
 * callable in the next model round) and `agent_delegate` (run a bounded
 * sub-task inside the same goal). Threading a turn handle through every
 * signature would mean rewriting the V2 runner and every adapted V1 tool.
 *
 * AsyncLocalStorage does it without touching either: the agent wraps the one
 * call it already makes, and only the tools that ask for the turn see it.
 *
 * What is deliberately NOT here: secrets, messages, or the model. A tool that
 * reads the turn gets an exposure handle, the goal id and an emit function.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/** Run `fn` with `state` visible to `turnState()` inside it. */
export function runInTurn(state, fn) {
  return storage.run(state, fn);
}

/** The current turn, or null when a tool is called outside an agent turn. */
export function turnState() {
  return storage.getStore() || null;
}

/** Browser continuity is scoped to one conversation, not one model turn.
 * Follow-up instructions must reuse the same form/page and never spawn a new
 * window just because a new goal ID was assigned. Goals remain isolated when
 * there is no conversation context (e.g. standalone tests/delegates).
 */
export function hostSessionId(base = 'v4', state = turnState()) {
  if (state?.conversationId) return `${base}:conversation:${state.conversationId}`;
  return state?.goal?.id ? `${base}:${state.goal.id}` : base;
}
