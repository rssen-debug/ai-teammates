/**
 * MAJIN V4 — conversation context packing.
 *
 * A long conversation on a phone is normal. Sending the last 30 messages
 * whatever their size means a few long answers can exceed a small model's
 * window, and the whole turn then fails with a provider error the user cannot
 * act on ("context length exceeded").
 *
 * The token estimator is V2's (`src/v2/context/engine.js`), so it is the same
 * documented 4-chars-per-token rule the rest of MAJIN uses. V2's `pack()` is
 * NOT used here on purpose: it flattens prioritised sections into one string
 * with `## name` headers, which destroys the role structure a chat model needs.
 * What is reused is the measurement, not the transport.
 *
 * Rules, in order:
 *   1. the newest message is always kept, even if it alone exceeds the budget
 *      (truncated from the tail with a visible marker, never silently cut)
 *   2. older messages are added while they fit
 *   3. the system prompt is the caller's business and is never touched here
 */
import { estimateTokens } from '../v2/context/engine.js';

export const DEFAULT_CONTEXT_TOKENS = 8000;

/**
 * @param {object} o
 * @param {Array<{role:string, content:string}>} o.messages  oldest first
 * @param {number} [o.budgetTokens]
 * @returns {{messages: Array, tokens: number, dropped: number, truncated: boolean}}
 */
export function packHistory({ messages = [], budgetTokens = DEFAULT_CONTEXT_TOKENS } = {}) {
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) {
    throw new Error('packHistory requires a positive budgetTokens');
  }

  const usable = messages.filter((m) => m && typeof m.content === 'string' && m.content.length > 0);
  if (!usable.length) return { messages: [], tokens: 0, dropped: 0, truncated: false };

  const newest = usable[usable.length - 1];
  let newestContent = newest.content;
  let truncated = false;

  // Rule 1: the current turn must reach the model. If it alone is too large,
  // cut the tail and say so — a provider error explains nothing to the user.
  if (estimateTokens(newestContent) > budgetTokens) {
    // The marker is part of what gets sent, so it must fit inside the budget
    // too — otherwise "truncated to the budget" quietly overshoots it.
    const MARKER_RESERVE = 64;
    const maxChars = Math.max(0, budgetTokens * 4 - MARKER_RESERVE);
    const elided = newestContent.length - maxChars;
    newestContent = `${newestContent.slice(0, maxChars)}\n[truncated: ${elided} chars elided]`;
    truncated = true;
  }

  const kept = [{ ...newest, content: newestContent }];
  let used = estimateTokens(newestContent);
  let dropped = 0;

  // Rule 2: walk backwards from the newest, so recency wins.
  for (let i = usable.length - 2; i >= 0; i -= 1) {
    const m = usable[i];
    const cost = estimateTokens(m.content);
    if (used + cost > budgetTokens) {
      dropped = i + 1;
      break;
    }
    kept.push(m);
    used += cost;
  }

  kept.reverse();
  return { messages: kept, tokens: used, dropped, truncated };
}

/**
 * Build the message array for a model call: system prompt + packed history.
 * The system prompt is never counted against the history budget, because it is
 * the instruction set, not conversation.
 */
export function buildMessages({ system, messages, budgetTokens }) {
  const packed = packHistory({ messages, budgetTokens });
  return {
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...packed.messages],
    tokens: packed.tokens,
    dropped: packed.dropped,
    truncated: packed.truncated,
  };
}
