#!/usr/bin/env node
/**
 * MAJIN W14 competitive benchmark harness.
 * node scripts/competitive-bench.mjs [--json] [--save] [--tasks=benchmark/tasks]
 * Exit != 0 when any verifier is flagged — a cheating verifier never slips through as a score.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTasks, contractLane, aggregate, renderMarkdown, BENCH_VERSION } from '../src/core/competitive-bench.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const f = (n, d) => { const e = argv.find((a) => a.startsWith(`--${n}=`)); return e ? e.split('=').slice(1).join('=') : (argv.includes(`--${n}`) ? true : d); };

const tasksRoot = path.resolve(ROOT, String(f('tasks', 'benchmark/tasks')));
const tasks = loadTasks(tasksRoot);
if (!tasks.length) { console.error(`no tasks under ${tasksRoot}`); process.exit(2); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-bench-'));
const rows = tasks.map((t) => {
  const row = contractLane(t, { tmpRoot });
  process.stdout.write(`  ${row.status === 'verified' ? '✓' : row.status === 'flagged' ? '✗' : '·'} ${row.task.padEnd(28)} ${row.status}${row.status === 'flagged' ? ` — ${row.why}` : ''}\n`);
  return row;
});

const report = aggregate(rows, { lanesDeclared: Object.keys(tasks[0]?.lanes || {}) });
fs.rmSync(tmpRoot, { recursive: true, force: true });

if (f('json', false)) process.stdout.write(JSON.stringify({ report, rows }, null, 2) + '\n');
if (f('save', false)) {
  const d = new Date().toISOString().slice(0, 10);
  const outJ = path.join(ROOT, 'docs', 'evidence', `competitive-bench-${d}.json`);
  const outM = path.join(ROOT, 'docs', 'evidence', `competitive-bench-${d}.md`);
  fs.writeFileSync(outJ, JSON.stringify({ report, rows }, null, 2) + '\n');
  fs.writeFileSync(outM, renderMarkdown(report, rows));
  process.stdout.write(`\njson: ${outJ}\nmd:   ${outM}\n`);
}
process.stdout.write(`\nverifier contract: ${report.verifiersVerified}/${report.tasks} verified · flagged=${report.verifiersFlagged} · harness=${BENCH_VERSION}\n`);
process.exitCode = report.healthy ? 0 : 1;
