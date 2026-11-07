/**
 * Studio scaffold tests — real HTTP round-trips against a real server bound
 * to real kernel objects (EventBus/TelemetryLedger/AuditChain instances).
 * No mocks, no simulated responses (PINK CURSOR).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventBus } from '../src/v2/runtime/events.js';
import { TelemetryLedger } from '../src/v2/telemetry/ledger.js';
import { AuditChain } from '../src/v2/audit/chain.js';
import { createStudioServer } from '../src/v2/studio/server.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'majin-studio-')); }

async function boot() {
  const dir = tmp();
  const telemetryDir = path.join(dir, 'telemetry');
  const auditDir = path.join(dir, 'audit');
  const bus = new EventBus();
  const ledger = new TelemetryLedger(telemetryDir);
  const chain = new AuditChain(auditDir);
  const studio = createStudioServer({ bus, telemetryDir, auditDir });
  const bound = await studio.listen({ port: 0 });
  return { studio, bus, ledger, chain, bound, dir };
}

test('1. GET / serves the operator page with ZERO external asset references', async () => {
  const { studio, bound } = await boot();
  const res = await fetch(bound.url + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /MAJIN V2 Studio/);
  assert.match(html, /EventSource\('\/api\/events'\)/);
  // no CDN scripts/styles/fonts — offline-by-construction guarantee is testable
  assert.equal(/(src|href)\s*=\s*"https?:/i.test(html), false);
  await studio.close();
});

test('2. SSE stream: synthetic server.connected FIRST, then replay, then live events', async () => {
  const { studio, bus, bound } = await boot();
  bus.emit('goal.created', { goalId: 'g-replay' }); // lands in ring buffer BEFORE connect

  const res = await fetch(bound.url + '/api/events');
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  const firstTwo = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no frames within 4s')), 4000);
    let buf = '';
    (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (chunk.startsWith('data: ')) frames.push(JSON.parse(chunk.slice(6)));
        }
        if (frames.length >= 2) { clearTimeout(timer); resolve(); return; }
      }
      clearTimeout(timer); reject(new Error('stream ended early'));
    })().catch(reject);
  });
  await firstTwo; // connected + replay arrived → subscription is now active
  bus.emit('task.started', { taskId: 't-live' });

  const liveFrame = await Promise.race([
    (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return null;
        const txt = decoder.decode(value, { stream: true });
        for (const line of txt.split('\n')) {
          if (line.startsWith('data: ')) {
            const f = JSON.parse(line.slice(6));
            frames.push(f);
            if (f.type === 'task.started') return f;
          }
        }
      }
    })(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('live frame timeout')), 4000)),
  ]);
  assert.equal(frames[0].type, 'server.connected');
  assert.ok(frames.some((f) => f.type === 'goal.created' && f.goalId === 'g-replay'), 'replay delivered');
  assert.equal(liveFrame.taskId, 't-live');
  await reader.cancel().catch(() => {});
  await studio.close();
});

test('3. GET /api/telemetry aggregates REAL ledger shards written through TelemetryLedger', async () => {
  const { studio, ledger, bound } = await boot();
  ledger.append('goal.start', { goalId: 'g1', risk: 'low', compilerSource: 'cli' });
  ledger.append('goal.finish', { goalId: 'g1', finalState: 'COMPLETED', durationMs: 1200, tasks: 3, done: 3, failed: 0, receipts: 3, verifiedReceipts: 3 });
  ledger.append('model.call', { provider: 'opencode', elapsedMs: 800, usageTotal: 2200, model: 'm1', result: 'ok' });
  ledger.append('verification', { goalId: 'g1', acceptanceId: 'a1', kind: 'file-exists', verified: true, durationMs: 12 });

  const res = await fetch(bound.url + '/api/telemetry?days=7');
  assert.equal(res.status, 200);
  const t = await res.json();
  assert.equal(t.events, 4);
  assert.equal(t.goals.count, 1);
  assert.equal(t.goals.completed, 1);
  assert.equal(t.models.callCount, 1);
  assert.equal(t.models.byProvider.opencode.tokens, 2200);
  assert.equal(t.verification.count, 1);
  assert.equal(t.verification.successRate, 1);
  await studio.close();
});

test('4. GET /api/audit/verify reports the honest verdict of the REAL chain on disk', async () => {
  const { studio, chain, bound, dir } = await boot();
  chain.append('event', { origin: 'studio-test' });

  let v = await (await fetch(bound.url + '/api/audit/verify')).json();
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.entries, 1);

  // corrupt the real on-disk chain — the endpoint must report broken, not hide it
  const lines = fs.readFileSync(chain.file, 'utf8').trim().split('\n');
  const forged = JSON.parse(lines[0]);
  forged.payload.origin = 'forged';
  fs.writeFileSync(chain.file, JSON.stringify(forged) + '\n');
  await studio.close();

  // endpoint reads fresh state: a NEW server over the same dirs still sees broken
  const again = createStudioServer({ bus: new EventBus(), telemetryDir: path.join(dir, 'telemetry'), auditDir: path.join(dir, 'audit') });
  const b2 = await again.listen({ port: 0 });
  v = await (await fetch(b2.url + '/api/audit/verify')).json();
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'HASH_MISMATCH');
  await again.close();
});

test('5. read-only by default: unsupported methods 405, consent writes 403 without enableWrites', async () => {
  const { studio, bound } = await boot();
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = await fetch(bound.url + '/api/audit/verify', { method });
    assert.equal(res.status, 405, method);
    const body = await res.json();
    assert.equal(body.error, 'unsupported method on this surface');
  }
  const grant = await fetch(bound.url + '/api/consent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'voice:external', user: 'tester', mode: 'once' }),
  });
  assert.equal(grant.status, 403);
  assert.match((await grant.json()).detail, /silence\/disabled means NO/);
  const res = await fetch(bound.url + '/api/nope');
  assert.equal(res.status, 404);
  await studio.close();
});

test('6. server teardown unsubscribes from the bus (no listener leak)', async () => {
  const { studio, bus } = await boot();
  const before = bus._ee.listenerCount('goal.created');
  assert.ok(before >= 1, 'studio had subscribed');
  await studio.close();
  assert.equal(bus._ee.listenerCount('goal.created'), before - 1);
});

test('7. CLI --studio: real child process serves /, SIGINT exits 0)', async () => {
  const dir = tmp();
  const bin = path.resolve(import.meta.dirname, '..', 'bin', 'majin-v2.mjs');
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [bin, '--studio', '--port', '0', '--telemetry-dir', path.join(dir, 't'), '--audit-dir', path.join(dir, 'a')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('studio did not boot: ' + out)), 8000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/at (http:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.on('exit', (code) => reject(new Error(`exited early: ${code}: ${out}`)));
  });
  const res = await fetch(url + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /MAJIN V2 Studio/);
  const apiRes = await fetch(url + '/api/audit/verify');
  assert.equal(apiRes.status, 200);
  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
    child.kill('SIGINT');
  });
  if (process.platform === 'win32') assert.equal(exitCode.signal, 'SIGINT', 'Node terminates Windows children via the requested signal');
  else assert.equal(exitCode.code, 0);
});
