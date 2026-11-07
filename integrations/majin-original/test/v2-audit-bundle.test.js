/**
 * Portable audit bundle lane.
 * The proof that matters: a bundle verified on "another machine" (a tmp dir
 * semantics test) with PUBLIC material only — and every lie we can attempt
 * against it is caught by name (tampered file, stripped manifest, sneaked
 * private key, broken chain accepted nowhere).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exportBundle, verifyBundle, findPrivateMaterial } from '../src/v2/audit/export.js';
import { AuditChain } from '../src/v2/audit/chain.js';
import { keygen, anchor } from '../src/v2/audit/anchor.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSR_FIXTURE = path.join(REPO, 'test', 'fixtures', 'tsr-anchor');

function tmp(t, name = 'bundle-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function buildAuditDir(t, { entries = 3, withAnchor = true } = {}) {
  const dir = tmp(t, 'bundle-src-');
  const chain = new AuditChain(dir);
  for (let i = 0; i < entries; i++) chain.append('event', { i, unicode: 'åäö ☃', nested: { a: [1, 2.5] } });
  if (withAnchor) { keygen(dir); anchor(dir); }
  return dir;
}

test('1. round trip: export → verify → BUNDLE_OK with chain/anchor/tsr verdicts composed honestly', (t) => {
  const src = tmp(t, 'bundle-src-fix-');
  fs.cpSync(TSR_FIXTURE, src, { recursive: true }); // chain + anchor + REAL freetsa token
  const out = path.join(tmp(t), 'dossier');
  const r = exportBundle(src, out);
  assert.equal(r.ok, true);
  assert.equal(r.stats.tsr, true);
  const v = verifyBundle(out);
  assert.equal(v.cls, 'BUNDLE_OK');
  assert.equal(v.ok, true);
  assert.equal(v.chain.entries, 2);
  assert.equal(v.anchors.cls, 'OK');
  assert.equal(v.tsr.cls, 'TSR_STRUCTURAL');
  assert.match(v.tsr.genTime, /2026 GMT/);
  assert.match(v.detail, /existence-in-time/);
});

test('2. TAMPERED: a single flipped byte inside the bundle is caught with the filename', (t) => {
  const src = buildAuditDir(t);
  const out = path.join(tmp(t), 'dossier');
  exportBundle(src, out);
  const file = path.join(out, 'chain.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines[0] = lines[0].replace(/"ok"/, '"FALSE"').length === lines[0].length ? lines[0].slice(0, -1) + 'X' : lines[0];
  fs.writeFileSync(file, lines.join('\n'));
  const v = verifyBundle(out);
  assert.equal(v.ok, false);
  assert.equal(v.cls, 'BUNDLE_TAMPERED:chain.jsonl');
  assert.match(v.detail, /sha256 differs/);
});

test('3. INCOMPLETE: manifest stripped → honest incomplete, never passed as valid', (t) => {
  const src = buildAuditDir(t);
  const out = path.join(tmp(t), 'dossier');
  exportBundle(src, out);
  fs.unlinkSync(path.join(out, 'MANIFEST.json'));
  const v = verifyBundle(out);
  assert.equal(v.ok, false);
  assert.equal(v.cls, 'BUNDLE_INCOMPLETE');
  // and a foreign format never upgrades
  fs.writeFileSync(path.join(out, 'MANIFEST.json'), JSON.stringify({ format: 'other', version: 99 }));
  assert.equal(verifyBundle(out).cls, 'BUNDLE_UNTRUSTED_FORMAT');
});

test('4. PUBLIC-ONLY INVARIANT: private key in source never appears in bundle; leak-scanner proven on planted file', (t) => {
  const src = buildAuditDir(t); // source HAS a real private key — that is normal and must stay local
  assert.ok(fs.existsSync(path.join(src, 'keys', 'ed25519.private.pem')), 'precondition: source holds the private key');
  const out = path.join(tmp(t), 'dossier');
  const r = exportBundle(src, out);
  assert.equal(r.ok, true);
  assert.ok(!fs.existsSync(path.join(out, 'keys', 'ed25519.private.pem')), 'private key must not travel');
  assert.ok(fs.existsSync(path.join(out, 'keys', 'ed25519.public.pem')), 'public key must travel (bundle verifiability)');
  assert.deepEqual(findPrivateMaterial(out), [], 'scanner: bundle is public-only');
  // the wipe-guard itself is proven on a planted leak: scanner must find it by name
  fs.mkdirSync(path.join(out, 'sneak'), { recursive: true });
  const planted = path.join(out, 'sneak', 'anything.private.pem');
  fs.writeFileSync(planted, 'LEAK');
  const hits = findPrivateMaterial(out);
  assert.ok(hits.some((h) => h.endsWith('anything.private.pem')), 'scanner catches planted private material');
});

test('4b. UNVERIFIABLE IS REFUSED: anchors exist but public key missing → BUNDLE_INCOMPLETE (a bundle that cannot verify is a lie)', (t) => {
  const src = buildAuditDir(t);
  fs.unlinkSync(path.join(src, 'keys', 'ed25519.public.pem'));
  assert.throws(() => exportBundle(src, path.join(tmp(t), 'dossier')), (e) => e.cls === 'BUNDLE_INCOMPLETE' && /public key/.test(e.message));
});

test('5. BROKEN CHAIN REFUSED at export: false evidence is never packaged', (t) => {
  const src = buildAuditDir(t);
  // corrupt chain AFTER anchor: flip one entry byte
  const f = path.join(src, 'chain.jsonl');
  const content = fs.readFileSync(f, 'utf8');
  const corrupted = content.replace(/"seq":1/, '"seq":7');
  assert.notEqual(corrupted, content);
  fs.writeFileSync(f, corrupted);
  assert.throws(() => exportBundle(src, path.join(tmp(t), 'dossier')), (e) => e.cls === 'CHAIN_BROKEN');
});

test('6. refusal geometry: destination inside source is refused (recursive self-copy)', (t) => {
  const src = buildAuditDir(t);
  assert.throws(() => exportBundle(src, path.join(src, 'self')), /REFUSED/);
});

test('7. no-anchor bundle: chain-only export verifies with honest NO_ANCHOR inconclusive', (t) => {
  const src = buildAuditDir(t, { withAnchor: false });
  const out = path.join(tmp(t), 'dossier');
  exportBundle(src, out);
  const v = verifyBundle(out);
  assert.equal(v.ok, true);
  assert.equal(v.cls, 'BUNDLE_OK');
  assert.equal(v.anchors.cls, 'NO_ANCHOR');
  assert.equal(v.tsr.cls, 'TSR_NOT_REQUESTED');
});

test('8. CLI: --audit-export + --bundle-verify round trip; tamper → exit 1', (t, done) => {
  const src = buildAuditDir(t);
  const base = tmp(t);
  const out = path.join(base, 'dossier');
  const ex = spawn(process.execPath, ['bin/majin-v2.mjs', '--audit-export', src, '--out', out], { stdio: ['ignore', 'pipe', 'pipe'] });
  let exOut = '';
  ex.stdout.on('data', (d) => { exOut += d; });
  ex.on('exit', (code) => {
    assert.equal(code, 0, exOut);
    assert.match(exOut, /AUDIT bundle OK/);
    const ver = spawn(process.execPath, ['bin/majin-v2.mjs', '--bundle-verify', out], { stdio: ['ignore', 'pipe', 'pipe'] });
    let verOut = '';
    ver.stdout.on('data', (d) => { verOut += d; });
    ver.on('exit', (code2) => {
      assert.equal(code2, 0, verOut);
      assert.match(verOut, /BUNDLE BUNDLE_OK/);
      // tamper then reverify → exit 1
      const f = path.join(out, 'head.json');
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/../, '00'));
      const bad = spawn(process.execPath, ['bin/majin-v2.mjs', '--bundle-verify', out], { stdio: ['ignore', 'pipe', 'pipe'] });
      let badOut = '';
      bad.stdout.on('data', (d) => { badOut += d; });
      bad.on('exit', (code3) => {
        assert.equal(code3, 1, badOut);
        assert.match(badOut, /BUNDLE_TAMPERED:head\.json/);
        done();
      });
    });
  });
});
