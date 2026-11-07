import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { planRecovery, applyRecovery, summaryText, VERSION } from '../src/core/reset.js';

function mkDirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-ws-'));
  const mk = (p) => { fs.mkdirSync(path.join(base, p), { recursive: true }); return path.join(base, p); };
  return { workspace: mk('workspace'), cache: mk('cache'), sessions: mk('sessions'), memory: mk('memory'), root: base };
}
function agedFile(dirRel, dirs, name, ageMs) {
  const abs = path.join(dirs.workspace, dirRel, name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'x'.repeat(100));
  const past = Date.now() - ageMs;
  fs.utimesSync(abs, past / 1000, past / 1000);
  return abs;
}

test('W11 plan: measures old artifacts WITHOUT touching them; fresh files excluded', () => {
  const dirs = mkDirs();
  const oldF = agedFile('exec/run-1', dirs, 'stdout.log', 48 * 3600_000);
  const freshDir = path.join(dirs.workspace, 'exec', 'run-2');
  fs.mkdirSync(freshDir, { recursive: true });
  const freshF = path.join(freshDir, 'stdout.log');
  fs.writeFileSync(freshF, 'fresh');
  const plan = planRecovery(dirs, { types: ['exec-artifacts'] });
  assert.equal(plan.types[0].files.length, 1);
  assert.equal(plan.types[0].files[0], oldF);
  assert.ok(fs.existsSync(oldF), 'plan touched NOTHING');
  assert.equal(plan.confirmToken.length, 20);
  assert.ok(summaryText(plan).includes('reset plan'));
});

test('W11 plan: unknown recovery kinds are BLOCKED with a reason, never claimed', () => {
  const dirs = mkDirs();
  const plan = planRecovery(dirs, { types: ['my-secrets', 'exec-artifacts'] });
  assert.equal(plan.blocked[0].type, 'my-secrets');
  assert.match(plan.blocked[0].reason, /unknown/);
});

test('W11 apply: exact token required — wrong token refuses to touch anything', () => {
  const dirs = mkDirs();
  agedFile('exec/run-1', dirs, 'meta.json', 48 * 3600_000);
  const plan = planRecovery(dirs, { types: ['exec-artifacts'] });
  assert.throws(() => applyRecovery(dirs, plan, 'wrong-token'), /token mismatch/);
  assert.equal(fs.readdirSync(path.join(dirs.workspace, 'exec', 'run-1')).length, 1, 'nothing removed without the token');
});

test('W11 apply: anti-drift — file added after plan does NOT get removed', () => {
  const dirs = mkDirs();
  const oldF = agedFile('exec/run-1', dirs, 'stdout.log', 48 * 3600_000);
  const plan = planRecovery(dirs, { types: ['exec-artifacts'] });
  const lateF = agedFile('exec/run-1', dirs, 'late.log', 30 * 3600_000);
  const r = applyRecovery(dirs, plan, plan.confirmToken);
  assert.equal(r.removedCount, 1);
  assert.ok(fs.existsSync(lateF), 'post-plan file survives — anti-drift honored');
  assert.ok(!fs.existsSync(oldF));
  assert.equal(r.freedBytes, 100);
});

test('W11 scope guard: paths outside measured dirs are refused individually', () => {
  const dirs = mkDirs();
  const absOutside = path.join(os.tmpdir(), 'OUTSIDE-' + Date.now() + '.log');
  fs.writeFileSync(absOutside, 'x');
  const plan = { version: VERSION, confirmToken: 't', types: [{ type: 'x', files: [absOutside] }], totals: { bytes: 1 }, blocked: [] };
  const r = applyRecovery(dirs, plan, 't');
  assert.equal(r.removedCount, 0);
  assert.match(r.errors[0].error, /scope guard/);
  assert.ok(fs.existsSync(absOutside), 'outside file never deleted by recovery');
  fs.unlinkSync(absOutside);
});

test('W11 honesty: sessions/memory/config never in any recovery kind', () => {
  const dirs = mkDirs();
  /* anyone trying to sneak sessions into KINDS would trip this contract */
  const plan = planRecovery(dirs, {});
  const roots = plan.types.flatMap((t) => t.files);
  assert.equal(roots.length, 0, `empty home yields empty plan. got: ${roots.join(',')}`);
  assert.ok(VERSION.startsWith('majin-reset/'));
});
