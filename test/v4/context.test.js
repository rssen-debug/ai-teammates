/**
 * Conversation context must fit the model's window.
 *
 * A long conversation on a phone is normal, not exotic. `historyFor()` used to
 * send the last 30 messages whatever their size, so a chat with a few long
 * answers could exceed a small model's window and fail the whole turn with a
 * provider "context too long" error the user cannot act on.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { ToolRegistry } from '../../src/v2/tools/registry.js';
import { ConversationStore, GoalStore } from '../../src/v4/store.js';
import { createAgent } from '../../src/v4/agent.js';
import { estimateTokens } from '../../src/v2/context/engine.js';
import { tempHome } from './helpers.mjs';

function build({ maxContextTokens = 2000 } = {}) {
  const home = tempHome();
  const config = {
    version: 'test',
    paths: { home },
    workspaceDir: path.join(home, 'workspace'),
    limits: {
      maxMessageChars: 20_000,
      maxModelRounds: 2,
      maxToolCallsPerTurn: 2,
      toolTimeoutMs: 1000,
      maxContextTokens,
    },
    approvals: { policy: 'sandbox-auto' },
  };
  fs.mkdirSync(config.workspaceDir, { recursive: true });
  const conversations = new ConversationStore({ dir: path.join(home, 'conv'), maxMessages: 2000 });
  const goals = new GoalStore({ dir: path.join(home, 'goals') });
  const registry = new ToolRegistry();
  registry.define({
    name: 'noop',
    description: 'does nothing',
    tier: 'read',
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    execute: async () => ({ ok: true }),
  });
  const tools = { registry, root: config.workspaceDir, memory: null };
  const seen = [];
  const model = {
    info: { demo: false },
    infoFor: () => ({ demo: false }),
    async chat({ messages }) {
      seen.push(messages);
      return { text: 'ok', toolCalls: [], demo: false };
    },
  };
  const agent = createAgent({ config, conversations, goals, tools, model });
  return { home, config, conversations, goals, agent, seen, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test('context: a long conversation is trimmed to the configured budget', async () => {
  const h = build({ maxContextTokens: 2000 });
  try {
    const conv = h.conversations.create();
    // 40 turns of long messages: far beyond a 2000-token budget
    for (let i = 0; i < 40; i += 1) {
      h.conversations.appendMessage(conv.id, { role: 'user', content: `fråga ${i} ${'a'.repeat(2000)}` });
      h.conversations.appendMessage(conv.id, { role: 'assistant', content: `svar ${i} ${'b'.repeat(2000)}` });
    }

    await h.agent.runTurn({ text: 'ny fråga', conversationId: conv.id });

    const sent = h.seen[0];
    const history = sent.filter((m) => m.role !== 'system');
    const tokens = history.reduce((n, m) => n + estimateTokens(m.content), 0);
    assert.ok(tokens <= 2100, `history was ${tokens} tokens, budget 2000`);
    assert.ok(history.length < 80, `kept ${history.length} messages, not all 81`);
  } finally {
    h.cleanup();
  }
});

test('context: the newest message is always kept, the oldest is dropped first', async () => {
  // The old message is ~752 tokens on its own, so a 400-token budget must drop
  // it. (Verified against estimateTokens: chars/4, rounded up.)
  const h = build({ maxContextTokens: 400 });
  try {
    const conv = h.conversations.create();
    h.conversations.appendMessage(conv.id, { role: 'user', content: 'GAMMALT ' + 'x'.repeat(3000) });
    h.conversations.appendMessage(conv.id, { role: 'assistant', content: 'gammalt svar' });
    h.conversations.appendMessage(conv.id, { role: 'user', content: 'NYTT' });

    await h.agent.runTurn({ text: 'NYTT', conversationId: conv.id });

    const history = h.seen[0].filter((m) => m.role !== 'system');
    const joined = history.map((m) => m.content).join(' ');
    assert.ok(joined.includes('NYTT'), 'the newest message survives');
    assert.ok(!joined.includes('GAMMALT'), 'the oldest oversized message was dropped');
  } finally {
    h.cleanup();
  }
});

test('context: the system prompt is never trimmed', async () => {
  const h = build({ maxContextTokens: 300 });
  try {
    const conv = h.conversations.create();
    for (let i = 0; i < 60; i += 1) {
      h.conversations.appendMessage(conv.id, { role: 'user', content: 'z'.repeat(500) });
    }
    await h.agent.runTurn({ text: 'hej', conversationId: conv.id });
    const system = h.seen[0].find((m) => m.role === 'system');
    assert.ok(system && system.content.length > 500, 'the system prompt is intact');
  } finally {
    h.cleanup();
  }
});

test('context: a single oversized message is truncated, not sent whole to break the provider', async () => {
  const h = build({ maxContextTokens: 500 });
  try {
    const conv = h.conversations.create();
    h.conversations.appendMessage(conv.id, { role: 'user', content: 'Q'.repeat(8000) });
    await h.agent.runTurn({ text: 'kort', conversationId: conv.id });
    const history = h.seen[0].filter((m) => m.role !== 'system');
    const tokens = history.reduce((n, m) => n + estimateTokens(m.content), 0);
    assert.ok(tokens <= 700, `still bounded, got ${tokens}`);
    assert.ok(history.some((m) => m.content.includes('kort')), 'the current message is there');
  } finally {
    h.cleanup();
  }
});

/* --------------------------------------------------- the packer in isolation -- */

import { packHistory, buildMessages, DEFAULT_CONTEXT_TOKENS } from '../../src/v4/context.js';

test('context/pack: the newest message survives even when it alone exceeds the budget', () => {
  const { messages, truncated } = packHistory({
    budgetTokens: 100,
    messages: [{ role: 'user', content: 'q'.repeat(4000) }],
  });
  assert.equal(messages.length, 1);
  assert.equal(truncated, true);
  assert.match(messages[0].content, /\[truncated: \d+ chars elided\]/);
  assert.ok(estimateTokens(messages[0].content) <= 101);
});

test('context/pack: the system prompt is not part of the history budget', () => {
  const built = buildMessages({
    system: 'instruktion '.repeat(200),
    messages: [{ role: 'user', content: 'hej' }],
    budgetTokens: 50,
  });
  assert.equal(built.messages[0].role, 'system');
  assert.ok(built.messages[0].content.length > 2000, 'system prompt intact');
  assert.equal(built.messages[1].content, 'hej');
});

test('context/pack: an empty conversation packs to nothing without throwing', () => {
  assert.deepEqual(packHistory({ messages: [], budgetTokens: 100 }), { messages: [], tokens: 0, dropped: 0, truncated: false });
  assert.throws(() => packHistory({ messages: [], budgetTokens: 0 }), /positive budgetTokens/);
  assert.ok(DEFAULT_CONTEXT_TOKENS > 0);
});

test('context/pack: a dropped message is counted, so the caller can say so', () => {
  const msgs = [];
  for (let i = 0; i < 20; i += 1) msgs.push({ role: 'user', content: 'x'.repeat(400) });
  const packed = packHistory({ messages: msgs, budgetTokens: 300 });
  assert.ok(packed.dropped > 0, 'something was dropped');
  assert.equal(packed.messages.length + packed.dropped, msgs.length);
  assert.equal(packed.messages.at(-1).content, msgs.at(-1).content, 'the newest is the last kept');
  assert.equal(packed.messages.at(-1).role, msgs.at(-1).role);
});
