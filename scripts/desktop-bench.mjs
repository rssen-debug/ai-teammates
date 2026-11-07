#!/usr/bin/env node
/**
 * MAJIN W11 desktop eval harness CLI.
 *   node scripts/desktop-bench.mjs [--json] [--save] [--tasks=benchmark/desktop-tasks]
 * Contract: simulated disk-verifiers must discriminate; windows-real tasks DEFER
 * on non-Windows hosts (declared, never fabricated). Exit != 0 if any verifier flaggas.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDesktopTasks, contractDesktopLane, aggregateDesktop, renderDesktopMarkdown, VERSION } from '../src/core/desktop-eval.js';
import { platformGate } from '../src/core/desktop-vision.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const f = (n, d) => { const e = argv.find((a) => a.startsWith(`--${n}=`)); return e ? e.split('=').slice(1).join('=') : (argv.includes(`--${n}`) ? true : d); };

const gate = platformGate();
process.stdout.write(`platform lane: ${gate.lane} (${gate.platform})\n`);

const tasksRoot = path.resolve(ROOT, String(f('tasks', 'benchmark/desktop-tasks')));
const tasks = loadDesktopTasks(tasksRoot);
if (!tasks.length) { console.error(`no desktop tasks under ${tasksRoot}`); process.exit(2); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-desktop-bench-'));
const rows = tasks.map((t) => {
  const row = contractDesktopLane(t, { tmpRoot, platform: process.platform });
  const mark = row.status === 'verified' ? '✓' : row.status === 'flagged' ? '✗' : row.status === 'deferred' ? '⏸' : '·';
  process.stdout.write(`  ${mark} ${row.task.padEnd(28)} [${row.environment}] ${row.status}${row.status !== 'verified' ? ` — ${row.why ?? row.reason}` : ''}\n`);
  return row;
});
fs.rmSync(tmpRoot, { recursive: true, force: true });

const lanesDeclared = [...new Set(tasks.map((t) => t.environment || 'simulated'))];
const report = aggregateDesktop(rows, { lanesDeclared });

if (f('json', false)) process.stdout.write(JSON.stringify({ report, rows }, null, 2) + '\n');
if (f('save', false)) {
  const d = new Date().toISOString().slice(0, 10);
  const outJ = path.join(ROOT, 'docs', 'evidence', `desktop-bench-${d}.json`);
  const outM = path.join(ROOT, 'docs', 'evidence', `desktop-bench-${d}.md`);
  fs.writeFileSync(outJ, JSON.stringify({ platformLane: gate.lane, report, rows }, null, 2) + '\n');
  fs.writeFileSync(outM, renderDesktopMarkdown(report, rows));
  process.stdout.write(`\njson: ${outJ}\nmd:   ${outM}\n`);
}
process.stdout.write(`\nverifier contract: ${report.verifiersVerified}/${report.tasks} verified · flagged=${report.verifiersFlagged} · deferred=${report.verifiersDeferred} · harness=${VERSION}\n`);
process.exitCode = report.healthy ? 0 : 1;
