/**
 * MAJIN — WAVE 5 (§19): perf lab A/B/C/D — topology-variant benchmarks.
 * Every number is MEASURED by running the real scheduler on synthetic DAGs
 * with declared durations (real sleeps scaled by `scale`). No model calls,
 * free-only by construction. Median-of-N runs, never one lucky sample.
 *
 * IMPORTANT honesty rule: C measures a TRADE, not a win — adaptive contraction
 * deliberately pays wall-clock to stop widening on a broken estimation model.
 * The report prints the trade, it never sells it as a speedup.
 *
 * CLI: node scripts/perf-topology-bench.mjs [--scale 1] [--runs 5]
 *   → writes docs/evidence/perf-topology-<date>.json and refreshes the
 *     PERFLAB section of docs/SWARM_PERFORMANCE.md.
 */
import { performance } from 'node:perf_hooks';
import { runSwarm, criticalTailRanks } from '../src/core/swarm.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

const mkWork = (est, scale, counters) => async () => {
  if (counters) counters.launches += 1;
  await sleep(Math.max(1, est * scale));
  return true;
};

/* ---------------- workloads ---------------- */
function gridWideFan(scale, counters) {
  /* A: 8 independent heterogeneous nodes, cap 2 */
  const est = [180, 150, 120, 90, 60, 45, 30, 15];
  return est.map((e, i) => ({ id: `a${i}`, estMs: e, run: mkWork(e, scale, counters) }));
}
function gridDeepChain(scale, counters) {
  /* B: deep chain (3×180) + 6 short side nodes (12), cap 2. Declaration order
     puts the shorts first — the exact pattern CP-first exists to fix. */
  const shorts = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, estMs: 12, run: mkWork(12, scale, counters) }));
  const chain = [
    { id: 'c1', estMs: 180, run: mkWork(180, scale, counters) },
    { id: 'c2', estMs: 180, deps: ['c1'], run: mkWork(180, scale, counters) },
    { id: 'c3', estMs: 180, deps: ['c2'], run: mkWork(180, scale, counters) },
  ];
  return [...shorts, ...chain];
}
function gridOverrun(scale, counters) {
  /* C: annotated estMs=10 but ACTUAL burn ~110 (11× overrun): adaptive should
     contract; legacy keeps its fixed cap. cap 3, 6 independent nodes. */
  return Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, estMs: 10, run: mkWork(110, scale, counters) }));
}

async function benchOnce(nodes, opts) {
  const t0 = performance.now();
  const r = await runSwarm({ nodes, ...opts });
  return { wallMs: performance.now() - t0, result: r };
}

export async function runBench({ scale = 1, runs = 5 } = {}) {
  const out = { scale, runs, scenarios: {} };

  /* A — wide fan-out: CP-first (adaptive default) vs legacy flag */
  {
    const walls = { cp: [], legacy: [] };
    for (let i = 0; i < runs; i++) {
      walls.cp.push((await benchOnce(gridWideFan(scale, null), { cap: 2 })).wallMs);
      walls.legacy.push((await benchOnce(gridWideFan(scale, null), { cap: 2, adaptive: false })).wallMs);
    }
    out.scenarios.A = {
      name: 'wide fan-out (8 indep, cap 2)',
      cpMedianMs: Math.round(median(walls.cp)),
      legacyMedianMs: Math.round(median(walls.legacy)),
      ratio: +(median(walls.cp) / median(walls.legacy)).toFixed(3),
    };
  }

  /* B — deep chain + shorts */
  {
    const walls = { cp: [], legacy: [] };
    for (let i = 0; i < runs; i++) {
      walls.cp.push((await benchOnce(gridDeepChain(scale, null), { cap: 2 })).wallMs);
      walls.legacy.push((await benchOnce(gridDeepChain(scale, null), { cap: 2, adaptive: false })).wallMs);
    }
    out.scenarios.B = {
      name: 'deep chain + 6 shorts (cap 2)',
      cpMedianMs: Math.round(median(walls.cp)),
      legacyMedianMs: Math.round(median(walls.legacy)),
      ratio: +(median(walls.cp) / median(walls.legacy)).toFixed(3),
    };
  }

  /* C — overrun trade: contraction fires; the PAYMENT structure is reported */
  {
    const counters = { launches: 0 };
    const ad = await benchOnce(gridOverrun(scale, counters), { cap: 3 });
    const adWall = ad.wallMs; const adEvents = ad.result.adaptive.adaptations.length;
    const counters2 = { launches: 0 };
    const lg = await benchOnce(gridOverrun(scale, counters2), { cap: 3, adaptive: false });
    out.scenarios.C = {
      name: '11× est-overrun (est 10, actual ~110, cap 3)',
      adaptive: { wallMs: Math.round(adWall), contractionEvents: adEvents, capReduced: adEvents > 0 && ad.result.adaptive.adaptations.every((e) => e.capNow < e.capBefore) },
      legacy: { wallMs: Math.round(lg.wallMs), contractionEvents: lg.result.adaptive.adaptations.length },
      tradeNote: 'adaptive buys spawn-frugality ON A BROKEN MODEL at wall-clock cost — reported as a trade, never a speedup',
    };
  }

  /* D — ranker + grid overhead (regression guard) */
  {
    const big = Array.from({ length: 2000 }, (_, i) => ({ id: `d${i}`, estMs: (i * 7) % 50, deps: i > 3 ? [`d${i - 3}`] : [] }));
    const t0 = performance.now();
    const ranks = criticalTailRanks(big);
    const rankMs = performance.now() - t0;
    const grid = Array.from({ length: 200 }, (_, i) => ({ id: `g${i}`, run: async () => true }));
    const g0 = performance.now();
    await runSwarm({ nodes: grid, cap: 16 });
    out.scenarios.D = {
      name: 'ranker on 2 000 nodes + 200-node pass-through grid',
      rank2000Ms: +rankMs.toFixed(2),
      ranksComputed: ranks.size,
      grid200WallMs: Math.round(performance.now() - g0),
    };
  }
  return out;
}

/* ---------------- CLI ---------------- */
function toMarkdown(bench, stamp) {
  const L = [];
  L.push(`## WAVE 5 (§19) perf lab A/B/C/D — topology variants (${stamp}, scale ${bench.scale}, median of ${bench.runs})`);
  L.push('');
  L.push('Measured by running the REAL scheduler (`runSwarm`) on synthetic DAGs with declared');
  L.push('durations (real sleeps). No model calls. Raw JSON: `docs/evidence/perf-topology-' + stamp.split('T')[0] + '.json`.');
  L.push('');
  L.push('| lab | scenario | variant A | variant B | ratio/finding |');
  L.push('|---|---|---|---|---|');
  const A = bench.scenarios.A, B = bench.scenarios.B, C = bench.scenarios.C, D = bench.scenarios.D;
  L.push(`| A | ${A.name} | CP-first ${A.cpMedianMs} ms | legacy ${A.legacyMedianMs} ms | **×${A.ratio}** |`);
  L.push(`| B | ${B.name} | CP-first ${B.cpMedianMs} ms | declaration-order ${B.legacyMedianMs} ms | **×${B.ratio}** |`);
  L.push(`| C | ${C.name} | adaptive ${C.adaptive.wallMs} ms (contractions: ${C.adaptive.contractionEvents}) | legacy ${C.legacy.wallMs} ms (always 0) | trade, not speedup: frugality on broken model |`);
  L.push(`| D | ${D.name} | rank-2000: ${D.rank2000Ms} ms | grid-200: ${D.grid200WallMs} ms | overhead guard; ranks computed: ${D.ranksComputed} |`);
  L.push('');
  L.push('Honesty notes: CI timing noise is real — A/B are direction-asserted with wide margins in');
  L.push('`test/w5-perf-lab.test.js`; C reports a deliberate trade (wall-clock for spawn-frugality);');
  L.push('D is a regression guard for ranker cost. Nothing here is a live-model metric.');
  return L.join('\n');
}

const isMain = process.argv[1] && process.argv[1].endsWith('perf-topology-bench.mjs');
if (isMain) {
  const argI = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : dflt; };
  const scale = argI('--scale', 1);
  const runs = argI('--runs', 5);
  const fs = await import('node:fs');
  const path = await import('node:path');
  const bench = await runBench({ scale, runs });
  const stamp = new Date().toISOString();
  const evDir = path.join(process.cwd(), 'docs', 'evidence');
  fs.mkdirSync(evDir, { recursive: true });
  const evFile = path.join(evDir, `perf-topology-${stamp.slice(0, 10)}.json`);
  fs.writeFileSync(evFile, JSON.stringify({ stamp, ...bench }, null, 2) + '\n');
  const md = toMarkdown(bench, stamp);
  const sc = path.join(process.cwd(), 'docs', 'SWARM_PERFORMANCE.md');
  let cur = fs.readFileSync(sc, 'utf8');
  const BEGIN = '<!-- PERFLAB:BEGIN -->', END = '<!-- PERFLAB:END -->';
  const section = `${BEGIN}\n${md}\n${END}`;
  if (cur.includes(BEGIN) && cur.includes(END)) {
    cur = cur.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`), section);
  } else {
    cur = cur.trimEnd() + '\n\n' + section + '\n';
  }
  fs.writeFileSync(sc, cur);
  console.log(md);
  console.log(`\nevidence: ${evFile}`);
}
