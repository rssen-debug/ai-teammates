/**
 * Doctor lane — honest preflight. Every assert is on a REAL probe:
 * real tmp dirs (write probe), real port bind, real stub runner server,
 * real missing-path, and the key check never reveals the value — only
 * a hash fingerprint. Injected env/fs where the machine would differ.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { runDoctor, formatDoctor } from '../src/v2/ops/doctor.js';

function tmpBase(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const pathsIn = (base) => ({
  telemetry: path.join(base, 'tel'), audit: path.join(base, 'aud'),
  run: path.join(base, 'run'), voice: path.join(base, 'voice'),
  bin: 'bin/majin-v2.mjs',
});

test('1. clean machine view: all CORE OK, optional gates reported honestly, verdict READY_WITH_GATES', async (t) => {
  const base = tmpBase(t);
  const r = await runDoctor({ env: {}, paths: pathsIn(base) });
  assert.equal(r.verdict, 'READY_WITH_GATES');
  for (const c of r.checks.filter((x) => x.req === 'CORE')) assert.equal(c.state, 'OK', c.name);
  const gateStates = Object.fromEntries(r.checks.filter((x) => x.req === 'OPT').map((x) => [x.name, x.state]));
  assert.deepEqual(gateStates, {
    'opencode-key': 'NOT_CONFIGURED', 'gui-runner': 'NOT_CONFIGURED',
    'whisper-stt': 'NOT_CONFIGURED', 'studio-port': 'OK',
  });
  // write probes leave nothing behind
  assert.equal(fs.readdirSync(path.join(base, 'tel')).filter((f) => f.startsWith(".doctor-")).length, 0, "write probes must clean up after themselves");
});

test('2. key presence reported as fingerprint only — value NEVER in the report', async (t) => {
  const secret = 'oc_sk_TESTSECRET_do_not_leak_12345';
  const r = await runDoctor({ env: { OPENCODE_API_KEY: secret }, paths: pathsIn(tmpBase(t)) });
  const row = r.checks.find((c) => c.name === 'opencode-key');
  assert.equal(row.state, 'OK');
  const report = formatDoctor(r);
  assert.ok(!report.includes(secret), 'secret must never appear');
  assert.match(row.detail, /sha256:[0-9a-f]{8}/);
});

test('3. CORE failure is honest NOT_READY: repo entrypoint missing → FAIL, exit-code discipline holds', async (t) => {
  const r = await runDoctor({ env: {}, paths: { ...pathsIn(tmpBase(t)), bin: 'bin/DEFINITELY-MISSING.mjs' } });
  assert.equal(r.verdict, 'NOT_READY');
  const row = r.checks.find((c) => c.name === 'repo-entrypoint');
  assert.equal(row.state, 'FAIL');
  assert.match(formatDoctor(r), /fabricates no OK/);
});

test('4. runner probe: REAL stub server → OK with HTTP status; REAL dead port → NOT_REACHABLE with real error (no hang)', async (t) => {
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end('{}'); });
  await new Promise((r2) => srv.listen(0, '127.0.0.1', r2));
  t.after(() => srv.close());
  const live = `http://127.0.0.1:${srv.address().port}/health`;
  const r1 = await runDoctor({ env: {}, paths: pathsIn(tmpBase(t)), runnerUrl: live });
  assert.equal(r1.checks.find((c) => c.name === 'gui-runner').state, 'OK');

  // find a guaranteed-closed port by listening then releasing
  const probe = http.createServer();
  await new Promise((r2) => probe.listen(0, '127.0.0.1', r2));
  const deadPort = probe.address().port;
  await new Promise((r2) => probe.close(r2));
  const t0 = Date.now();
  const r2 = await runDoctor({ env: {}, paths: pathsIn(tmpBase(t)), runnerUrl: `http://127.0.0.1:${deadPort}/health` });
  const row = r2.checks.find((c) => c.name === 'gui-runner');
  assert.equal(row.state, 'NOT_REACHABLE');
  assert.ok(Date.now() - t0 < 5000, 'dead probe must not hang');
  assert.match(row.detail, /ECONNREFUSED|timeout/);
});

test('5. whisper bin: real file → OK with size; wrong path → MISSING; absent config → NOT_CONFIGURED', async (t) => {
  const base = tmpBase(t);
  const fakeBin = path.join(base, 'whisper-cli.exe');
  fs.writeFileSync(fakeBin, 'MZ' + 'x'.repeat(2048));
  const ok = await runDoctor({ env: {}, paths: pathsIn(base), whisperBin: fakeBin });
  assert.equal(ok.checks.find((c) => c.name === 'whisper-stt').state, 'OK');
  const miss = await runDoctor({ env: {}, paths: pathsIn(base), whisperBin: path.join(base, 'nope.exe') });
  assert.equal(miss.checks.find((c) => c.name === 'whisper-stt').state, 'MISSING');
  const none = await runDoctor({ env: {}, paths: pathsIn(base) });
  assert.equal(none.checks.find((c) => c.name === 'whisper-stt').state, 'NOT_CONFIGURED');
});

test('6. port probe is real: occupied studio port → FAIL (bind evidence)', async (t) => {
  const occ = http.createServer();
  await new Promise((r2) => occ.listen(0, '127.0.0.1', r2));
  t.after(() => occ.close());
  const port = occ.address().port;
  const r = await runDoctor({ env: {}, paths: pathsIn(tmpBase(t)), studioPort: port });
  assert.equal(r.checks.find((c) => c.name === 'studio-port').state, 'FAIL');
});

test('7. CLI: --doctor exits 0 on READY_WITH_GATES / prints table; NOT_READY would exit 1', (t, done) => {
  const child = spawn(process.execPath, ['bin/majin-v2.mjs', '--doctor'], {
    env: { ...process.env, OPENCODE_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.on('exit', (code) => {
    assert.equal(code, 0, out);
    assert.match(out, /MAJIN V2 DOCTOR/);
    assert.match(out, /VERDICT: READY_WITH_GATES/);
    assert.match(out, /opencode-key — live lane gated/);
    done();
  });
});
