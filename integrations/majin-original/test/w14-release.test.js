import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { recordInstalled, planRollback, executeRollback, rollbackLedger, RollbackError, ROLLBACK_VERSION } from '../src/core/update-rollback.js';
import { manifestHash, reproducibilityProof, trackedFiles } from '../src/core/reproducible.js';
import { loadTasks, contractLane, aggregate, materialize, BENCH_VERSION } from '../src/core/competitive-bench.js';

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'w14-'));

/* ------------------------------ rollback ------------------------------ */

const fakeArtifact = (label) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'w14-art-')), `setup-${label}.exe`);
  fs.writeFileSync(f, Buffer.from(`fake-installer-bytes-${label}-` + Math.random().toString(36).slice(2), 'utf8'));
  return f;
};

test('W14 rollback: recordInstalled isolerar backup (kopia, inte länk till fil installern skriver över)', () => {
  const dir = ws();
  const art = fakeArtifact('1.2.3');
  recordInstalled(dir, { version: '1.2.3', backupFile: art });
  const plan = () => fs.readFileSync(path.join(dir, '.majin-install-manifest.json'), 'utf8');
  assert.match(plan(), /1\.2\.3/);
  fs.rmSync(art); // ursprungligt spår försvinner — kopian MÅSTE överleva
  const m = JSON.parse(plan());
  assert.ok(fs.existsSync(m.versions[0].backup.file), 'backup survives source-file removal');
});

test('W14 rollback plan: väljer senaste TIDLIGARE version, aldrig current; dry-check producerar komplett plan', () => {
  const dir = ws();
  recordInstalled(dir, { version: '1.0.0', installedAt: '2026-10-01T00:00:00Z', backupFile: fakeArtifact('1.0.0') });
  recordInstalled(dir, { version: '1.1.0', installedAt: '2026-10-10T00:00:00Z', backupFile: fakeArtifact('1.1.0') });
  recordInstalled(dir, { version: '1.2.0', installedAt: '2026-10-20T00:00:00Z', backupFile: fakeArtifact('1.2.0') });
  const plan = planRollback(dir, { currentVersion: '1.2.0' });
  assert.equal(plan.from, '1.2.0');
  assert.equal(plan.to, '1.1.0', 'rollback måste inte "rulla tillbaka" till sig själv');
  assert.equal(plan.version, ROLLBACK_VERSION);
  assert.doesNotThrow(() => planRollback(dir, { currentVersion: '1.2.0' }), 'check är idempotent — samma plan varje gång');
});

test('W14 rollback: refusest klasser är högljudda — samma version, target finns inte, backup borta, sha bruten', () => {
  const d1 = ws();
  assert.throws(() => planRollback(d1), RollbackError); // tomt manifest
  const dir = ws();
  const art = fakeArtifact('2.0.0');
  recordInstalled(dir, { version: '2.0.0', backupFile: art });
  assert.throws(() => planRollback(dir, { currentVersion: '2.0.0' }), /no EARLIER version/);
  // spela in en äldre version med egen backup, sabotera sedan backup-bytesen
  recordInstalled(dir, { version: '1.9.0', installedAt: '2026-10-01T00:00:00Z', backupFile: fakeArtifact('1.9.0') });
  // mutate bytes av backup
  const file = JSON.parse(fs.readFileSync(path.join(dir, '.majin-install-manifest.json'), 'utf8')).versions.at(0).backup.file;
  fs.writeFileSync(file, Buffer.from('tampered'));
  assert.throws(() => planRollback(dir, { currentVersion: '2.0.0' }), /sha mismatch|no usable rollback target/);
});

test('W14 rollback execute: utan injicerad restorer REFUSAS det — core ljuger aldrig om en restore', async () => {
  const dir = ws();
  recordInstalled(dir, { version: '3.0.0', installedAt: '2026-10-01T00:00:00Z', backupFile: fakeArtifact('3.0.0') });
  recordInstalled(dir, { version: '3.1.0', installedAt: '2026-10-02T00:00:00Z', backupFile: fakeArtifact('3.1.0') });
  await assert.rejects(() => executeRollback(dir), /no restorer injected/);
});

test('W14 rollback execute happy path: restorer kallas med VERIFIERAD fil, ledger appendas med sha', async () => {
  const dir = ws();
  recordInstalled(dir, { version: '4.0.0', installedAt: '2026-10-01T00:00:00Z', backupFile: fakeArtifact('4.0.0') });
  recordInstalled(dir, { version: '4.1.0', installedAt: '2026-10-02T00:00:00Z', backupFile: fakeArtifact('4.1.0') });
  let calls = 0; let seen = null;
  const { event } = await executeRollback(dir, { restorer: (file, version) => { calls += 1; seen = { file, version }; } });
  assert.equal(calls, 1);
  assert.equal(seen.version, '4.0.0');
  assert.equal(event.to, '4.0.0');
  assert.match(event.sha256, /^[0-9a-f]{64}$/);
  assert.equal(rollbackLedger(dir).length, 1);
  assert.equal(rollbackLedger(dir)[0].type, 'rollback');
});

/* ------------------------------ reproducible ------------------------------ */

test('W14 reproducible: manifest hash är stabil run-för-run, trackerar riktiga regler', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const proof = reproducibilityProof(root);
  assert.equal(proof.identical, true);
  assert.match(proof.hashA, /^[0-9a-f]{64}$/);
  assert.ok(proof.files > 200, `beviset räknar riktigt innehåll: ${proof.files}`);
  const listed = trackedFiles(root);
  assert.ok(listed.includes('src/core/update.js'), 'tracked-filen som committats finns i manifestet');
  assert.ok(!listed.some((p) => p.startsWith('node_modules/')), 'git ls-files är sanningen — node_modules är inte tracked');
  assert.match(proof.binaryExeReproducibilityScope, /NOT TESTED/);
  // untracked-bråte får ALDRIG påverka hashen: hash före == hash efter brus-filen
  const h1 = manifestHash(root).sha256;
  const noiseFile = path.join(root, '.w14-untracked-noise.tmp');
  fs.writeFileSync(noiseFile, 'untracked noise');
  try { assert.equal(manifestHash(root).sha256, h1, 'untracked-fil påverkar inte manifesthashen'); }
  finally { fs.rmSync(noiseFile, { force: true }); }
});

/* ------------------------------ competitive bench ------------------------------ */

test('W14 competitive-bench: repots egen native task-svit passerar kontraktet 3/3', { timeout: 60_000 }, async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const tasks = loadTasks(path.join(root, 'benchmark', 'tasks'));
  assert.equal(tasks.length, 3);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w14-bench-'));
  const rows = tasks.map((t) => contractLane(t, { tmpRoot: tmp }));
  assert.deepEqual(rows.map((r) => r.status), ['verified', 'verified', 'verified']);
  const report = aggregate(rows, { lanesDeclared: Object.keys(tasks[0].lanes) });
  assert.equal(report.healthy, true);
  assert.equal(report.version, BENCH_VERSION);
  assert.match(report.lanes.agentLanesLive, /pending-credentials/);
});

test('W14 competitive-bench: en fuskande verifier (accepter skräp) FLAGGAS, aldrig tolkad som poäng', () => {
  const root = ws();
  const dir = path.join(root, 'cheat-task');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({
    instruction: 'any garbage is fine actually',
    verify: { cmd: process.execPath, script: path.join(dir, 'verify.mjs'), timeoutMs: 5000 },
    fixtures: { good: { 'x.txt': 'the answer' }, bad: { 'x.txt': 'totally wrong' } },
  }));
  fs.writeFileSync(path.join(dir, 'verify.mjs'), `process.stdout.write('PASS whatever');\n`);
  const tasks = loadTasks(root);
  assert.equal(tasks.length, 1);
  const row = contractLane(tasks[0], { tmpRoot: ws() });
  assert.equal(row.status, 'flagged');
  assert.match(row.why, /measurement cheat/);
  const report = aggregate([row]);
  assert.equal(report.healthy, false, 'a cheating verifier kills harness health');
});

test('W14 competitive-bench: verifier som REFUSER known-good linea en trasighet, inte en task-fail', () => {
  const root = ws();
  const dir = path.join(root, 'broken-verifier');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({
    instruction: 'write x.txt',
    verify: { cmd: process.execPath, script: path.join(dir, 'verify.mjs'), timeoutMs: 5000 },
    fixtures: { good: { 'x.txt': 'correct' }, bad: { 'x.txt': 'wrong' } },
  }));
  fs.writeFileSync(path.join(dir, 'verify.mjs'), `process.exit(7);\n`);
  const [t] = loadTasks(root);
  const row = contractLane(t, { tmpRoot: ws() });
  assert.equal(row.status, 'flagged');
  assert.match(row.why, /REJECTED the known-good/);
});

test('W14 materialize: fixtureset blir en riktig kandidatkatalog', () => {
  const base = ws();
  materialize(base, { 'a/b.txt': 'hello', 'c.json': '{}' });
  assert.equal(fs.readFileSync(path.join(base, 'a', 'b.txt'), 'utf8'), 'hello');
  assert.ok(fs.existsSync(path.join(base, 'c.json')));
});
