/**
 * WAVE 6 (§12) — release gate: the executable half of RELEASE_READY.
 * Local checks must pass against the real repo; failure modes are proven with
 * surgical breakage, not assumed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const GATE = path.join(ROOT, 'scripts', 'release-gate.mjs');
const run = (args = []) => { try { return { code: 0, out: execFileSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: 'utf8' }) }; } catch (e) { return { code: e.status ?? 1, out: String(e.stdout || '') }; } };

test('w6: gate exits 0 and all local checks pass on the real repo', () => {
  const r = run();
  assert.equal(r.code, 0, r.out);
  for (const c of ['version-literals', 'matrix-integrity', 'checkpoint', 'secret-hygiene']) {
    assert.ok(r.out.includes(`PASS  ${c}`), `missing ${c}: ${r.out}`);
  }
  assert.match(r.out, /checks GREEN/);
});

test('w6: json mode emits machine-parseable results', () => {
  const r = run(['--json']);
  assert.equal(r.code, 0, r.out);
  const d = JSON.parse(r.out);
  assert.equal(d.failed, 0);
  assert.equal(d.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  assert.ok(Array.isArray(d.results) && d.results.length >= 4);
});

test('w6: a deliberately broken matrix makes the gate fail (sabotage-proven)', () => {
  const matrix = path.join(ROOT, 'docs', 'COMPLETION_MATRIX.md');
  const original = fs.readFileSync(matrix, 'utf8');
  const sabotaged = original.replace(/\| \*\*TOTAL\*\* \| \*\*100\*\* \| \*\*\d+\*\* \|/, '| **TOTAL** | **100** | **1** |');
  assert.notEqual(sabotaged, original, 'sabotage must actually change bytes');
  try {
    fs.writeFileSync(matrix, sabotaged);
    const r = run();
    assert.equal(r.code, 1, 'gate MUST exit non-zero on a drifting matrix');
    assert.ok(r.out.includes('FAIL  matrix-integrity'), r.out);
    assert.match(r.out, /BLOCKED/);
  } finally {
    fs.writeFileSync(matrix, original);
  }
  const restore = run();
  assert.equal(restore.code, 0, 'gate green again after restore (no residue)');
});

/* W11 postmortem: a wave once shipped a lock with zero package entries — npm ci
   died in CI while the gate stayed green. Lock STRUCTURE is now part of the
   version check, and this test proves the sabotage is caught. */
test('w6: a structurally empty package-lock.json blocks the gate', () => {
  const lockPath = path.join(ROOT, 'package-lock.json');
  const original = fs.readFileSync(lockPath, 'utf8');
  try {
    const broken = JSON.parse(original);
    broken.packages = { '': broken.packages[''] };
    fs.writeFileSync(lockPath, JSON.stringify(broken, null, 2));
    const r = run();
    assert.equal(r.code, 1, 'empty lock must block');
    assert.ok(r.out.includes('FAIL  version-literals'), r.out);
    assert.match(r.out, /CORRUPT: only 1 package entries/);
  } finally {
    fs.writeFileSync(lockPath, original);
  }
  assert.equal(run().code, 0, 'gate recovers after restore');
});

test('w6: a planted opencode-shaped key is caught; the repo dummy is NOT a false positive', () => {
  const tmpDir = path.join(ROOT, 'test', 'w6-tmp-fixture');
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    /* the existing test fixture oc_sk_dummy-not-real must pass (triple 0 baseline below) */
    const r0 = run();
    assert.equal(r0.code, 0, r0.out);
    /* plant a realistic key — gate must fail */
    const planted = path.join(tmpDir, 'leak.js');
    fs.writeFileSync(planted, 'const k = "oc_sk_' + 'a1b2c3d4e5f67890' + '";\n');
    const r1 = run();
    assert.equal(r1.code, 1, 'planted key must block the gate');
    assert.ok(r1.out.includes('FAIL  secret-hygiene'), r1.out);
    fs.rmSync(planted);
    const r2 = run();
    assert.equal(r2.code, 0, 'gate recovers once the leak is gone');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
