/**
 * Operator write-actions lane — consent grant/revoke via Studio REST,
 * gated behind enableWrites, executed by the REAL Approvals class, mirrored
 * into the REAL audit chain. Silence/disabled means NO, never a silent grant.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventBus } from '../src/v2/runtime/events.js';
import { TelemetryLedger } from '../src/v2/telemetry/ledger.js';
import { AuditChain } from '../src/v2/audit/chain.js';
import { AuditBind } from '../src/v2/audit/bind.js';
import { Approvals } from '../src/v2/safety/approvals.js';
import { createStudioServer } from '../src/v2/studio/server.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'majin-writes-')); }

async function boot({ enableWrites = true, withAudit = false } = {}) {
  const dir = tmp();
  const telemetryDir = path.join(dir, 'telemetry');
  const auditDir = path.join(dir, 'audit');
  const bus = new EventBus();
  new TelemetryLedger(telemetryDir);
  const chain = new AuditChain(auditDir);
  const approvals = new Approvals(bus);
  let bind = null;
  if (withAudit) {
    bind = new AuditBind(chain);
    bind.attach(bus);
  }
  const studio = createStudioServer({ bus, telemetryDir, auditDir, approvals, enableWrites });
  const bound = await studio.listen({ port: 0 });
  return { studio, bus, chain, bind, approvals, bound, dir, cleanup: async () => { bind?.detach(); await studio.close(); } };
}

const grantBody = (over = {}) => JSON.stringify({ scope: 'voice:external', user: 'operator-stina', mode: 'once', ...over });

test('1. grant → REAL Approvals.check() allows exactly that scope, once', async () => {
  const { bound, approvals, cleanup } = await boot();
  const res = await fetch(bound.url + '/api/consent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: grantBody() });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.granted, 'voice:external');
  assert.equal(body.status.mode, 'once');
  assert.equal(body.status.user, 'operator-stina');

  // the consent is real: the executor's own check consumes it exactly once
  assert.equal(approvals.check('voice:external').decision, 'allow');
  assert.equal(approvals.check('voice:external').decision, 'waiting'); // consumed
  await cleanup();
});

test('2. no named human → 400 (no self-consent is enforced by Approvals, surfaced honestly)', async () => {
  const { bound, cleanup } = await boot();
  const res = await fetch(bound.url + '/api/consent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'fs:delete:/tmp/x', mode: 'once' }) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /named human/);
  await cleanup();
});

test('3. unknown mode / bad scope / bad JSON each get their own honest 400', async () => {
  const { bound, cleanup } = await boot();
  const bad1 = await fetch(bound.url + '/api/consent', { method: 'POST', body: grantBody({ mode: 'forever' }), headers: { 'content-type': 'application/json' } });
  assert.equal(bad1.status, 400);
  const bad2 = await fetch(bound.url + '/api/consent', { method: 'POST', body: JSON.stringify({ user: 'x', mode: 'once' }), headers: { 'content-type': 'application/json' } });
  assert.equal(bad2.status, 400);
  assert.match((await bad2.json()).error, /scope/);
  const bad3 = await fetch(bound.url + '/api/consent', { method: 'POST', body: '{not json', headers: { 'content-type': 'application/json' } });
  assert.equal(bad3.status, 400);
  assert.match((await bad3.json()).error, /invalid JSON/);
  await cleanup();
});

test('4. oversized body → 413, connection survives', async () => {
  const { bound, cleanup } = await boot();
  const res = await fetch(bound.url + '/api/consent', { method: 'POST', body: '{"a":"' + 'x'.repeat(9000) + '"}', headers: { 'content-type': 'application/json' } });
  assert.equal(res.status, 413);
  const ok = await fetch(bound.url + '/api/audit/verify');
  assert.equal(ok.status, 200, 'server still answering after the rejected body');
  await cleanup();
});

test('5. revoke removes the consent; check() afterwards is waiting', async () => {
  const { bound, approvals, cleanup } = await boot();
  await fetch(bound.url + '/api/consent', { method: 'POST', body: grantBody({ mode: 'session', scope: 'browser:submit-form:example.com' }), headers: { 'content-type': 'application/json' } });
  let st = await (await fetch(bound.url + '/api/consent/status?scope=' + encodeURIComponent('browser:submit-form:example.com'))).json();
  assert.equal(st.granted, true);

  const res = await fetch(bound.url + '/api/consent?scope=' + encodeURIComponent('browser:submit-form:example.com'), { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { revoked: 'browser:submit-form:example.com', existed: true });

  st = await (await fetch(bound.url + '/api/consent/status?scope=' + encodeURIComponent('browser:submit-form:example.com'))).json();
  assert.equal(st.granted, false);
  assert.equal(approvals.check('browser:submit-form:example.com').decision, 'waiting');
  await cleanup();
});

test('6. every write lands in the audit chain (consent kinds), chain verifies', async () => {
  const { bound, chain, cleanup } = await boot({ withAudit: true });
  await fetch(bound.url + '/api/consent', { method: 'POST', body: grantBody({ scope: 'shell:hold', mode: 'limited', maxUses: 3 }), headers: { 'content-type': 'application/json' } });
  await fetch(bound.url + '/api/consent?scope=shell:hold', { method: 'DELETE' });

  const entries = fs.readFileSync(chain.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const kinds = entries.map((e) => `${e.kind}:${e.payload.type ?? e.payload.taskId ?? ''}`);
  assert.ok(kinds.some((k) => k === 'consent:task.updated'), JSON.stringify(kinds)); // grant lands via task.updated consent:<scope>
  const grant = entries.find((e) => e.payload.taskId === 'consent:shell:hold');
  assert.equal(grant.payload.to, 'granted');
  assert.equal(grant.payload.maxUses, 3);
  const revoke = entries.find((e) => e.payload.type === 'consent.revoked');
  assert.equal(revoke.payload.scope, 'shell:hold');
  assert.equal(chain.verify().ok, true);
  await cleanup();
});

test('7. TTL consent: status() reports expiry honestly without consuming uses', async () => {
  const { bound, approvals, cleanup } = await boot();
  await fetch(bound.url + '/api/consent', { method: 'POST', body: grantBody({ scope: 'voice:external', mode: 'limited', maxUses: 2, ttlMs: 50 }), headers: { 'content-type': 'application/json' } });
  const before = approvals.status('voice:external');
  assert.equal(before.usesLeft, 2);
  assert.equal(before.uses, 0, 'status() must not consume');
  await new Promise((r) => setTimeout(r, 80));
  const after = approvals.status('voice:external');
  assert.equal(after.granted, false);
  assert.equal(after.expired, true);
  assert.equal(approvals.check('voice:external').decision, 'waiting');
  await cleanup();
});

test('8. enableWrites without Approvals is a constructor error — the gate is wired at build time', () => {
  const dir = tmp();
  assert.throws(
    () => createStudioServer({ bus: new EventBus(), telemetryDir: dir, auditDir: dir, enableWrites: true }),
    /requires an Approvals instance/
  );
});

test('9. CLI --studio --enable-writes: real child, real grant over HTTP, audit chain has it on disk', async () => {
  const dir = tmp();
  const bin = path.resolve(import.meta.dirname, '..', 'bin', 'majin-v2.mjs');
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [bin, '--studio', '--enable-writes', '--port', '0', '--telemetry-dir', path.join(dir, 't'), '--audit-dir', path.join(dir, 'a')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no boot banner: ' + out)), 8000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/at (http:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.on('exit', (code) => reject(new Error(`exited early ${code}: ${out}`)));
  });
  assert.match(out, /consent writes ENABLED/);

  const res = await fetch(url + '/api/consent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'fs:write:/tmp/demo', user: 'operator-cli', mode: 'once' }) });
  assert.equal(res.status, 201);

  const exitCode = await new Promise((resolve) => { child.on('exit', (code, signal) => resolve({ code, signal })); child.kill('SIGINT'); });
  if (process.platform === 'win32') assert.equal(exitCode.signal, 'SIGINT', 'Node terminates Windows children via the requested signal');
  else assert.equal(exitCode.code, 0);

  const chainFile = path.join(dir, 'a', 'chain.jsonl');
  assert.ok(fs.existsSync(chainFile), 'audit chain written by the child process');
  const entries = fs.readFileSync(chainFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const grant = entries.find((e) => e.payload.taskId === 'consent:fs:write:/tmp/demo');
  assert.ok(grant, 'grant mirrored into the chain');
  assert.equal(grant.payload.to, 'granted');
});

test('10. page reflects the gate honestly: writes ON → live form + WRITES=true; OFF → hidden + no affordance', async () => {
  const on = await boot({ enableWrites: true });
  const htmlOn = await (await fetch(on.bound.url + '/')).text();
  assert.match(htmlOn, /var WRITES=true;/);
  assert.match(htmlOn, /id="c-grant"/);
  assert.match(htmlOn, /consent writes ENABLED/);
  await on.cleanup();

  const offDir = tmp();
  const off = createStudioServer({ bus: new EventBus(), telemetryDir: offDir, auditDir: offDir });
  const bOff = await off.listen({ port: 0 });
  const htmlOff = await (await fetch(bOff.url + '/')).text();
  assert.match(htmlOff, /var WRITES=false;/);
  assert.match(htmlOff, /silence means NO/);
  assert.match(htmlOff, /consent-formwrap" hidden/);
  assert.equal(/(src|href)\s*=\s*"https?:/i.test(htmlOff), false, 'zero external assets with the panel too');
  await off.close();
});

test('11. SSE delivers consent lifecycle LIVE: the exact loop the consent panel listens on', async () => {
  const { bound, cleanup } = await boot({ enableWrites: true });
  const res = await fetch(bound.url + '/api/events');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  // wait for server.connected so the subscription is active
  for (;;) {
    const { value } = await reader.read();
    if (decoder.decode(value).includes('server.connected')) break;
  }
  await fetch(bound.url + '/api/consent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: grantBody({ scope: 'shell:hold', mode: 'limited', maxUses: 2 }) });
  const seen = await Promise.race([
    (async () => {
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return null;
        buf += decoder.decode(value, { stream: true });
        for (const line of buf.split('\n')) {
          if (line.startsWith('data: ') && line.includes('task.updated') && line.includes('consent:shell:hold')) return JSON.parse(line.slice(6));
        }
      }
    })(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('consent frame timeout')), 4000)),
  ]);
  assert.equal(seen.taskId, 'consent:shell:hold');
  assert.equal(seen.to, 'granted');
  await reader.cancel().catch(() => {});
  await cleanup();
});
