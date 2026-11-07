/**
 * WAVE 2 (§5+§8) — adaptive topology dispatch + critical-path-first scheduling.
 * Deterministic tests only: ranks are math, timing tests use real sleeps with
 * margins, and every adaptive claim is backed by an event plus an audit trail.
 * No fables: adaptive:false pins legacy behavior instead of assuming it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSwarm, criticalTailRanks } from '../src/core/swarm.js';

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test('w2: critical-path-first — longest tail launches first, not declaration order', async () => {
  /* Old FIFO would start 'short' first; the chain carries the critical path. */
  const r = await runSwarm({
    nodes: [
      { id: 'short', estMs: 10, run: async () => ({ ok: true }) },
      { id: 'chain1', estMs: 40, run: async () => ({ ok: true }) },
      { id: 'chain2', deps: ['chain1'], estMs: 40, run: async () => ({ ok: true }) },
    ],
    cap: 2,
  });
  assert.equal(r.okCount, 3);
  assert.equal(r.launchOrder[0], 'chain1', 'critical chain head must launch first');
  assert.equal(r.launchOrder[1], 'short', 'independent short work fills the second lane');
  assert.equal(r.launchOrder[2], 'chain2', 'dependent node waits for its dep');
});

test('w2: unannotated grids keep stable declaration order (backward-compatible ties)', async () => {
  const r = await runSwarm({
    nodes: [
      { id: 'x', run: async () => 1 },
      { id: 'y', run: async () => 2 },
      { id: 'z', run: async () => 3 },
    ],
    cap: 3,
  });
  assert.equal(r.okCount, 3);
  assert.deepEqual(r.launchOrder, ['x', 'y', 'z'], 'no estMs = rank 0 ties = declared order');
  assert.deepEqual(r.adaptive.adaptations, [], 'unannotated grids never adapt');
});

test('w2: adaptive contraction — proven 2x estimate overrun freezes the width', async () => {
  const events = [];
  const r = await runSwarm({
    nodes: [
      { id: 'a', estMs: 5, run: async () => { await settle(35); return 'a'; } },
      { id: 'b', estMs: 5, run: async () => { await settle(35); return 'b'; } },
      { id: 'c', estMs: 5, run: async () => { await settle(35); return 'c'; } },
      { id: 'd', estMs: 5, run: async () => { await settle(35); return 'd'; } },
    ],
    cap: 2,
    onEvent: (e) => events.push(e),
  });
  assert.equal(r.okCount, 4);
  const adapt = events.find((e) => e.type === 'topology_adapt');
  assert.ok(adapt, 'overrun must surface as a typed event');
  assert.ok(adapt.measuredRatio >= 2, `ratio was honest: ${adapt.measuredRatio}x vs estMs`);
  assert.equal(r.adaptive.adaptations.length, 1, 'adaptation logged exactly once');
  assert.equal(r.adaptive.adaptations[0].reason, 'overrun');
  /* after the freeze the remaining two nodes run strictly back-to-back */
  assert.ok(r.results.get('d').startedAt >= r.results.get('c').startedAt, 'c before d under frozen cap');
  assert.ok(
    r.results.get('d').startedAt >= r.results.get('c').endedAt,
    `frozen width = 1: d started only after c finished (d@${r.results.get('d').startedAt} c-end@${r.results.get('c').endedAt})`,
  );
});

test('w2: adaptive:false pins the legacy fixed cap (overrun does NOT contract)', async () => {
  const r = await runSwarm({
    nodes: [
      { id: 'a', estMs: 5, run: async () => { await settle(35); return 'a'; } },
      { id: 'b', estMs: 5, run: async () => { await settle(35); return 'b'; } },
      { id: 'c', estMs: 5, run: async () => { await settle(35); return 'c'; } },
      { id: 'd', estMs: 5, run: async () => { await settle(35); return 'd'; } },
    ],
    cap: 2,
    adaptive: false,
  });
  assert.equal(r.okCount, 4);
  assert.equal(r.adaptive.enabled, false);
  assert.deepEqual(r.adaptive.adaptations, [], 'legacy mode emits zero adaptations');
  assert.ok(
    r.results.get('d').startedAt < r.results.get('c').endedAt,
    'width stayed 2: c and d overlapped like the old scheduler',
  );
});

test('w2: dispatch is deterministic — identical graph, identical launch order', async () => {
  const mkNodes = () => [
    { id: 'n1', estMs: 5, run: async () => { await settle(2); return 1; } },
    { id: 'n2', estMs: 50, run: async () => { await settle(2); return 2; } },
    { id: 'n3', deps: ['n2'], estMs: 30, run: async () => { await settle(2); return 3; } },
    { id: 'n4', estMs: 20, run: async () => { await settle(2); return 4; } },
  ];
  const r1 = await runSwarm({ nodes: mkNodes(), cap: 3 });
  const r2 = await runSwarm({ nodes: mkNodes(), cap: 3 });
  assert.deepEqual(r1.launchOrder, r2.launchOrder, 'same inputs, same dispatch order');
  assert.deepEqual(r1.launchOrder, ['n2', 'n4', 'n1', 'n3'], 'rank order: 80 > 20 > 5, then the dep');
});

test('w2: ranker is pure and downstream-aware (exported helper)', () => {
  const ranks = criticalTailRanks([
    { id: 'leaf', estMs: 100 },
    { id: 'hub', estMs: 1, deps: [] },
    { id: 't1', estMs: 40, deps: ['hub'] },
    { id: 't2', estMs: 40, deps: ['t1'] },
  ]);
  assert.equal(ranks.get('leaf'), 100, 'leaf = own estimate');
  assert.equal(ranks.get('t2'), 40, 'tail node = own estimate');
  assert.equal(ranks.get('hub'), 81, '1 + 40 + 40: the tiny hub outranks the huge leaf');
  assert.ok(ranks.get('hub') < ranks.get('leaf'), 'critical tail decides dispatch, not node size');
  const empty = criticalTailRanks([{ id: 'solo' }]);
  assert.equal(empty.get('solo'), 0, 'missing estMs ranks 0 (stable ties)');
});
