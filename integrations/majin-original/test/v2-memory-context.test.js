/**
 * V2 memory store + context engine contracts.
 * Memory: kind-guard, retention, search order, export/clear, sensitive refusal.
 * Context: budget-aware packing, essential sections survive, truncation marked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore, MEMORY_KINDS } from '../src/v2/memory/store.js';
import { pack, buildTaskContext, estimateTokens } from '../src/v2/context/engine.js';
import { Goal } from '../src/v2/runtime/goal.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v2-mem-'));

test('memory: kind guard + sensitive refusal + get/put/delete', () => {
  const m = new MemoryStore(tmp());
  assert.throws(() => m.put('nonsense', { key: 'a', text: 'b' }), /unknown memory kind/);
  assert.throws(() => m.put('preference', { key: 'key', text: 'hunter2', sensitive: true }), /sensitive/);
  m.put('preference', { key: 'tone', text: 'concise, warm', tags: ['style'], importance: 0.9 });
  assert.equal(m.get('preference', 'tone').text, 'concise, warm');
  m.delete('preference', 'tone');
  assert.equal(m.get('preference', 'tone'), null);
  assert.ok(MEMORY_KINDS.includes('failure-pattern'));
});

test('memory: survives process restart (disk is the truth)', () => {
  const dir = tmp();
  new MemoryStore(dir).put('project', { key: 'arch', text: 'kernel + capabilities', importance: 0.8 });
  const again = new MemoryStore(dir);
  assert.equal(again.get('project', 'arch').text, 'kernel + capabilities');
});

test('memory: retention keeps high-importance over low under cap', () => {
  const dir = tmp();
  const m = new MemoryStore(dir, { maxEntriesPerNs: 3 });
  m.put('tool-success', { key: 'a', text: 'one', importance: 0.1 });
  m.put('tool-success', { key: 'b', text: 'two', importance: 0.9 });
  m.put('tool-success', { key: 'c', text: 'three', importance: 0.8 });
  m.put('tool-success', { key: 'd', text: 'four', importance: 0.7 });
  const kept = m.list('tool-success').map((e) => e.key);
  assert.deepEqual(kept, ['b', 'c', 'd'], 'highest importance first within cap');
  assert.equal(m.get('tool-success', 'a'), null);
});

test('memory: search ranks tag hits above text hits, importance breaks ties', () => {
  const m = new MemoryStore(tmp());
  m.put('failure-pattern', { key: 'x', text: 'shared words', tags: ['timeout'], importance: 0.2 });
  m.put('failure-pattern', { key: 'y', text: 'timeout in the log', importance: 0.3 });
  const hits = m.search('failure-pattern', 'timeout');
  assert.deepEqual(hits.map((h) => h.key), ['x', 'y']);
});

test('memory: export + clear are total (user data ownership)', () => {
  const m = new MemoryStore(tmp());
  m.put('conversation', { key: 'c1', text: 'hello' });
  const dump = m.exportAll();
  assert.equal(dump.kinds.conversation.length, 1);
  m.clear();
  assert.equal(m.exportAll().kinds.conversation.length, 0);
});

test('context: budget packs by priority; dropped + truncated are honest', () => {
  const big = 'x'.repeat(10000); // ~2500 tokens
  const out = pack({
    budgetTokens: 2000,
    sections: [
      { name: 'goal', priority: 100, essential: true, text: 'do the thing' },
      { name: 'filler', priority: 10, text: big },
      { name: 'important but long', priority: 90, essential: true, text: big },
    ],
  });
  assert.match(out.context, /do the thing/);
  assert.ok(out.dropped.includes('filler'));
  assert.ok(out.truncated.includes('important but long'));
  assert.match(out.context, /truncated/);
  assert.ok(out.tokens <= 2100); // header overhead accounts the slack
});

test('context: buildTaskContext ships goal + task + acceptance + memory hits, within budget', () => {
  const goal = new Goal({ objective: 'ship it', acceptance: [{ id: 'a', description: 'art' }] });
  const out = buildTaskContext({
    goal, task: { id: 't1', action: 'write' },
    acceptance: goal.acceptance,
    memoryHits: [{ key: 'style', text: 'keep it small', importance: 0.7 }],
    budgetTokens: 2000,
  });
  for (const got of ['ship it', 't1', '- a: art', 'keep it small']) assert.ok(out.context.includes(got), got);
  assert.ok(estimateTokens(out.context) <= 2000);
});
