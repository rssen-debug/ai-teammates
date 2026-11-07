/**
 * Studio evidence-dossier panel — dogfoods the bundle lane over HTTP.
 * Same surface discipline as goals/voice: OFF unless explicitly enabled,
 * destination is operator-fixed only, every verdict passes through honestly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createStudioServer } from '../src/v2/studio/server.js';
import { EventBus } from '../src/v2/runtime/events.js';
import { AuditChain } from '../src/v2/audit/chain.js';
import { keygen, anchor } from '../src/v2/audit/anchor.js';

function tmp(t, name = 'studio-bundle-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

async function boot(t, { bundle = false, withAnchor = false, breakChain = false } = {}) {
  const dir = tmp(t);
  const auditDir = path.join(dir, 'audit');
  const telemetryDir = path.join(dir, 'telemetry');
  fs.mkdirSync(auditDir, { recursive: true });
  const chain = new AuditChain(auditDir);
  chain.append('event', { lane: 'studio-bundle', purpose: 'dossier dogfood' });
  chain.append('consent', { type: 'task.updated', taskId: 'consent:fixture', to: 'granted' });
  if (withAnchor) { keygen(auditDir); anchor(auditDir); }
  if (breakChain) {
    const f = path.join(auditDir, 'chain.jsonl');
    const c = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, c.replace(/"seq":2/, '"seq":9'));
  }
  const studio = createStudioServer({
    bus: new EventBus(), telemetryDir, auditDir,
    enableBundle: bundle ? { dir: path.join(dir, 'dossier') } : null,
  });
  const bound = await studio.listen({ port: 0 });
  t.after(() => studio.close());
  return { studio, bound, dir };
}

const post = (bound, p) => fetch(bound.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(async (r) => ({ code: r.status, body: await r.json() }));

test('1. gate is honest: without --bundle-dir both endpoints 403 SURFACE_DISABLED (disabled means NO dossier)', async (t) => {
  const { bound } = await boot(t, { bundle: false });
  for (const p of ['/api/bundle/export', '/api/bundle/verify']) {
    const r = await post(bound, p);
    assert.equal(r.code, 403, p);
    assert.equal(r.body.cls, 'SURFACE_DISABLED');
    assert.match(r.body.error, /Disabled means NO dossier/);
  }
});

test('2. export over HTTP: dossier created in the OPERATOR-FIXED dir; response carries honest stats', async (t) => {
  const { bound, dir } = await boot(t, { bundle: true, withAnchor: true });
  const r = await post(bound, '/api/bundle/export');
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.files >= 4, true); // chain+head+anchors+pubkey
  assert.equal(r.body.stats.entries, 2);
  assert.equal(r.body.stats.anchors, true);
  assert.ok(fs.existsSync(path.join(dir, 'dossier', 'MANIFEST.json')), 'dossier exists on disk');
  assert.ok(!fs.existsSync(path.join(dir, 'dossier', 'keys', 'ed25519.private.pem')), 'public-only invariant over HTTP too');
});

test('3. verify over HTTP: BUNDLE_OK with composed chain/anchor verdicts; tamper → named file', async (t) => {
  const { bound, dir } = await boot(t, { bundle: true, withAnchor: true });
  await post(bound, '/api/bundle/export');
  const v1 = await post(bound, '/api/bundle/verify');
  assert.equal(v1.code, 200);
  assert.equal(v1.body.cls, 'BUNDLE_OK');
  assert.equal(v1.body.chainEntries, 2);
  assert.equal(v1.body.anchors, 'OK');
  assert.equal(v1.body.tsr, 'TSR_NOT_REQUESTED');
  // now tamper inside the dossier
  const cj = path.join(dir, 'dossier', 'chain.jsonl');
  fs.writeFileSync(cj, fs.readFileSync(cj, 'utf8') + ' ');
  const v2 = await post(bound, '/api/bundle/verify');
  assert.equal(v2.body.ok, false);
  assert.equal(v2.body.cls, 'BUNDLE_TAMPERED:chain.jsonl');
});

test('4. export failure is honest: broken chain → 409 with the real class (false evidence never packaged via UI either)', async (t) => {
  const { bound } = await boot(t, { bundle: true, breakChain: true });
  const r = await post(bound, '/api/bundle/export');
  assert.equal(r.code, 409);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.cls, 'CHAIN_BROKEN');
});

test('5. client destination injection is impossible by construction: no body field can move the dossier', async (t) => {
  const { bound, dir } = await boot(t, { bundle: true, withAnchor: false });
  const sneaky = path.join(dir, 'sneaky-target');
  const r = await fetch(bound.url + '/api/bundle/export', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dest: sneaky, out: sneaky, dir: sneaky }),
  }).then(async (x) => ({ code: x.status, body: await x.json() }));
  assert.equal(r.code, 200);
  assert.ok(fs.existsSync(path.join(dir, 'dossier', 'MANIFEST.json')), 'writes ONLY to the operator-fixed dir');
  assert.ok(!fs.existsSync(sneaky), 'client-supplied dirs are not honoured — ever');
});

test('6. page gate-truthful: #bundle section rendered only when enabled, mode line carries the honest gate sentence', async (t) => {
  const on = await boot(t, { bundle: false });
  const off = await boot(t, { bundle: true });
  const htmlOn = await fetch(on.bound.url + '/').then((x) => x.text());
  const htmlOff = await fetch(off.bound.url + '/').then((x) => x.text());
  assert.match(htmlOn, /bundle surface disabled \(start with --bundle-dir; disabled means NO dossier\)/);
  assert.doesNotMatch(htmlOn, /id="b-export"[^>]*>(?![\s\S]*hidden)/, 'hidden when off');
  assert.match(htmlOff, /bundle export ENABLED/);
  for (const id of ['id="b-export"', 'id="b-verify"', 'id="b-verdict"']) assert.ok(htmlOff.includes(id), id);
});
