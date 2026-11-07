/* MAJIN diagnostics — privacy-first: LOCAL by default, allowlist aldrig slapp,
   upload ENDAST vid explicit opt-in + https-endpoint. Ingen automatisk
   uppladdning av nagot. Fail-first. */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const { createDiagnostics, DIAG_ALLOWLIST } = await import('../src/core/diagnostics.js');

const mkdi = (cfgData = {}) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-diag-'));
  const dirs = { root: home, logs: path.join(home, 'logs') };
  const cfg = { get: (k) => (k === 'diagnostics' ? cfgData : undefined) };
  return createDiagnostics({ dirs, cfg });
};

test('lokal logg fungerar alltid; okanda falt avvisas ur allowlisten', () => {
  const d = mkdi({});
  const r = d.record('turn.done', { job: 'chat', ok: true, ms: 230, prompt: 'MIN HEMLIGA PROMPT', apiKey: 'sk-secret', fileName: 'privat.txt' });
  assert.equal(r.ok, true);
  assert.ok(r.dropped.includes('prompt'), 'prompt droppas');
  assert.ok(r.dropped.includes('apiKey'), 'nycklar droppas alltid');
  assert.ok(r.dropped.includes('fileName'));
  const ev = d.tail(1)[0];
  assert.ok(!('prompt' in ev) && !('apiKey' in ev), JSON.stringify(ev));
  assert.ok(DIAG_ALLOWLIST.has('kind') && DIAG_ALLOWLIST.has('ms'));
});

test('DEFAULT: inget lamnar maskinen — flush ar off utan explicit godkannande', async () => {
  const d = mkdi({});
  d.record('turn.done', { job: 'chat', ok: true, ms: 100 });
  let calls = 0;
  const r = await d.flush({ fetchImpl: async () => { calls++; return { ok: true }; } });
  assert.equal(calls, 0, 'noll natverks-anrop — aldrig utan explicit godkannande');
  assert.equal(r.sent, 0);
  assert.equal(r.status, 'off');
  assert.equal(d.status().claim, 'LOCAL ONLY — nothing is transmitted');
});

test('opt-in UTAN https-endpoint: anstaen iat otan att skicka, status sager sanningen', async () => {
  const d = mkdi({ analytics: true, endpoint: '' });
  d.record('turn.done', { job: 'chat', ok: true, ms: 100 });
  let calls = 0;
  const r = await d.flush({ fetchImpl: async () => { calls++; return { ok: true }; } });
  assert.equal(calls, 0);
  assert.equal(r.status, 'no_endpoint');
  const http = mkdi({ analytics: true, endpoint: 'http://oexempel.com/insecure' });
  http.record('turn.done', { job: 'chat', ok: true, ms: 50 });
  const r2 = await http.flush({ fetchImpl: async () => { throw new Error('skulle inte anropats'); } });
  assert.equal(r2.ok, false);
});

test('opt-in + endpoint: exakt det allowlistade postas och lamnar kön, ta bort ur queue', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-diag2-'));
  const d = createDiagnostics({ dirs: { root: home, logs: path.join(home, 'logs') }, cfg: { get: (k) => (k === 'diagnostics' ? { analytics: true, endpoint: 'https://diagnostics.example/v1' } : undefined) } });
  d.record('turn.done', { job: 'chat', ok: true, ms: 170 });
  d.record('update.result', { updateResult: 'ok', version: '0.5.5' });
  let body = null;
  const r = await d.flush({
    fetchImpl: async (url, init) => { body = JSON.parse(init.body); return { ok: true, status: 200 }; },
  });
  assert.equal(r.sent, 2, JSON.stringify(r));
  assert.equal(body.schema, 'majin.diag.v1');
  assert.equal(body.events.length, 2);
  for (const ev of body.events) {
    for (const k of Object.keys(ev)) assert.ok(DIAG_ALLOWLIST.has(k), `field ${k} utan allowlist!`);
  }
  assert.equal(d.tail(1).length, 0, 'skickade events lamnar queue');
});

test('payload-storlek har ett teckentak', () => {
  const d = mkdi({});
  const big = { job: 'x' };
  /* allowlistade strangar fylls — men noistra inte: storlek stoppar */
  for (let i = 0; i < 900; i++) big[`extra${i}`] = 'y'.repeat(50);
  const r = d.record('x', big);
  assert.equal(r.ok, true, 'okanda falt droppas sa payloaden hamnar inom tak');
  assert.ok(r.dropped.length > 850);
  const line = fs.readFileSync(d.file, 'utf8');
  assert.ok(line.length < 10000, 'filraden inom rimliggransar: ' + line.length);
});
