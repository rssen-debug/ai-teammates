/**
 * Long-running host: memory must not grow with usage.
 *
 * An always-on Windows box runs for months. Anything keyed by client or by
 * conversation and never evicted becomes a slow leak the user experiences as
 * "it got slow and then it died".
 *
 * These tests assert bounded memory, not exact numbers.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { RateLimiter } from '../../src/v4/security.js';
import { ConversationStore } from '../../src/v4/store.js';
import { tempHome } from './helpers.mjs';

test('leak: the rate limiter forgets clients whose window has expired', () => {
  let now = 0;
  const limiter = new RateLimiter({ windowMs: 1000, limits: { general: 10 }, now: () => now });
  for (let i = 0; i < 500; i += 1) limiter.take('general', `204.0.0.${i}`);
  assert.equal(limiter.buckets.size, 500);

  now = 5000; // every window is long expired
  limiter.take('general', 'fresh-client');
  assert.ok(limiter.buckets.size <= 2, `expected stale buckets to be swept, got ${limiter.buckets.size}`);
});

test('leak: a burst of distinct clients cannot grow the limiter without bound', () => {
  const limiter = new RateLimiter({ windowMs: 60_000, limits: { general: 10 } });
  for (let i = 0; i < 2000; i += 1) limiter.take('general', `ip-${i}`);
  // The cap is the point: a sweep keeps the table proportional to *active* clients.
  assert.ok(limiter.buckets.size <= RateLimiter.MAX_BUCKETS, `got ${limiter.buckets.size}`);
});

test('leak: the conversation cache does not keep every conversation open forever', () => {
  const home = tempHome();
  const store = new ConversationStore({ dir: path.join(home, 'conv') });
  for (let i = 0; i < 300; i += 1) {
    const conv = store.create({ title: `c${i}` });
    store.get(conv.id);
  }
  assert.ok(store.cache.size <= 200, `cache kept ${store.cache.size} conversations`);
  fs.rmSync(home, { recursive: true, force: true });
});

test('leak: evicting from the cache never loses data (the file is the truth)', () => {
  const home = tempHome();
  const store = new ConversationStore({ dir: path.join(home, 'conv') });
  const first = store.create({ title: 'keep me' });
  store.appendMessage(first.id, { role: 'user', content: 'viktigt' });
  for (let i = 0; i < 400; i += 1) store.create({ title: `filler ${i}` });
  assert.equal(store.cache.has(first.id), false, 'it was evicted');
  const reloaded = store.get(first.id);
  assert.ok(reloaded, 'reading it back works');
  assert.equal(reloaded.messages[0].content, 'viktigt', 'the message survived the eviction');
  fs.rmSync(home, { recursive: true, force: true });
});

test('leak: listing conversations is bounded, not a full scan of every file', () => {
  const home = tempHome();
  const store = new ConversationStore({ dir: path.join(home, 'conv') });
  for (let i = 0; i < 150; i += 1) store.create({ title: `c${i}` });
  const listed = store.list();
  assert.ok(listed.length <= 100, `list returned ${listed.length} entries`);
  assert.ok(listed.length > 0);
  fs.rmSync(home, { recursive: true, force: true });
});

/* --------------------------------------------------- concurrent first turns -- */

test('concurrency: two devices starting their first conversation do not share an abort key', async () => {
  const { createAgent } = await import('../../src/v4/agent.js');
  const { GoalStore } = await import('../../src/v4/store.js');
  const { ToolRegistry } = await import('../../src/v2/tools/registry.js');
  const home = tempHome();
  const config = {
    version: 't',
    paths: { home },
    workspaceDir: path.join(home, 'workspace'),
    limits: { maxMessageChars: 4000, maxModelRounds: 1, maxToolCallsPerTurn: 1, toolTimeoutMs: 1000 },
    approvals: { policy: 'sandbox-auto' },
  };
  fs.mkdirSync(config.workspaceDir, { recursive: true });
  const conversations = new ConversationStore({ dir: path.join(home, 'conv') });
  const goals = new GoalStore({ dir: path.join(home, 'goals') });
  const tools = { registry: new ToolRegistry(), root: config.workspaceDir, memory: null };
  const model = { info: { demo: false }, infoFor: () => ({ demo: false }), chat: async () => ({ text: 'ok', toolCalls: [] }) };
  const agent = createAgent({ config, conversations, goals, tools, model });

  // Two brand-new turns are independent work. The server used to pass the
  // literal string 'new' for every first message, so a second device aborted
  // the first device's turn. This is the exact call pattern that was wrong:
  const shared = agent.beginTurn('new');
  const intruder = agent.beginTurn('new');
  assert.equal(shared.signal.aborted, true, 'precondition: the old pattern DID abort a stranger');
  assert.equal(intruder.signal.aborted, false);
  agent.endTurn('new', shared);
  agent.endTurn('new', intruder);

  // With a unique key per turn the same situation is safe.
  const keyA = 'turn_a';
  const keyB = 'turn_b';
  const first = agent.beginTurn(keyA);
  const second = agent.beginTurn(keyB);
  assert.equal(first.signal.aborted, false, 'the first turn must keep running');
  assert.notEqual(first, second);
  agent.endTurn(keyA, first);
  agent.endTurn(keyB, second);

  // An explicit conversation id still cancels its own previous turn.
  const a = agent.beginTurn('conv_abc');
  const b = agent.beginTurn('conv_abc');
  assert.equal(a.signal.aborted, true, 'a new turn in the same conversation supersedes the old one');
  assert.equal(b.signal.aborted, false);
  agent.endTurn('conv_abc', b);
  fs.rmSync(home, { recursive: true, force: true });
});

/* -------------------------------------------------- bounded history + replay -- */

test('replay: a repeated request after history truncation never sends an empty answer', async () => {
  const { startTestServer, postChat, readSse } = await import('./helpers.mjs');
  // keep only the last 4 messages so the first answer falls out of the window
  const s = await startTestServer({ env: { MAJIN_V4_MAX_STORED_MESSAGES: '4' } });
  try {
    const { cookie } = await s.pair();
    const first = await postChat(s.base, cookie, { text: 'Skriv filen tr1.txt med innehåll: ett', requestId: 'rr-1' });
    const convId = (await readSse(first)).find((e) => e.type === 'done').data.conversationId;
    for (const n of [2, 3, 4]) {
      await readSse(await postChat(s.base, cookie, { text: `Skriv filen tr${n}.txt med innehåll: ${n}`, requestId: `rr-${n}`, conversationId: convId }));
    }
    const again = await readSse(await postChat(s.base, cookie, { text: 'Skriv filen tr1.txt med innehåll: ett', requestId: 'rr-1', conversationId: convId }));
    const replay = again.find((e) => e.type === 'replay');
    const done = again.find((e) => e.type === 'done');
    if (done.data.status === 'replayed') {
      assert.ok((replay?.data?.content || '').length > 0, 'a replay must never be empty');
    } else {
      assert.equal(done.data.status, 'already_handled');
      assert.equal(replay?.data?.truncated, true, 'and it says why');
    }
    // the side effect must never repeat
    const fsMod = await import('node:fs');
    const files = fsMod.readdirSync(path.join(s.home, 'workspace')).filter((f) => f.startsWith('tr1'));
    assert.equal(files.length, 1, 'the tool ran exactly once');
  } finally {
    await s.close();
  }
});
