/* GODLIKE V4 §7 simulator — deterministic, offline, clock-real but windows-tiny.
   A simulation is NOT a live quota proof; it proves the LOGIC and the
   throughput/violation relationship under controlled bursts. Live quotas stay
   configured by the owner per provider; pass-through remains the default. */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MAJIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-rlr-'));

const rl = await import('../src/core/ratelimit.js');
const { complete } = await import('../src/core/provider/chat.js');

const WAIT = (ms) => new Promise((r) => setTimeout(r, ms));

function simRoute(name, quota) {
  return { ref: `sim/${name}`, providerName: 'sim', label: 'sim', model: name, kind: 'mock', baseUrl: '', apiKey: 'sim', extraHeaders: {}, pricing: null, quota, job: 'tasks' };
}
const quotaGet = (r) => r.quota;
const estTokens = () => 10;

test.beforeEach(() => rl._resetForTests());

test('S1 naive burst: without admission, a 6-wide burst VIOLATES a 2-per-window quota', async (t) => {
  rl._resetForTests();
  const route = simRoute('naive', null); // no quota → no admission (the naive track)
  /* simulate the SERVER-side rolling window measuring what a quota sees */
  const violations = [];
  const start = Date.now();
  for (let i = 0; i < 6; i++) {
    rl.record(route, { input: 10, output: 10 }, quotaGet); // every call reconciles 10+10
  }
  const lim = rl.limiterFor(route, quotaGet);
  const sum = lim.win.sum();
  assert.ok(sum.req > 2, `burst pushed ${sum.req} requests in-window — a real server would 429`);
  violations.push(sum.req);
  console.log(`S1: naive window req=${sum.req} vs quota rpm=2 → guaranteed 429 burst (${Date.now() - start}ms)`);
});

test('S2 admission: same quota, 6 calls through complete() → ZERO violations, all complete', async (t) => {
  rl._resetForTests();
  const quota = { rpm: 2, tpmIn: 200, tpmOut: 200, concurrent: 2, windowMs: 300 };
  const route = simRoute('limited', quota);
  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => complete({ route, messages: [{ role: 'user', content: 'ping ' + i }], maxTokens: 8 })));
  const wall = performance.now() - t0;
  assert.equal(results.length, 6, 'all six calls complete');
  const lim = rl.limiterFor(route, quotaGet);
  assert.equal(lim.stats.violations, 0, 'zero violations under admission');
  assert.equal(lim.stats.admitted, 6, 'admitted all six');
  assert.ok(lim.stats.queued >= 5, `most went through the queue (queued=${lim.stats.queued})`);
  const wsum = lim.win.sum();
  assert.ok(wsum.req <= 2, `window telemetry respects the quota at all times (now ${wsum.req})`);
  console.log(`S2: 6 calls, wall=${wall.toFixed(0)}ms, violations=${lim.stats.violations}, queue-waited=${lim.stats.waitedMs}ms`);
});

test('S3 Retry-After is a FLOOR: backoff = max(ra, exp+jitter)', async (t) => {
  assert.equal(rl.retryAfterMs({ headers: { 'retry-after': '2' } }), 2000);
  assert.equal(rl.retryAfterMs({ headers: { 'Retry-After': '0.4' } }), 400);
  assert.equal(rl.retryAfterMs({ retry_after: 1 }), 1000);
  assert.equal(rl.backoffFor({ raMs: 400, attempt: 1, jitter: 0 }), 800, 'exp(0.8s) beats 0.4s ra');
  assert.equal(rl.backoffFor({ raMs: 5000, attempt: 1, jitter: 0 }), 5000, 'a bigger ra wins — the floor is respected');
  assert.equal(rl.backoffFor({ raMs: 0, attempt: 3, jitter: 0 }), Math.min(15000, 3200), 'exp curve okay at attempt 3');
});

test('S4 queued cancellation: abort while queued → AbortError, quota state released', async (t) => {
  rl._resetForTests();
  const quota = { rpm: 1, windowMs: 500 };
  const route = simRoute('cancel', quota);
  rl._resetForTests(); rl.limiterFor(route, quotaGet); // seed the limiter WITH the quota
  const c = new AbortController();
  /* occupy the pipeline with TWO calls so the third definitely queues */
  const rel1 = await rl.admit({ route, quotaGet, estIn: 5, estOut: 5, job: 'tasks', signal: null });
  const p2 = rl.admit({ route, quotaGet, estIn: 5, estOut: 5, job: 'tasks', signal: null });
  const pending = rl.admit({ route, quotaGet, estIn: 5, estOut: 5, job: 'tasks', signal: c.signal });
  const observed = pending.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })); // handler attached BEFORE abort
  await WAIT(60);
  c.abort();
  const got = await observed;
  assert.equal(got.ok, false, 'queued caller aborted cleanly');
  assert.match(String(got.e), /canceled/, `AbortError text: ${got.e}`);
  const lim = rl.limiterFor(route, quotaGet);
  assert.equal(lim.inFlight, 1, 'only first reservation remains');
  rel1();
  const rel2 = await p2; // now admitted after capacity freed
  rel2();
});

test('S5 priority: interactive beats background in admission order', async (t) => {
  rl._resetForTests();
  const quota = { rpm: 1, tpmOut: 1000, tpmIn: 1000, concurrent: 1, windowMs: 350 };
  const route = simRoute('prio', quota);
  rl.limiterFor(route, quotaGet);
  /* first admission occupies the lane */
  const first = await rl.admit({ route, quotaGet, estIn: 5, estOut: 5, job: 'tasks', signal: null });
  first(); // frees the lane; queue order must now decide who goes first
  const order = [];
  const bg = rl.admit({ route, quotaGet, estIn: 5, estOut: 5, job: 'background', signal: null }).then((r) => { order.push('bg'); r(); /* release immediately — caller owns the reservation */ });
  const iv = rl.admit({ route, quotaGet, estIn: 5, estOut: 5, job: 'interactive', signal: null }).then((r) => { order.push('iv'); r(); });
  await Promise.all([bg, iv]);
  assert.equal(order[0], 'iv', `interactive admitted before background: ${order}`);
});

test('S6 AIMD: a 429 halves concurrency level; calm recovery adds back', async (t) => {
  rl._resetForTests();
  const quota = { concurrent: 8, windowMs: 300 };
  const route = simRoute('aimd', quota);
  const lim = rl.limiterFor(route, quotaGet);
  const before = lim.aimd.level;
  rl.noteViolation(route, quotaGet);
  assert.equal(lim.aimd.level, Math.floor(before / 2), 'multiplicative decrease');
  rl.noteViolation(route, quotaGet);
  assert.equal(lim.aimd.level, 2, 'second violation halves again (8→4→2)');
  lim.stats.violations = 0; lim.calm();
  assert.equal(lim.aimd.level, 3, 'additive increase when calm');
});

test('S7 classify: every error class lands in the right bucket with right stop-semantics', async (t) => {
  const cases = [
    [{ status: 429, message: 'rate limit exceeded' }, 'rate_limit', true],
    [{ message: 'insufficient quota: billing' }, 'budget', false],
    [{ status: 401, message: 'invalid api key' }, 'auth', false],
    [{ status: 404, message: 'unknown model' }, 'model', false],
    [{ message: 'maximum context length exceeded' }, 'context', false],
    [{ message: 'fetch failed ECONNREFUSED' }, 'network', true],
  ];
  for (const [err, cls, retryable] of cases) {
    const got = rl.classify(err);
    assert.equal(got.cls, cls, `classify(${JSON.stringify(err)}) = ${got.cls}, expected ${cls}`);
    assert.equal(got.retryable, retryable, `${cls} retryable=${retryable}`);
  }
});

test('S8 honest default: no quota configured → admission is instant pass-through (no invented limits)', async (t) => {
  rl._resetForTests();
  const route = simRoute('none', null);
  const t0 = performance.now();
  const rel = await rl.admit({ route, quotaGet, estIn: 100, estOut: 100, job: 'tasks', signal: null });
  rel();
  assert.ok(performance.now() - t0 < 50, 'pass-through is immediate');
});
