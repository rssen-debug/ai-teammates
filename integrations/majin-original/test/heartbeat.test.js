import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Heartbeat } from '../src/core/heartbeat.js';

const mkBus = () => {
  const subs = [];
  return {
    sub(fn) { subs.push(fn); return () => subs.splice(subs.indexOf(fn), 1 >>> 0); },
    on() { throw new Error('bus.on exact-only — heartbeat must use sub'); },
    emit(type, data = {}) { const ev = { type, ...data, ts: new Date().toISOString() }; subs.forEach((f) => f(ev)); },
    info() {},
  };
};
const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ws-'));

test('W9: silence when nothing real happened (default state, measurable)', async () => {
  const dir = ws();
  const hb = new Heartbeat({ workspaceDir: dir, bus: mkBus(), now: () => 1000 });
  const r = await hb.tick();
  assert.equal(r.sent, false);
  assert.match(r.reason, /silence|nothing/i);
  const log = fs.readFileSync(path.join(dir, 'heartbeats', 'log.jsonl'), 'utf8');
  assert.ok(log.includes('"tick":true'), 'ticks persist to disk even when silent');
});

test('W9: real event → tick delivers digest, pattern wildcard works on the bus.sub stream', async () => {
  const dir = ws();
  const bus = mkBus();
  const hb = new Heartbeat({ workspaceDir: dir, bus, now: () => 1000, minGapMs: 0 });
  hb.start();
  bus.emit('loop.turn_timeout', { message: 'turn 45s over cap' });
  bus.emit('approval:request', { message: 'opv-on-remote destroy tred.se' });
  const r = await hb.tick({ force: true });
  assert.equal(r.sent, true);
  assert.match(r.text, /loop\.turn_timeout/);
  assert.match(r.text, /approval:request/);
  assert.ok(r.text.length < 2000, 'digest stays bounded');
  assert.equal(r.delivery.channels, 'desktop-only', 'no configured channel must not pretend');
  assert.equal(hb.queue.length, 0);
  hb.stop();
});

test('W9: duplicate identical events within the gap collapse (no spam)', async () => {
  const dir = ws();
  const bus = mkBus();
  const hb = new Heartbeat({ workspaceDir: dir, bus, now: () => 1000, minGapMs: 300_000 });
  hb.start();
  const ev = { message: 'same warning' };
  bus.emit('exec.error', ev);
  bus.emit('exec.error', ev);
  bus.emit('exec.error', ev);
  assert.equal(hb.queue.length, 1, 'identical repeats within gap = one entry, not three');
  hb.stop();
});

test('W9: mandatory quiet between two "sent" alerts (rate limit is enforced)', async () => {
  const dir = ws();
  const hb = new Heartbeat({ workspaceDir: dir, bus: mkBus(), now: () => 1000, minGapMs: 300_000 });
  hb.ingest('loop.budget', { message: 'monthly 90% used' });
  const first = await hb.tick({ force: true });
  assert.equal(first.sent, true);
  hb.ingest('loop.budget', { message: 'still 90%' });
  const second = await hb.tick();
  assert.equal(second.sent, false);
  assert.match(second.reason, /rate-limited/);
});

test('W9: configured channel failure is reported honestly inside delivery results', async () => {
  const dir = ws();
  const cfg = {
    get: (k) => ({
      'heartbeat.channels': ['discord'],
      'channels.discord.token': 'T',
      'channels.discord.channelId': 'C',
    })[k],
  };
  const fetchFake = async () => ({ status: 429, ok: false, text: async () => '{"message":"You are being rate limited."}' });
  const hb = new Heartbeat({ workspaceDir: dir, bus: mkBus(), cfg, fetchFn: fetchFake, now: () => 1000, minGapMs: 0 });
  hb.ingest('loop.provider', { message: 'provider 500' });
  const r = await hb.tick({ force: true });
  assert.equal(r.delivery.channels, 'configured');
  assert.equal(r.delivery.results[0].ok, false);
  assert.match(String(r.delivery.results[0].error || ''), /rate limited/i, 'the channel error text must surface, never be swallowed');
});

test('W9: queue cap holds (bounded memory under event storms)', () => {
  const dir = ws();
  const hb = new Heartbeat({ workspaceDir: dir, bus: mkBus(), now: () => 1000, minGapMs: 0, cap: 10 });
  for (let i = 0; i < 40; i++) hb.ingest(`event.${i}`, { message: `n${i}` });
  assert.equal(hb.queue.length, 10);
});

test('W9: status reports persisted state + version, no self-declared health claims', async () => {
  const dir = ws();
  const hb = new Heartbeat({ workspaceDir: dir, bus: mkBus(), now: () => 1000 });
  hb.ingest('x.warn', { message: 'hi' });
  await hb.tick({ force: true });
  const st = hb.status();
  assert.ok(st.version.startsWith('majin-heartbeat/'));
  assert.ok(st.persisted.lastAt);
  assert.equal(typeof st.running, 'boolean');
});
