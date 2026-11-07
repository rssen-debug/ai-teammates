/**
 * MAJIN W14 — competitive benchmark HARNESS (terminal-bench-layout tasks).
 *
 * Reused wheel: laude-institute/terminal-bench task layout (absorb-scanned
 * 2026-10-21, 2438 files, Apache-2.0): <id>/task file + verifier +
 * timeouts. The CONTENT of their tasks is canary-marked and stays OUT of
 * this repo — MAJIN's own NATIVE tasks live in benchmark/tasks/. Only the
 * layout + the verifier-contract principle is reused, exactly as the
 * no-reinvent directive demands.
 *
 * Verifier contract (the thing that makes a benchmark a BENCHMARK):
 *   - verifier runs in a CANDIDATE workspace the lane produced
 *   - exit 0 = task solved; nonzero = not solved; timeout = not solved
 *   - contract lane measures VERIFIER DISCRIMINATION: a verifier that
 *     accepts a known-bad solution is a measurement cheat and is flagged
 *     loudly; a verifier that rejects a known-good solution is broken
 *   - agent lanes (lane.requiresProvider) are DECLARED but stay marked
 *     pending-creds — the harness never fabricates a live score
 *
 * Aggregation is plain reserved-space math: solved/x per lane, wall ms,
 * no percentile theatre on 3-run samples.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const BENCH_VERSION = 'majin-competitive-bench/1';

export class BenchError extends Error {
  constructor(msg, code = 'bench_error') { super(msg); this.name = 'BenchError'; this.code = code; }
}

export function loadTasks(tasksRoot) {
  if (!fs.existsSync(tasksRoot)) return [];
  const out = [];
  for (const d of fs.readdirSync(tasksRoot, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join(tasksRoot, d.name);
    const file = path.join(dir, 'task.json');
    if (!fs.existsSync(file)) continue;
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    out.push({
      id: d.name,
      dir,
      version: t.version || BENCH_VERSION,
      category: t.category || 'general',
      difficulty: t.difficulty || 'unspecified',
      instruction: String(t.instruction || ''),
      verify: t.verify, // { cmd:'node', script:'verify.mjs', timeoutMs? }
      fixtures: t.fixtures || null, // { good: {path:content}, bad: {path:content} }
      lanes: t.lanes || {
        majin: { requiresProvider: true, note: 'agent-loop needs a model → pending creds' },
        'raw-baseline': { requiresProvider: true, note: 'bare single-shot baseline — same measure, no tooling' },
      },
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** candidate workspace from fixture map {relpath: content}. */
export function materialize(base, fixtureMap = {}) {
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(base, { recursive: true });
  for (const [rel, content] of Object.entries(fixtureMap)) {
    const abs = path.join(base, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return base;
}

/** run the task's verifier inside the candidate dir. */
export function runVerifier(task, candidateDir, { env = {} } = {}) {
  if (!task.verify || !task.verify.script) throw new BenchError(`task ${task.id}: verify.script required`, 'bad_input');
  const script = path.isAbsolute(task.verify.script) ? task.verify.script : path.join(task.dir, task.verify.script);
  const timeoutMs = Math.max(1000, Number(task.verify.timeoutMs) || 30_000);
  const t0 = Date.now();
  const r = spawnSync(task.verify.cmd || 'node', [script, candidateDir], {
    cwd: candidateDir, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, MAJIN_BENCH_TASK: task.id, ...env },
  });
  return { passed: r.status === 0, wallMs: Date.now() - t0, stdoutTail: String(r.stdout || '').slice(-400), stderrTail: String(r.stderr || '').slice(-400), signal: r.signal || null, timeout: Boolean(r.error && r.error.code === 'ETIMEDOUT') };
}

/** contract lane: good must PASS and bad must FAIL. Anything else is flagged. */
export function contractLane(task, { tmpRoot }) {
  if (!task.fixtures) return { task: task.id, status: 'unverified', reason: 'no fixtures (contract unenforceable)' };
  const goodDir = materialize(path.join(tmpRoot, `${task.id}__good`), task.fixtures.good);
  const badDir = materialize(path.join(tmpRoot, `${task.id}__bad`), task.fixtures.bad);
  const good = runVerifier(task, goodDir);
  const bad = runVerifier(task, badDir);
  const discriminates = good.passed === true && bad.passed === false;
  return {
    task: task.id,
    status: discriminates ? 'verified' : 'flagged',
    goodPasses: good.passed, badPasses: bad.passed,
    why: discriminates ? 'good passes, bad fails — the verifier measures something real'
      : !good.passed ? 'verifier REJECTED the known-good solution — verifier or fixture is broken'
      : 'verifier ACCEPTED the known-bad solution — it is a measurement cheat, scores through it mean nothing',
    wallMs: good.wallMs + bad.wallMs,
  };
}

export function aggregate(contractRows, { lanesDeclared = [], lanesRun = [] } = {}) {
  const verified = contractRows.filter((r) => r.status === 'verified');
  const flagged = contractRows.filter((r) => r.status === 'flagged');
  const unverified = contractRows.filter((r) => r.status === 'unverified');
  return {
    version: BENCH_VERSION,
    tasks: contractRows.length,
    verifiersVerified: verified.length,
    verifiersFlagged: flagged.length,
    verifiersUnverified: unverified.length,
    flaggedTasks: flagged.map((r) => ({ task: r.task, why: r.why })),
    lanes: {
      declared: lanesDeclared,
      run: lanesRun,
      agentLanesLive: 'pending-credentials — declared, never fabricated',
    },
    healthy: flagged.length === 0 && verified.length > 0,
  };
}

export function renderMarkdown(report, contractRows) {
  const lines = [
    `# MAJIN competitive benchmark harness — verifier contract (${new Date().toISOString().slice(0, 10)})`,
    '',
    `tasks: ${report.tasks} · verifiers verified: ${report.verifiersVerified} · flagged: ${report.verifiersFlagged} · unverified: ${report.verifiersUnverified}`,
    `agent lanes live: ${report.lanes.agentLanesLive}`,
    '',
    '| task | contract | good | bad | why |',
    '|---|---|---|---|---|',
    ...contractRows.map((r) => `| ${r.task} | ${r.status} | ${typeof r.goodPasses === 'boolean' ? String(r.goodPasses) : '—'} | ${typeof r.badPasses === 'boolean' ? String(r.badPasses) : '—'} | ${r.why ?? ''} |`),
  ];
  return lines.join('\n') + '\n';
}
