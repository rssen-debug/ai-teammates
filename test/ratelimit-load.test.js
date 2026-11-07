/* MAJIN — P5/P4 entry (UI-agent handover 2026-10-19: "mätstyrd parallellisering").
   Load-proof extensions to the S1–S8 simulator. These tests measure; they do
   not certify the handover's UNCERTIFIED target table. Numbers are reported as
   sandbox DATA (environment: Linux sandbox, node 20).
   S9:  20-wide burst under concurrent:2 — the slot cap is never exceeded
   S10: same-tick priority — interactive is admitted before tasks/background
   S11: reservations reconcile honestly; an aborted queue wait leaks nothing
   S12: admission overhead — pass-through vs configured-ample (median data) */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MAJIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-rll-'));

const rl = await import('../src/core/ratelimit.js');

const WAIT = (ms) => new Promise((r) => setTimeout(r, ms));
const route = (name, quota) => ({ ref: `sim/${name}`, providerName: 'simload', label: name, model: name, kind: 'mock', baseUrl: '', apiKey: 'sim', extraHeaders: {}, pricing: null, quota, job: 'tasks' });
const quotaGet = (r) => r.quota;
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * 0.95) - 1)];

test.beforeEach(() => rl._resetForTests());

test('S9: 20-wide burst under concurrent:2 — the slot cap is a hard ceiling (and time proves it)', async () => {
  const quota = { concurrent: 2, windowMs: 400 };
  const r = route('burst20', quota);
  let maxSeen = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: 20 }, async () => {
    const release = await rl.admit({ route: r, quotaGet, estIn: 5, estOut: 5, job: 'tasks' });
    const lim = rl.limiterFor(r, quotaGet);
    maxSeen = Math.max(maxSeen, lim.inFlight);
    await WAIT(120); // the "provider call"
    release();
  }));
  const wall = performance.now() - t0;
  const lim = rl.limiterFor(r, quotaGet);
  assert.ok(maxSeen <= 2, `concurrent cap exceeded: saw ${maxSeen} in flight`);
  assert.equal(lim.stats.admitted, 20, 'all twenty admitted eventually');
  assert.ok(wall >= 1000, `20 jobs × 120ms over 2 slots cannot be under ~1.2s if the gate is real (wall=${wall.toFixed(0)}ms)`);
  console.log(`S9 DATA: burst=20 concurrent=2 workMs=120 wall=${wall.toFixed(0)}ms maxInFlight=${maxSeen}`);
});

test('S10: same-tick arrivals — interactive jumps the queue ahead of tasks and background', async () => {
  const quota = { concurrent: 1, windowMs: 300 };
  const r = route('prio', quota);
  const order = [];
  const runs = [
    ['background', 'background'],
    ['tasks-A', 'tasks'],
    ['interactive', 'interactive'],
    ['tasks-B', 'tasks'],
  ].map(async ([tag, job]) => {
    const release = await rl.admit({ route: r, quotaGet, estIn: 1, estOut: 1, job });
    order.push(tag);
    rl.limiterFor(r, quotaGet); // keep shape explicit
    rl.record(r, { input: 1, output: 1 }, quotaGet); // actuals reconcile → window spends the rpm slot honestly
    await WAIT(90);
    release();
  });
  await Promise.all(runs);
  assert.equal(order[0], 'interactive', `interactive admitted first, got ${order.join('→')}`);
  assert.equal(order[order.length - 1], 'background', `background last, got ${order.join('→')}`);
  assert.deepEqual(order.slice(1, 3).sort(), ['tasks-A', 'tasks-B'], 'tasks FIFO in the middle');
  console.log(`S10 DATA: admission order ${order.join(' → ')}`);
});

test('S11: reservations are released on completion AND on abort — nothing leaks into the window', async () => {
  const quota = { concurrent: 1, rpm: 1000, windowMs: 300 };
  const r = route('recon', quota);
  const lim = rl.limiterFor(r, quotaGet);
  // 1) honest reservation lifecycle
  const rel1 = await rl.admit({ route: r, quotaGet, estIn: 100, estOut: 50, job: 'tasks' });
  assert.equal(lim.reqReserved, 1, 'reservation counted while in flight');
  assert.equal(lim.reservedIn, 100);
  rel1();
  assert.equal(lim.reqReserved, 0, 'release clears the request reservation');
  assert.equal(lim.reservedIn, 0, 'release clears the token reservation');
  rl.record(r, { input: 42, output: 8 }, quotaGet);
  assert.equal(lim.win.sum().in, 42, 'the window charges ACTUAL usage, not the estimate');
  assert.equal(lim.stats.reconciledTokens, 50, 'reconciled-token ledger honest');
  // 2) abort while queued: nothing counts, nothing leaks
  const holder = await rl.admit({ route: r, quotaGet, estIn: 1, estOut: 1, job: 'tasks' });
  const ctrl = new AbortController();
  const waiting = rl.admit({ route: r, quotaGet, estIn: 1, estOut: 1, job: 'background', signal: ctrl.signal });
  const before = { reserved: lim.reqReserved, inflight: lim.inFlight, in: lim.win.sum().in };
  setTimeout(() => ctrl.abort(), 60);
  await assert.rejects(waiting, (e) => e.name === 'AbortError', 'queued wait rejects as AbortError');
  assert.ok(lim.stats.canceledQueued >= 1, 'cancellation recorded');
  assert.equal(lim.reqReserved, before.reserved, 'aborted wait made no reservation');
  assert.equal(lim.win.sum().in, before.in, 'aborted wait charged nothing to the window');
  holder();
  assert.equal(lim.inFlight, 0, 'holder released — accounting back to zero');
});

test('S12: admission overhead — pass-through is instant, configured-ample stays cheap (sandbox data)', async () => {
  const rOpen = route('open', null);
  const rAmple = route('ample', { rpm: 1_000_000, concurrent: 1_000_000, windowMs: 1000 });
  const ms = [];
  for (let i = 0; i < 1000; i += 1) {
    const t = performance.now();
    (await rl.admit({ route: rOpen, quotaGet, estIn: 10, estOut: 10, job: 'tasks' }))();
    ms.push(performance.now() - t);
  }
  const msAmple = [];
  for (let i = 0; i < 200; i += 1) {
    const t = performance.now();
    (await rl.admit({ route: rAmple, quotaGet, estIn: 10, estOut: 10, job: 'tasks' }))();
    msAmple.push(performance.now() - t);
  }
  const data = { passThrough: { p50: +med(ms).toFixed(3), p95: +p95(ms).toFixed(3) }, configuredAmple: { p50: +med(msAmple).toFixed(3), p95: +p95(msAmple).toFixed(3), n: msAmple.length } };
  console.log('S12 DATA (Linux sandbox, node ' + process.version + '):', JSON.stringify(data));
  assert.ok(data.passThrough.p50 < 5, `pass-through should be essentially free (p50=${data.passThrough.p50}ms)`);
  assert.ok(data.configuredAmple.p50 < 20, `ample-quota admission should stay single-digit ms (p50=${data.configuredAmple.p50}ms)`);
});
