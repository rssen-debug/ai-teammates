/* GRAND ARCHITECT Acceptans — Del 3E: REAL parallel-vs-sequential behaviour,
   measured through runSwarm with REAL words on the wire.
   - CI/offline mode: same harness, mocked latency ladder — proves the cap
     mechanics + the overlap evidence code DETERMINISTICALLY.
   - LIVE mode (MAJIN_LIVE=1 + opencode key in ~/.majin/config.json): real
     model calls; parallel runs show timestamp overlap, sequential shows zero,
     parallel median clearly faster; usage tokens measured, never guessed.
   Recorded live evidence lives in docs/BENCHMARKS.md (2026-10-19). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSwarm } from '../src/core/swarm.js';
import { routeFor } from '../src/core/router.js';
import * as chat from '../src/core/provider/chat.js';

const LIVE = process.env.MAJIN_LIVE === '1';

const overlaps = (results) => {
  const iv = [...results.values()].filter((v) => v && v.startedAt != null).map((v) => [v.startedAt, v.endedAt]);
  let n = 0;
  for (let i = 0; i < iv.length; i++) for (let j = i + 1; j < iv.length; j++) {
    if (iv[i][0] < iv[j][1] && iv[j][0] < iv[i][1]) n++;
  }
  return n;
};

async function runKind({ kind, n, workerRun }) {
  const nodes = Array.from({ length: n }, (_, i) => ({ id: `w${i}`, deps: [], run: () => workerRun(i) }));
  return runSwarm({ nodes, cap: kind === 'parallel' ? n : 1, maxAttempts: 1 });
}

test('3E.mock: cap mechanics + overlap evidence are deterministic — concurrency is REAL behavior, not a label', { timeout: 30000 }, async () => {
  const worker = (i) => new Promise((res) => setTimeout(() => res({ ok: true, w: i }), 120 + (i % 2) * 40));
  const seq = await runKind({ kind: 'sequential', n: 4, workerRun: worker });
  const par = await runKind({ kind: 'parallel', n: 4, workerRun: worker });
  assert.equal(seq.okCount, 4); assert.equal(par.okCount, 4);
  assert.equal(overlaps(seq.results), 0, 'cap:1 → zero timestamp overlap');
  assert.ok(overlaps(par.results) >= 5, `cap:4 → real concurrency (6 pairs max): got ${overlaps(par.results)}`);
  assert.ok(par.wallMs <= seq.wallMs * 0.75, `parallel clearly faster: ${par.wallMs} vs ${seq.wallMs}`);
});

test('3E.live: REAL model — N briefs, parallel vs sequential, overlap + medians + measured tokens', { timeout: 600000, skip: !LIVE && 'only with MAJIN_LIVE=1 (opencode key configured)' }, async () => {
  const { load } = await import('../src/core/config.js');
  const cfg = load();
  const model = process.env.BENCH_MODEL || 'opencode/longcat-2.5-preview-free';
  cfg.patch({ models: { provider: 'opencode', routes: { tasks: model } }, budget: { mode: 'track', monthlyUsd: 0, perTaskUsd: 0 } }, { persist: false });
  const route = routeFor(cfg, 'tasks');
  const N = 3;
  const workerRun = async (i) => {
    const r = await chat.complete({ route, job: 'tasks', messages: [{ role: 'user', content: `In at most 25 words, one concrete fact about Swedish railway history (${i}, ${Date.now()}).` }], maxTokens: 180 });
    return { ok: true, usage: r.usage };
  };
  const seq = await runKind({ kind: 'sequential', n: N, workerRun });
  const par = await runKind({ kind: 'parallel', n: N, workerRun });
  const tok = (rs) => [...rs.values()].filter((v) => v?.ok).reduce((s, v) => s + (v.value?.usage?.input || 0) + (v.value?.usage?.output || 0), 0);
  console.log(`3E.live: seq=${seq.wallMs}ms overlap=${overlaps(seq.results)} | par=${par.wallMs}ms overlap=${overlaps(par.results)} | tokens seq=${tok(seq.results)} par=${tok(par.results)}`);
  assert.equal(seq.okCount, N); assert.equal(par.okCount, N);
  assert.equal(seq.failCount + par.failCount, 0, 'every live call ok');
  assert.equal(overlaps(seq.results), 0, 'sequential never overlaps');
  assert.ok(overlaps(par.results) >= 1, 'parallel shows real timestamp overlap');
  assert.ok(par.wallMs <= seq.wallMs * 1.15, `parallel not slower than sequential: ${par.wallMs} vs ${seq.wallMs}`);
  assert.ok(tok(par.results) > 0, 'measured usage, not vibes');
});
