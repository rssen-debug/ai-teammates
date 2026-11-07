/**
 * RFC 3161 trusted timestamps for anchors.
 * The fixture under test/fixtures/tsr-anchor/ holds a chain + anchor + a REAL
 * freetsa.org token minted live at build time (public material only — the
 * private key was never copied). Offline tests prove parsing, imprint
 * matching, tamper/stale honesty and refusal states. The fresh live
 * round-trip stays IT-gated (IT_TSA=1) exactly like the other live lanes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { requestTimestamp, verifyTimestamp, hasOpenSsl } from '../src/v2/audit/timestamp.js';
import { verifyAnchor } from '../src/v2/audit/anchor.js';
import { AuditChain } from '../src/v2/audit/chain.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(REPO, 'test', 'fixtures', 'tsr-anchor');
const LIVE = process.env.IT_TSA === '1';

const cloneFixture = (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'tsr-fix-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
};

test('0. fixture is trustworthy: keygen material absent (private), chain + anchor verify independently', () => {
  assert.ok(!fs.existsSync(path.join(FIXTURE, 'keys', 'ed25519.private.pem')), 'private key must NEVER be committed');
  assert.equal(new AuditChain(FIXTURE).verify({ anchor: false }).ok, true);
  assert.equal(verifyAnchor(FIXTURE).cls, 'OK');
});

test('1. TSR_STRUCTURAL: real token parses, imprint matches current anchor, genTime extracted — chain trust honestly NOT claimed', () => {
  const dir = cloneFixture(test);
  const v = verifyTimestamp(dir);
  assert.equal(v.cls, 'TSR_STRUCTURAL');
  assert.equal(v.ok, true);
  assert.equal(v.inconclusive, true);
  assert.equal(v.chainTrusted, false, 'no CA bundle → trust is inconclusive, not fabricated');
  assert.equal(v.aseq, 1);
  assert.match(v.genTime, /2026 GMT/, `real TSA time: ${v.genTime}`);
  assert.match(v.detail, /chain trust NOT established/);
});

test('2. TSR_MISMATCH: foreign token (meta imprint flipped) is a hard failure — never upgraded', (t) => {
  const dir = cloneFixture(t);
  const metaPath = path.join(dir, 'anchor-tsr.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta.imprint = 'f'.repeat(64);
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  const v = verifyTimestamp(dir);
  assert.equal(v.cls, 'TSR_MISMATCH');
  assert.equal(v.ok, false, 'a token proving nothing we hold is a FAILURE, not inconclusive');
});

test('3. TSR_STALE: later anchor without restamp leaves the token honestly stale (seq 1 proven, head newer)', (t) => {
  const dir = cloneFixture(t);
  // simulate "a second anchor was made after stamping": the head record differs from meta.tsrForHash
  const file = path.join(dir, 'anchors.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const a2 = JSON.parse(lines[0]);
  a2.aseq = 2; a2.anchorHash = 'a'.repeat(64);
  fs.writeFileSync(file, lines[0] + '\n' + JSON.stringify(a2) + '\n');
  const v = verifyTimestamp(dir);
  assert.equal(v.cls, 'TSR_STALE');
  assert.equal(v.inconclusive, true);
  assert.match(v.detail, /fresher anchors exist un-stamped/);
});

test('4. TSR_NOT_REQUESTED: no token file is inconclusive — never a failure and never an OK', (t) => {
  const dir = cloneFixture(t);
  fs.unlinkSync(path.join(dir, 'anchors.tsr'));
  fs.unlinkSync(path.join(dir, 'anchor-tsr.json'));
  const v = verifyTimestamp(dir);
  assert.equal(v.cls, 'TSR_NOT_REQUESTED');
  assert.equal(v.inconclusive, true);
});

test('5. requestTimestamp refuses without anchor (NO_ANCHOR) and keeps anchor intact on TSA refusal (TSA_REFUSED honest partial)', async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'tsr-req-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(() => requestTimestamp(dir, 'https://irrelevant.invalid', { fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }) }), (e) => e.cls === 'NO_ANCHOR');
  // TSA refuses: error class honest, nothing stored
  const dir2 = cloneFixture(t);
  fs.unlinkSync(path.join(dir2, 'anchors.tsr'));
  fs.unlinkSync(path.join(dir2, 'anchor-tsr.json'));
  await assert.rejects(() => requestTimestamp(dir2, 'https://tsa.invalid', { fetchImpl: async () => ({ ok: false, status: 503 }) }), (e) => e.cls === 'TSA_REFUSED');
  assert.ok(!fs.existsSync(path.join(dir2, 'anchors.tsr')), 'refused → no token stored');
  assert.equal(verifyAnchor(dir2).cls, 'OK', 'anchor itself untouched by the refusal');
});

test('6. CLI: --audit-verify --with-anchor --with-tsr prints the honest TSR line on the fixture', (t, done) => {
  const dir = cloneFixture(t);
  const child = spawn(process.execPath, ['bin/majin-v2.mjs', '--audit-verify', dir, '--with-anchor', '--with-tsr'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.on('exit', (code) => {
    assert.equal(code, 0, out);
    assert.match(out, /AUDIT ok ENTRIES=2/);
    assert.match(out, /ANCHOR OK/);
    assert.match(out, /TSR TSR_STRUCTURAL TIME="[^"]*2026 GMT"/);
    done();
  });
});

(LIVE ? test : test.skip)('IT LIVE (IT_TSA=1): fresh anchor builds a fresh token against a real TSA end-to-end', async () => {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'tsr-live-'));
  const { keygen, anchor } = await import('../src/v2/audit/anchor.js');
  const chain = new AuditChain(tmp);
  chain.append('event', { live: 'IT_TSA', at: new Date().toISOString() });
  keygen(tmp);
  anchor(tmp);
  const r = await requestTimestamp(tmp, process.env.IT_TSA_URL || 'https://freetsa.org/tsr');
  assert.ok(r.bytes > 1000, 'real token');
  assert.equal(verifyTimestamp(tmp).cls, 'TSR_STRUCTURAL');
  console.log(`  LIVE TSR: genTime=${r.genTime} bytes=${r.bytes}`);
});
