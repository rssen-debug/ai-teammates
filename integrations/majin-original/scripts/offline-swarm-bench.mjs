/* MAJIN — Del 3E OFFLINE twin: swarm vs equivalent single-agent baseline,
   deterministic, zero keys, zero network. The LIVE 3E bench proved parallel
   speedup against a real provider (4.29× median); this harness makes the
   same claim REPRODUCIBLE IN CI by injecting controlled latency into worker
   functions (seeded jitter) and running both arms through the same runSwarm
   executor: serial (cap=1) = the single-agent baseline, parallel (cap=N) =
   MAJIN's parallel path.

   What it measures: executor parallelism only. It says nothing about model
   quality, provider latency or token cost — for those see scripts/live-bench.mjs.
   What it verifies besides speed: result PARITY (same per-task outputs in
   both arms) and DEPENDENCY INTEGRITY (a chain is never over-parallelized).

   Usage:
     node scripts/offline-swarm-bench.mjs                 # default: fan 8, 3 reps
     node scripts/offline-swarm-bench.mjs --fan=12 --reps=5 --task-ms=80
     node scripts/offline-swarm-bench.mjs --json          # machine-readable only
     node scripts/offline-swarm-bench.mjs --no-doc        # skip BENCHMARKS.md refresh

   Importable: runOfflineBench({fan, reps, taskMs, jitterMs, seed}) → report. */
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { runSwarm } from '../src/core/swarm.js';

/* Deterministic PRNG so the JITTER is part of the evidence, not an alibi. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function fanNodes(fan, rand, taskMs, jitterMs) {
  return Array.from({ length: fan }, (_, i) => {
    const ms = Math.round(taskMs + (rand() * 2 - 1) * jitterMs);
    return {
      id: `w${i}`, deps: [], estMs: ms,
      run: async () => { await sleep(ms); return { ok: true, id: `w${i}`, ms }; },
    };
  });
}

function chainNodes(len, rand, taskMs, jitterMs) {
  return Array.from({ length: len }, (_, i) => {
    const ms = Math.round(taskMs + (rand() * 2 - 1) * jitterMs);
    return {
      id: `c${i}`, deps: i ? [`c${i - 1}`] : [], estMs: ms,
      run: async () => { await sleep(ms); return { ok: true, id: `c${i}`, ms }; },
    };
  });
}

function overlapPairs(out) {
  const iv = [...out.results.values()].filter((v) => v && v.startedAt != null).map((v) => [v.startedAt, v.endedAt]);
  let pairs = 0;
  for (let i = 0; i < iv.length; i++) for (let j = i + 1; j < iv.length; j++) {
    if (iv[i][0] < iv[j][1] && iv[j][0] < iv[i][1]) pairs += 1;
  }
  return pairs;
}

function parityOk(a, b) {
  /* Logical parity: same task set, same ok-flags, same payload identities.
     The injected latency (v.value.ms) is measurement noise by design — it is
     drawn fresh per arm and is NOT part of the result contract. */
  const norm = (out) => [...out.results.entries()]
    .map(([id, v]) => JSON.stringify({ id, ok: v?.ok ?? null, payloadId: v?.value?.id ?? null }))
    .sort();
  const ja = norm(a); const jb = norm(b);
  return ja.length === jb.length && ja.every((x, i) => x === jb[i]);
}

export async function runOfflineBench({ fan = 8, reps = 3, taskMs = 60, jitterMs = 15, seed = 0x3e } = {}) {
  const rand = mulberry32(seed);
  const arms = [];
  /* Interleaved S,P,S,P… — order effects cancel; the same seeded jitter both
     arms draw from is identical per task id (values re-drawn per node-list
     build, but recorded in the evidence payload below). */
  for (let r = 0; r < reps; r++) {
    for (const kind of ['serial', 'parallel']) {
      const nodes = fanNodes(fan, rand, taskMs, jitterMs);
      const expected = nodes.map((n) => n.estMs);
      const t0 = performance.now();
      const out = await runSwarm({ nodes, cap: kind === 'serial' ? 1 : fan, adaptive: false, maxAttempts: 1 });
      const wallMs = Math.round(performance.now() - t0);
      arms.push({ kind, rep: r, wallMs, okCount: out.okCount, failCount: out.failCount, overlap: overlapPairs(out), estSum: expected.reduce((x, y) => x + y, 0), estMax: Math.max(...expected), out });
    }
  }
  const serialRuns = arms.filter((a) => a.kind === 'serial');
  const parallelRuns = arms.filter((a) => a.kind === 'parallel');
  const med = (xs) => { const s = [...xs].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const serialMed = med(serialRuns.map((a) => a.wallMs));
  const parallelMed = med(parallelRuns.map((a) => a.wallMs));
  const parity = serialRuns.every((s, i) => parityOk(s.out, parallelRuns[i].out));
  const serialOverlap = serialRuns.map((a) => a.overlap);
  const parallelOverlap = parallelRuns.map((a) => a.overlap);

  /* Dependency-integrity scenario: a 3-chain run with cap=3 must NOT beat
     the critical path — if it did, deps were violated. */
  const chainRand = mulberry32(seed ^ 0x51);
  const cn = chainNodes(3, chainRand, taskMs, jitterMs);
  const chainOut = await runSwarm({ nodes: cn, cap: 3, adaptive: false, maxAttempts: 1 });
  const chainMs = cn.map((n) => n.estMs);
  const chainCrit = chainMs.reduce((x, y) => x + y, 0);
  const order = [...chainOut.results.entries()].map(([id, v]) => ({ id, startedAt: v?.startedAt ?? 0, endedAt: v?.endedAt ?? 0 }));
  let depsRespected = true;
  for (let i = 1; i < 3; i++) {
    const parent = order.find((o) => o.id === `c${i - 1}`);
    const child = order.find((o) => o.id === `c${i}`);
    if (!(child.startedAt >= parent.endedAt)) depsRespected = false;
  }

  const report = {
    date: new Date().toISOString().slice(0, 10),
    config: { fan, reps, taskMs, jitterMs, seed },
    speedupMedian: Math.round((serialMed / Math.max(1, parallelMed)) * 100) / 100,
    serialMedianMs: serialMed, parallelMedianMs: parallelMed,
    theoreticalMax: Math.round((serialRuns[0].estSum / serialRuns[0].estMax) * 100) / 100,
    overlap: { serial: serialOverlap, parallel: parallelOverlap },
    parity,
    failures: arms.reduce((s, a) => s + a.failCount, 0),
    chain: { wallMs: chainOut.wallMs, criticalPathMs: chainCrit, depsRespected, okCount: chainOut.okCount },
    arms: arms.map(({ out, ...rest }) => rest),
  };
  return report;
}

export function renderMarkdown(rep) {
  return [
    '<!-- SWARM-BASELINE:BEGIN (auto-generated by scripts/offline-swarm-bench.mjs — do not hand-edit) -->',
    `## Swarm vs single-agent baseline — offline, deterministic (${rep.date})`,
    '',
    'Same `runSwarm` executor, seeded artificial latency. Measures **executor',
    'parallelism only** — model quality/latency live in `scripts/live-bench.mjs`.',
    '',
    `| scenario | median wall | overlap pairs |`,
    `|---|---:|---:|`,
    `| single-agent baseline (cap=1), ${rep.config.fan} tasks | ${rep.serialMedianMs} ms | ${rep.overlap.serial.join('/')} |`,
    `| MAJIN parallel (cap=${rep.config.fan}) | ${rep.parallelMedianMs} ms | ${rep.overlap.parallel.join('/')} |`,
    `| **speedup (median)** | **${rep.speedupMedian}×** | parity ${rep.parity ? 'OK' : 'FAIL'} |`,
    `| dependency chain (3 deep, cap=3) | ${rep.chain.wallMs} ms (critical path ${rep.chain.criticalPathMs} ms) | deps respected: ${rep.chain.depsRespected ? 'YES' : 'NO'} |`,
    '',
    `Config: fan=${rep.config.fan}, reps=${rep.config.reps}, taskMs=${rep.config.taskMs}, jitter=${rep.config.jitterMs}, seed=0x${rep.config.seed.toString(16)}. Failures: ${rep.failures}.`,
    '<!-- SWARM-BASELINE:END -->',
  ].join('\n');
}

export function refreshBenchmarks(rep, docPath = path.resolve(import.meta.dirname, '..', 'docs', 'BENCHMARKS.md')) {
  const md = renderMarkdown(rep);
  const cur = fs.readFileSync(docPath, 'utf8');
  const begin = '<!-- SWARM-BASELINE:BEGIN'; const end = '<!-- SWARM-BASELINE:END -->';
  if (cur.includes(begin)) {
    const pre = cur.slice(0, cur.indexOf(begin));
    const post = cur.slice(cur.indexOf(end) + end.length);
    fs.writeFileSync(docPath, pre + md + post);
  } else {
    fs.writeFileSync(docPath, cur.trimEnd() + '\n\n' + md + '\n');
  }
  return md;
}

/* isCli the set-icon.mjs way: fileURLToPath comparison — the naive
   `import.meta.url === 'file://'+argv[1]` is FALSE on Windows (file:///D:/…)
   and silently runs nothing. Windows CI caught this in WAVE 8 (B6), exactly
   the class of failure a green-Linux-only badge hides. */
const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isCli) {
  const flag = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? Number(a.split('=')[1]) : d; };
  const rep = await runOfflineBench({ fan: flag('fan', 8), reps: flag('reps', 3), taskMs: flag('task-ms', 60), jitterMs: flag('jitter', 15), seed: flag('seed', 0x3e) });
  const evDir = path.resolve(import.meta.dirname, '..', 'docs', 'evidence');
  fs.mkdirSync(evDir, { recursive: true });
  const evPath = path.join(evDir, `swarm-baseline-${rep.date}.json`);
  fs.writeFileSync(evPath, JSON.stringify({ ...rep, arms: rep.arms }, null, 2) + '\n');
  const jsonOnly = process.argv.includes('--json');
  if (!process.argv.includes('--no-doc')) refreshBenchmarks(rep);
  if (jsonOnly) {
    process.stdout.write(JSON.stringify(rep, null, 2) + '\n');
  } else {
    process.stdout.write(`SWARM-BASELINE offline bench — fan ${rep.config.fan}, ${rep.config.reps} reps, seeded latency\n`);
    process.stdout.write(`  serial cap=1    median ${rep.serialMedianMs} ms  overlap ${rep.overlap.serial.join('/')}\n`);
    process.stdout.write(`  parallel cap=${String(rep.config.fan).padEnd(3)} median ${rep.parallelMedianMs} ms  overlap ${rep.overlap.parallel.join('/')}\n`);
    process.stdout.write(`  speedup (median) ${rep.speedupMedian}×  (theoretical max ${rep.theoreticalMax}×)  parity ${rep.parity ? 'OK' : 'FAIL'}  failures ${rep.failures}\n`);
    process.stdout.write(`  chain: ${rep.chain.wallMs} ms vs critical path ${rep.chain.criticalPathMs} ms — deps respected: ${rep.chain.depsRespected ? 'YES' : 'NO'}\n`);
    process.stdout.write(`  evidence: docs/evidence/swarm-baseline-${rep.date}.json; BENCHMARKS.md section refreshed\n`);
  }
  const bad = !rep.parity || rep.failures > 0 || !rep.chain.depsRespected || rep.chain.wallMs < rep.chain.criticalPathMs * 0.85 || rep.speedupMedian < 1.5;
  process.exit(bad ? 1 : 0);
}
