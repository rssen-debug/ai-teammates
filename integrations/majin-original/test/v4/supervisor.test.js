/**
 * Supervisor: restart-on-crash, health probing and giving up loudly.
 *
 * These tests use a real child process (a tiny HTTP server that can be told to
 * die) so the lifecycle is exercised, not simulated. Time is injected where the
 * backoff matters.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Supervisor } from '../../src/v4/supervisor.js';
import { tempHome } from './helpers.mjs';

const FIXTURE = `
import http from 'node:http';
const port = Number(process.argv[2]);
const dieAfter = Number(process.argv[3] || 0);
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});
server.listen(port, '127.0.0.1', () => { process.stdout.write('listening\\n'); });
if (dieAfter) setTimeout(() => process.exit(7), dieAfter);
`;

function writeFixture(dir) {
  const file = path.join(dir, 'host-fixture.mjs');
  fs.writeFileSync(file, FIXTURE);
  return file;
}

const freePort = () => 34000 + Math.floor(Math.random() * 2000);

function makeSup(dir, { port, dieAfter = 0, ...opts }) {
  const fixture = writeFixture(dir);
  return new Supervisor({
    command: [process.execPath, fixture, String(port), String(dieAfter)],
    healthUrl: `http://127.0.0.1:${port}/api/health`,
    logFile: path.join(dir, 'supervisor.jsonl'),
    backoffMs: 50,
    maxBackoffMs: 200,
    startupGraceMs: 4000,
    healthIntervalMs: 0,
    stopGraceMs: 1000,
    ...opts,
  });
}

test('supervisor: starts the host, reports healthy and stops cleanly', async () => {
  const dir = tempHome();
  const port = freePort();
  const sup = makeSup(dir, { port });
  try {
    await sup.start();
    assert.equal(sup.state, 'healthy', JSON.stringify(sup.status()));
    assert.ok(sup.child?.pid);
    assert.equal(await sup.probe(), true);

    await sup.stop();
    assert.equal(sup.state, 'stopped');
    assert.equal(sup.child, null);
    assert.equal(sup.stats.restarts, 0, 'a deliberate stop is not a restart');

    const log = fs.readFileSync(path.join(dir, 'supervisor.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(log.some((l) => l.event === 'healthy'));
    assert.ok(log.some((l) => l.event === 'stopped'));
    assert.ok(!log.some((l) => l.event === 'crashed'));
  } finally {
    await sup.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('supervisor: a crashed host is restarted and the crash is logged', async () => {
  const dir = tempHome();
  const port = freePort();
  const sup = makeSup(dir, { port, dieAfter: 600 });
  try {
    await sup.start();
    assert.equal(sup.state, 'healthy');
    // wait for the fixture to die and the supervisor to bring it back
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && sup.stats.crashes === 0) await new Promise((r) => setTimeout(r, 50));
    assert.equal(sup.stats.crashes, 1, 'the crash was noticed');

    await new Promise((r) => setTimeout(r, 1200));
    assert.ok(sup.stats.restarts >= 1, 'a restart was scheduled and ran');
    assert.ok(sup.stats.spawns >= 2, 'the process was spawned again');

    const log = fs.readFileSync(path.join(dir, 'supervisor.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(log.some((l) => l.event === 'crashed' && l.code === 7));
    assert.ok(log.some((l) => l.event === 'restart_scheduled'));
  } finally {
    sup.stopping = true;
    await sup.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('supervisor: a crash loop gives up loudly instead of spinning forever', async () => {
  const dir = tempHome();
  const port = freePort();
  const sup = makeSup(dir, { port, dieAfter: 120, maxRestarts: 2 });
  try {
    await sup.start();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && sup.state !== 'failed') await new Promise((r) => setTimeout(r, 100));
    assert.equal(sup.state, 'failed', JSON.stringify(sup.status()));
    assert.match(sup.lastError, /gave up/);
    assert.ok(sup.stats.restarts <= 2, `restarts capped, got ${sup.stats.restarts}`);
    const log = fs.readFileSync(path.join(dir, 'supervisor.jsonl'), 'utf8');
    assert.match(log, /gave_up/);
  } finally {
    sup.stopping = true;
    await sup.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('supervisor: a host that starts but never answers health is reported unhealthy', async () => {
  const dir = tempHome();
  const port = freePort();
  const sup = new Supervisor({
    command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
    healthUrl: `http://127.0.0.1:${port}/api/health`,
    logFile: path.join(dir, 'sup.jsonl'),
    startupGraceMs: 600,
    healthIntervalMs: 0,
  });
  try {
    await sup.start();
    assert.equal(sup.state, 'failed');
    assert.match(sup.lastError, /health/);
  } finally {
    sup.stopping = true;
    await sup.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('supervisor: three failed health probes trigger a restart', async () => {
  const dir = tempHome();
  let healthy = true;
  let probes = 0;
  const sup = new Supervisor({
    command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
    healthUrl: 'http://fake/api/health',
    logFile: path.join(dir, 'sup.jsonl'),
    startupGraceMs: 300,
    healthIntervalMs: 0,
    fetchImpl: async () => {
      probes += 1;
      if (!healthy) throw new Error('no route');
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  try {
    await sup.start();
    assert.equal(sup.state, 'healthy');
    healthy = false;
    assert.equal(sup.restart('health check failed repeatedly'), true);
    assert.ok(probes > 0);
  } finally {
    sup.stopping = true;
    await sup.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('supervisor: the restart window expires, so a host that stabilises is not punished', () => {
  const sup = new Supervisor({ command: ['x'], windowMs: 1000, maxRestarts: 2, backoffMs: 1, setTimeout: () => 0 });
  sup.restarts = [sup.now() - 5000, sup.now() - 4000];
  assert.equal(sup.restart('old failures'), true, 'old entries fall out of the window');
});

test('supervisor: health failure replaces the live process, rather than scheduling a no-op', async () => {
  const dir = tempHome();
  const sup = makeSup(dir, { port: freePort(), healthIntervalMs: 30, backoffMs: 10 });
  try {
    await sup.start();
    const oldPid = sup.child.pid;
    // Fail three probes, then let the replacement use the actual HTTP probe.
    const realProbe = sup.probe.bind(sup);
    let failures = 3;
    sup.probe = () => failures-- > 0 ? Promise.resolve(false) : realProbe();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (sup.child?.pid === oldPid || sup.state !== 'healthy')) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(sup.state, 'healthy');
    assert.notEqual(sup.child?.pid, oldPid);
    assert.equal(sup.stats.spawns, 2);
    assert.throws(() => process.kill(oldPid, 0), 'old process must have exited');
  } finally { await sup.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
