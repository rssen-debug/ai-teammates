/**
 * Studio doctor panel — dogfoods the preflight lane over HTTP.
 * The proofs that matter: secret never leaves the machine in any form,
 * the probe rows are REAL (port bind + dir write + runner reachability),
 * and the gate sentence is the same honest shape as every other surface.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createStudioServer } from '../src/v2/studio/server.js';
import { EventBus } from '../src/v2/runtime/events.js';

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-doctor-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

async function boot(t, { doctor = null, env = {} } = {}) {
  const dir = tmp(t);
  const auditDir = path.join(dir, 'audit');
  const telemetryDir = path.join(dir, 'telemetry');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.mkdirSync(telemetryDir, { recursive: true });
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { v === undefined ? delete process.env[k] : (process.env[k] = v); } });
  const studio = createStudioServer({ bus: new EventBus(), telemetryDir, auditDir, enableDoctor: doctor });
  const bound = await studio.listen({ port: 0 });
  t.after(() => studio.close());
  return { studio, bound, dir };
}

test('1. gate honest: without the flag, 403 SURFACE_DISABLED ("disabled means NO probe")', async (t) => {
  const { bound } = await boot(t, { doctor: null });
  const r = await fetch(bound.url + '/api/doctor/run', { method: 'POST', body: '{}' }).then(async (x) => ({ code: x.status, body: await x.json() }));
  assert.equal(r.code, 403);
  assert.equal(r.body.cls, 'SURFACE_DISABLED');
  assert.match(r.body.error, /disabled means NO probe/);
});

test('2. ENABLED: real probes on the servers own dirs — CORE OK, verdict composed honestly', async (t) => {
  const { bound } = await boot(t, { doctor: { studioPort: 0 } });
  const r = await fetch(bound.url + '/api/doctor/run', { method: 'POST', body: '{}' }).then(async (x) => ({ code: x.status, body: await x.json() }));
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.verdict, 'READY_WITH_GATES');
  const names = Object.fromEntries(r.body.checks.map((c) => [c.name, c.state]));
  assert.equal(names['node-runtime'], 'OK');
  assert.equal(names['dir:telemetry'], 'OK');
  assert.equal(names['dir:audit'], 'OK');
  assert.equal(names['opencode-key'], 'NOT_CONFIGURED');
  assert.equal(names['gui-runner'], 'NOT_CONFIGURED');
});

test('3. SECRET DISCIPLINE OVER HTTP: key present → fingerprint only; the secret bytes never appear in the response', async (t) => {
  const secret = 'oc_sk_UISECRET_0123456789abcdef';
  const wantFp = crypto.createHash('sha256').update(secret).digest('hex').slice(0, 8);
  const { bound } = await boot(t, { doctor: {}, env: { OPENCODE_API_KEY: secret } });
  const r = await fetch(bound.url + '/api/doctor/run', { method: 'POST', body: '{}' }).then(async (x) => ({ code: x.status, body: await x.json() }));
  const raw = JSON.stringify(r.body);
  assert.ok(!raw.includes(secret), 'the secret must never cross the HTTP boundary');
  const row = r.body.checks.find((c) => c.name === 'opencode-key');
  assert.equal(row.state, 'OK');
  assert.ok(row.detail.includes(`sha256:${wantFp}`), 'fingerprint rendered, exactly like the CLI');
});

test('4. runner probe over UI: stub runner → OK with status; unreachable → NOT_REACHABLE, server still alive', async (t) => {
  const stub = http.createServer((req, res) => { res.writeHead(200); res.end('{}'); });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  t.after(() => stub.close());
  const live = await boot(t, { doctor: { runnerUrl: `http://127.0.0.1:${stub.address().port}/health` } });
  const r1 = await fetch(live.bound.url + '/api/doctor/run', { method: 'POST', body: '{}' }).then((x) => x.json());
  assert.equal(r1.checks.find((c) => c.name === 'gui-runner').state, 'OK');
  const dead = await boot(t, { doctor: { runnerUrl: 'http://127.0.0.1:1/health' } });
  const r2 = await fetch(dead.bound.url + '/api/doctor/run', { method: 'POST', body: '{}' }).then(async (x) => ({ code: x.status, body: await x.json() }));
  assert.equal(r2.code, 200);
  assert.equal(r2.body.checks.find((c) => c.name === 'gui-runner').state, 'NOT_REACHABLE');
  const page = await fetch(dead.bound.url + '/').then((x) => x.text());
  assert.ok(page.includes('MAJIN V2 Studio'), 'server alive after the refused probe');
});

test('5. page gate-truthful: #doctor rendered hidden/enabled exactly with the flag; mode sentence honest both ways', async (t) => {
  const off = await boot(t, { doctor: null });
  const on = await boot(t, { doctor: {} });
  const hOff = await fetch(off.bound.url + '/').then((x) => x.text());
  const hOn = await fetch(on.bound.url + '/').then((x) => x.text());
  assert.match(hOff, /doctor panel disabled \(start with --enable-doctor-panel; disabled means NO probe\)/);
  assert.match(hOn, /doctor panel ENABLED/);
  assert.match(hOn, /secrets render as fingerprints only/);
  assert.ok(hOn.includes('id="d-run"'));
});

test('6. occupied studio port surfaces FAIL via the panel probe (real bind evidence, same row as CLI)', async (t) => {
  const occ = http.createServer();
  await new Promise((r) => occ.listen(0, '127.0.0.1', r));
  t.after(() => occ.close());
  const { bound } = await boot(t, { doctor: { studioPort: occ.address().port } });
  const r = await fetch(bound.url + '/api/doctor/run', { method: 'POST', body: '{}' }).then((x) => x.json());
  assert.equal(r.checks.find((c) => c.name === 'studio-port').state, 'FAIL');
});
