/* MAJIN — Del 3E: REAL parallel-vs-sequential benchmark, LIVE model.
   Runs ONLY with an opencode key in ~/.majin/config.json (MAJIN_LIVE not
   required here — this script IS the live measurement; the test file wraps
   a shorter version behind MAJIN_LIVE=1).
   Protocol: N independent briefs (no deps), R replicates, interleaved
   S,P,S,P — measured through runSwarm with the REAL provider, wall-clock and
   per-worker [startedAt, endedAt] overlap proof + measured usage. Prints a
   table; honest numbers only. */
import { performance } from 'node:perf_hooks';
import * as chat from '../src/core/provider/chat.js';
import { routeFor } from '../src/core/router.js';
import { runSwarm } from '../src/core/swarm.js';
import { load } from '../src/core/config.js';

const N = Number(process.env.BENCH_N) || 4;
const R = Number(process.env.BENCH_R) || 3;
const MODEL = process.env.BENCH_MODEL || 'opencode/longcat-2.5-preview-free';

const cfg = load();
cfg.patch({
  models: { provider: 'opencode', routes: { tasks: MODEL, chat: MODEL, tools: MODEL } },
  budget: { mode: 'track', monthlyUsd: 0, perTaskUsd: 0 },
}, { persist: false });
const route = routeFor(cfg, 'tasks');

const BRIEFS = Array.from({ length: N }, (_, i) => ({
  id: `w${i}`,
  content: `In at most 40 words, describe use case ${i + 1} for on-device AI agents. Be concrete. (${Date.now()})`,
}));

async function one(kind) {
  const nodes = BRIEFS.map((b) => ({
    id: b.id, deps: [],
    run: async () => {
      const r = await chat.complete({ route, job: 'tasks', messages: [{ role: 'user', content: b.content }], maxTokens: 220 });
      return { ok: true, words: String(r.text).trim().split(/\s+/).length, usage: r.usage };
    },
  }));
  const out = await runSwarm({ nodes, cap: kind === 'parallel' ? N : 1, maxAttempts: 1 });
  const vals = [...out.results.values()];
  const intervals = vals.filter((v) => v && v.startedAt != null).map((v) => [v.startedAt, v.endedAt]);
  let overlapPairs = 0;
  for (let i = 0; i < intervals.length; i++) for (let j = i + 1; j < intervals.length; j++) {
    const [a1, a2] = intervals[i]; const [b1, b2] = intervals[j];
    if (a1 < b2 && b1 < a2) overlapPairs++;
  }
  const tokens = vals.filter((v) => v?.ok).reduce((s, v) => s + (v.value?.usage?.input || 0) + (v.value?.usage?.output || 0), 0);
  return { kind, wallMs: out.wallMs, okCount: out.okCount, failCount: out.failCount, overlapPairs, tokens };
}

const rows = [];
// interleaved: kills slow-gateway drift between the two groups
for (let r = 1; r <= R; r++) {
  rows.push(await one('sequential'));
  console.log(`  seq#${r}: ${rows.at(-1).wallMs} ms (${rows.at(-1).okCount}/${N} ok, overlap=${rows.at(-1).overlapPairs}, ${rows.at(-1).tokens} tok)`);
  rows.push(await one('parallel'));
  console.log(`  par#${r}: ${rows.at(-1).wallMs} ms (${rows.at(-1).okCount}/${N} ok, overlap=${rows.at(-1).overlapPairs}, ${rows.at(-1).tokens} tok)`);
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const seq = rows.filter((x) => x.kind === 'sequential');
const par = rows.filter((x) => x.kind === 'parallel');
const seqMed = median(seq.map((x) => x.wallMs));
const parMed = median(par.map((x) => x.wallMs));
console.log('\n=== 3E LIVE RESULT ===');
console.log(JSON.stringify({
  model: MODEL, n: N, replicates: R,
  seq: { medianMs: seqMed, all: seq.map((x) => x.wallMs), overlaps: seq.map((x) => x.overlapPairs) },
  par: { medianMs: parMed, all: par.map((x) => x.wallMs), overlaps: par.map((x) => x.overlapPairs) },
  speedup: +(seqMed / parMed).toFixed(2),
  okEverywhere: rows.every((x) => x.failCount === 0 && x.okCount === N),
  tokens: rows.reduce((s, x) => s + x.tokens, 0),
  ts: new Date().toISOString(),
}, null, 1));
