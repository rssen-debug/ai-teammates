import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { loadDesktopTasks, contractDesktopLane, aggregateDesktop, materialize, VERSION } from '../src/core/desktop-eval.js';

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'w11-eval-'));
const REPO_TASKS = fileURLToPath(new URL('../benchmark/desktop-tasks', import.meta.url));

test('W11 desktop-eval: repots desktop-svit laddas (2 simulerade + 1 windows-real)', () => {
  const tasks = loadDesktopTasks(REPO_TASKS);
  assert.equal(tasks.length, 3);
  assert.deepEqual(tasks.map((t) => t.environment).sort(), ['simulated', 'simulated', 'windows-real']);
});

test('W11 desktop-eval: simulerade verifierare diskriminerar end-states (good pass + bad fail)', { timeout: 60_000 }, () => {
  const tasks = loadDesktopTasks(REPO_TASKS).filter((t) => t.environment === 'simulated');
  const tmp = ws();
  const rows = tasks.map((t) => contractDesktopLane(t, { tmpRoot: tmp, platform: 'linux' }));
  assert.deepEqual(rows.map((r) => r.status), ['verified', 'verified']);
  for (const r of rows) assert.match(r.why, /desktop state/);
});

test('W11 desktop-eval: windows-real task DEFERRED på icke-Windows — aldrig pass, aldrig fail, aldrig fabrikerad', () => {
  const t = loadDesktopTasks(REPO_TASKS).find((x) => x.environment === 'windows-real');
  const row = contractDesktopLane(t, { tmpRoot: ws(), platform: 'linux' });
  assert.equal(row.status, 'deferred');
  assert.match(row.reason, /hardware-required/);
  // samma task på windows-lane FÖRSÖKER mäta — fixtures saknas → unverified (inte fabrikerad verification)
  const fakeWin = contractDesktopLane(t, { tmpRoot: ws(), platform: 'win32' });
  assert.notEqual(fakeWin.status, 'verified', 'harness ljuger aldrig om en live-körning den inte gjort');
});

test('W11 desktop-eval: en verifier som accepterar skräp-end-state FLAGGAS som measurement cheat', () => {
  const root = ws();
  const dir = path.join(root, 'cheat-desktop');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({
    environment: 'simulated', goal: 'anything',
    verify: { cmd: process.execPath, script: path.join(dir, 'verify.mjs'), timeoutMs: 5000 },
    fixtures: { good: { 'a.txt': 'right' }, bad: { 'a.txt': 'wrong' } },
  }));
  fs.writeFileSync(path.join(dir, 'verify.mjs'), `process.stdout.write('PASS');\n`);
  const [t] = loadDesktopTasks(root);
  const row = contractDesktopLane(t, { tmpRoot: ws(), platform: 'linux' });
  assert.equal(row.status, 'flagged');
  assert.match(row.why, /measurement cheat/);
});

test('W11 desktop-eval: aggregate — healthy bara utan flaggar; deferred räknas separat; live-lane deklarerad ärligt', { timeout: 60_000 }, () => {
  const tasks = loadDesktopTasks(REPO_TASKS);
  const tmp = ws();
  const rows = tasks.map((t) => contractDesktopLane(t, { tmpRoot: tmp, platform: 'linux' }));
  const report = aggregateDesktop(rows, { lanesDeclared: ['simulated', 'windows-real'] });
  assert.equal(report.version, VERSION);
  assert.equal(report.tasks, 3);
  assert.equal(report.verifiersVerified, 2);
  assert.equal(report.verifiersDeferred, 1);
  assert.equal(report.healthy, true);
  assert.match(report.lanes.agentLanesLive, /pending-hardware/);
  assert.deepEqual(report.deferredTasks.map((d) => d.task), ['rename-file-dialog-win']);
});

test('W11 materialize: fixture-blir-kandidatend-state', () => {
  const base = ws();
  materialize(base, { 'note.txt': 'typed bytes', 'state/spec.json': '{}' });
  assert.equal(fs.readFileSync(path.join(base, 'note.txt'), 'utf8'), 'typed bytes');
});
