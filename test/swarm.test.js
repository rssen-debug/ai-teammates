/* MAJIN — HYPERSWARM fas 1: parallelism analys + DAG-schemaläggare.
   Fail-first: src/core/swarm.js finns inte än. Direktivets urvalstest:
   (a) tre oberoende arbeten → flera workers, (b) sekventiell kedja → en
   worker, (c) för små arbeten → en worker (overhead äter vinsten). Beslutet
   är deterministic kod — aldrig en LLM-fråga (GENESIS ZERO). */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MAJIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-swarm-'));

const { analyzeSwarm, runSwarm, subagentWorker, isTransientFailure } = await import('../src/core/swarm.js');
const { createRuntime } = await import('../src/core/runtime.js');
const { setScript } = await import('../src/core/provider/mock.js');

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test('analysator: tre oberoende arbeten → tre workers, kritiskt spår räknat först', () => {
  const a = analyzeSwarm([
    { id: 'a', deps: [], estMs: 60000 },
    { id: 'b', deps: [], estMs: 60000 },
    { id: 'c', deps: [], estMs: 60000 },
  ], { overheadMs: 1500 });
  assert.equal(a.decision, 'swarm', 'independent arbeten Fortjänar swarm');
  assert.equal(a.workers, 3);
  assert.equal(a.sequentialMs, 180000);
  assert.equal(a.criticalMs, 60000, 'kritiskt spår = 1×60s (alla oberoende)');
  /* deterministisk modell: makespan = ena nodens 60s + spawn-overhead per worker */
  assert.equal(a.parallelMs, 60000 + 3 * 1500, `makespan-modellen ar explicit, aldrig uppskattad i blindo: ${a.parallelMs}`);
  assert.ok(a.parallelMs >= a.criticalMs, 'parallell makespan underst kritiskt spar');
  assert.ok(a.parallelMs <= a.sequentialMs - 100000, `vinsten maste vara massiv: ${a.parallelMs}`);
  assert.equal(typeof a.reason, 'string');
});

test('analysator: ren kedja → en worker (parallelism lösar inget)', () => {
  const a = analyzeSwarm([
    { id: 'a', deps: [], estMs: 60000 },
    { id: 'b', deps: ['a'], estMs: 60000 },
    { id: 'c', deps: ['b'], estMs: 60000 },
  ], { overheadMs: 1500 });
  assert.equal(a.decision, 'single', `kritisk väg = hela arbetet: ${a.reason}`);
  assert.equal(a.workers, 1);
});

test('analysator: små arbeten + overhead → en worker (vinsten äts upp ärligt)', () => {
  const a = analyzeSwarm(
    Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, deps: [], estMs: 200 })),
    { overheadMs: 1500 },
  );
  assert.equal(a.decision, 'single');
  assert.match(a.reason, /overhead|not worth|spawning/i, `skälet ska ärligt nämna overheden: ${a.reason}`);
});

test('analysator: okänd tid skattas försiktigt, aldrig fantiserat', () => {
  const a = analyzeSwarm([
    { id: 'a', deps: [] },
    { id: 'b', deps: ['a'] },
  ], { overheadMs: 1500 });
  assert.equal(a.decision, 'single', 'två steg med okänd tid ska inte spawna i blindo');
  assert.match(a.reason, /unknown|conservative/i, a.reason);
});

test('schemaläggare: tre oberoende noder verkligen överlappar — mätbar väggtid', async () => {
  const startedAt = {}, endedAt = {};
  const mk = (id) => async () => {
    startedAt[id] = performance.now();
    await settle(120);
    endedAt[id] = performance.now();
    return { done: id };
  };
  const t0 = performance.now();
  const r = await runSwarm({
    nodes: [
      { id: 'a', deps: [], run: mk('a') },
      { id: 'b', deps: [], run: mk('b') },
      { id: 'c', deps: [], run: mk('c') },
    ],
    cap: 3,
  });
  const wall = performance.now() - t0;
  assert.equal(r.okCount, 3);
  assert.ok(wall < 120 * 2.2, `parallellt ska brinna typ en nodtid, inte tre: vägg ${wall.toFixed(0)}ms`);
  /* överlapp-bevis: minst två noder höll på samtidigt, annars var det köttfärs i rock */
  const overlaps = ['a', 'b', 'c'].filter((x) => ['a', 'b', 'c'].some((y) => y !== x && startedAt[y] < endedAt[x] && startedAt[x] < endedAt[y]));
  assert.ok(overlaps.length >= 2, 'äkta överlapp krävs (inte bara snabb kö)');
});

test('schemaläggare: beroenden respekteras, aldrig utförda före sina uppdrag', async () => {
  const order = [];
  const mk = (id) => async () => { order.push(id); await settle(10); };
  const r = await runSwarm({
    nodes: [
      { id: 'a', deps: [], run: mk('a') },
      { id: 'b', deps: ['a'], run: mk('b') },
      { id: 'c', deps: ['b'], run: mk('c') },
      { id: 'd', deps: ['a'], run: mk('d') },
    ],
    cap: 4,
  });
  assert.equal(r.okCount, 4);
  assert.ok(order.indexOf('a') < order.indexOf('b'), 'b efter a');
  assert.ok(order.indexOf('b') < order.indexOf('c'), 'c efter b');
  assert.ok(order.indexOf('a') < order.indexOf('d'), 'd efter a');
});

test('schemaläggare: ett misslyckande stoppar inte oberoende grenar', async () => {
  const r = await runSwarm({
    nodes: [
      { id: 'a', deps: [], run: async () => { throw new Error('explody'); } },
      { id: 'b', deps: [], run: async () => ({ value: 'ok-b' }) },
      { id: 'c', deps: ['a'], run: async () => ({ value: 'never' }) },
      { id: 'd', deps: ['b'], run: async () => ({ value: 'ok-d' }) },
    ],
    cap: 2,
  });
  assert.equal(r.okCount, 2, 'b och d ska landa trots att a sprak');
  assert.equal(r.results.get('c').ok, undefined, 'c kördes aldrig — blockad sak är ärligt rapporterad');
  assert.equal(r.results.get('a').ok, false);
  assert.equal(r.results.get('c').blocked, true);
});

test('subagentWorker kör verkliga subagent-turner parallellt (mock-route, inga fablen)', async () => {
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'demo', routes: { tasks: 'demo/demo-fast', chat: 'demo/demo-fast' } },
    guard: { mode: 'off' },
    moa: { policy: 'off' },
  }, { persist: false });
  /* mock nycklar pa `${label}:${job}` — subagent-loopen labelar 'sub'.
     Tre identiska steg for att alla tre workers ska fa samma forsta-svar. */
  setScript('sub:tasks', [1, 2, 3].map(() => ({ text: 'svar från sub-workern' })));
  const worker = subagentWorker({ cfg: rt.cfg, registry: rt.registry, sessionPrefix: 'swarm-test' });
  const t0 = performance.now();
  const r = await runSwarm({
    nodes: [
      { id: 'r1', deps: [], input: 'research topic one', run: worker },
      { id: 'r2', deps: [], input: 'research topic two', run: worker },
      { id: 'r3', deps: [], input: 'research topic three', run: worker },
    ],
    cap: 3,
  });
  const wall = performance.now() - t0;
  assert.equal(r.okCount, 3, JSON.stringify([...r.results.entries()]).slice(0, 300));
  for (const [id, res] of r.results) {
    assert.ok(res.ok, `${id}: ok`);
    assert.match(res.value?.text || '', /svar från sub-workern/, `${id}: äkta sub-svar`);
  }
  assert.ok(wall < 4000, `tre parallella mock-turner ska vara snabba: ${wall.toFixed(0)}ms`);
  await rt.shutdown();
});

/* REGRESSION 2026-10-18 (GRAND ARCHITECT-skivan):
   Bugg 1 — multi-niva-blockerade beroenden vantade FOR EVIGT i 5ms-loopen:
   a failar => c(a) blockerades men d(c=>...) hittade ingen failad dep. */
test('REGRESSION: blockerade noder bubblar genom hela kedjan, inget vantar for evigt', async () => {
  const t0 = performance.now();
  const r = await runSwarm({
    nodes: [
      { id: 'a', deps: [], run: async () => { throw new Error('plan kan inte djuparel'); } },
      { id: 'c', deps: ['a'], run: async () => ({ never: 'skriv aldrig av alla koppar' }) },
      { id: 'd', deps: ['c'], run: async () => ({ never: 'djupast var' }) },
      { id: 'e', deps: ['d'], run: async () => ({ never: 'ytterst' }) },
    ],
    cap: 2,
  });
  const wall = performance.now() - t0;
  assert.ok(wall < 2000, `kedjan ska dö direkt, inte vänta: vägg ${wall.toFixed(0)}ms`);
  assert.equal(r.results.get('a').ok, false);
  for (const id of ['c', 'd', 'e']) {
    assert.equal(r.results.get(id).blocked, true, `${id}: blockerad även indirekt`);
    assert.match(r.results.get(id).reason || '', /dependency|failed/i, `${id}: ärlig orsak`);
  }
  assert.equal(r.blockedCount, 3);
  assert.equal(r.okCount, 0);
});

/* REGRESSION: batch-wait ersatt av work-conserving schemalaggare.
   Med cap 2: fast(60ms) + slow(900ms) + c(deps:fast) — c ska starta nar fast
   ar klar (work conserving), inte nar slow batchen gruvar sig. */
test('REGRESSION: ledig kapacitet tilldelas omedelbart nagot körbart — aldrig tom väntan', async () => {
  const times = {};
  const rec = (k) => () => { times[k] = performance.now(); };
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  await runSwarm({
    nodes: [
      { id: 'fast', deps: [], run: async () => { await settle(60); rec('fast-end')(); } },
      { id: 'slow', deps: [], run: async () => { await settle(900); rec('slow-end')(); } },
      { id: 'c', deps: ['fast'], run: async () => { rec('c-start')(); await settle(30); } },
    ],
    cap: 2,
  });
  const gap = times['c-start'] - times['fast-end'];
  assert.ok(times['c-start'] != null, 'c kordes');
  assert.ok(gap < 250, `c startade ${gap.toFixed(0)}ms efter fast — work-conserving maste ligga nara noll (batchv:e skulle ge ~840+)`);
  assert.ok(times['slow-end'] > times['fast-end'] + 400, 'slow sprang oavbruet parallellt');
});

/* ---------------- Del 3C: failure, cancellation and recovery ---------------- */

test('recover: a TRANSIENT flake is retried as a safe replacement and still succeeds (bounded)', async () => {
  let calls = 0;
  const events = [];
  const flaky = async (node) => {
    calls += 1;
    if (calls === 1) throw new Error('fetch failed: ECONNRESET');
    return { recovered: true, attempt: node.attempt };
  };
  const r = await runSwarm({
    nodes: [
      { id: 'a', deps: [], run: flaky },
      { id: 'b', deps: ['a'], run: async () => ({ done: 'b' }) },
    ],
    cap: 2,
    maxAttempts: 2,
    onEvent: (e) => events.push(e),
  });
  assert.equal(calls, 2, 'exactly one replacement attempt — never a loop');
  assert.equal(r.okCount, 2, 'a flaky start must not poison the dep chain');
  assert.equal(r.failCount, 0);
  const aRes = r.results.get('a');
  assert.equal(aRes.ok, true);
  assert.equal(aRes.value.attempt, 2, 'the replacement attempt produced the result');
  const retry = events.find((e) => e.type === 'worker_retry');
  assert.ok(retry, 'worker_retry event required for observability');
  assert.equal(retry.attempt, 2);
  assert.match(String(retry.why), /ECONNRESET/i);
});

test('recover: a PERMANENT failure is never retried — it stays failed exactly once', async () => {
  let calls = 0;
  const events = [];
  const refused = async () => {
    calls += 1;
    throw new Error('model refused: safety policy');
  };
  const r = await runSwarm({
    nodes: [
      { id: 'a', deps: [], run: refused },
      { id: 'b', deps: ['a'], run: async () => ({ done: 'b' }) },
    ],
    cap: 2,
    maxAttempts: 3, /* generous cap — a permanent error must not consume it */
    onEvent: (e) => events.push(e),
  });
  assert.equal(calls, 1, `permanent failure ran ${calls} times — a blind retry would duplicate side effects`);
  assert.equal(r.failCount, 1);
  assert.equal(events.some((e) => e.type === 'worker_retry'), false, 'no worker_retry for non-transient errors');
  const b = r.results.get('b');
  assert.equal(b.blocked, true, 'dependent is honestly blocked, never executed');
  assert.match(String(b.reason), /dependency a failed/i);
  /* classifier unit-pins: network/rate shapes transient, semantic failures permanent */
  for (const m of ['fetch failed: ECONNRESET', 'HTTP 429 rate_limit', 'HTTP 503 upstream', 'socket hang up', 'request ETIMEDOUT']) {
    assert.ok(isTransientFailure(m), `should be transient: ${m}`);
  }
  for (const m of ['model refused: safety policy', 'JSON.parse error', 'verification failed', 'invalid args', 'exited with status 1']) {
    assert.ok(!isTransientFailure(m), `must stay permanent: ${m}`);
  }
});

test('recover: mid-run CANCEL stops pending work honestly — nothing new starts after the signal', async () => {
  const controller = new AbortController();
  const started = [];
  const slow = (id) => async () => {
    started.push(id);
    await settle(300);
    return { done: id };
  };
  const t0 = performance.now();
  const promise = runSwarm({
    nodes: [
      { id: 'a', deps: [], run: slow('a') },
      { id: 'b', deps: [], run: slow('b') },
      { id: 'c', deps: ['b'], run: slow('c') },
    ],
    cap: 1,
    signal: controller.signal,
  });
  await settle(60);
  controller.abort();
  const r = await promise;
  const wall = performance.now() - t0;
  assert.deepEqual(started, ['a'], `no worker may start after a cancel, started=${started.join(',')},`);
  assert.ok(wall < 900, `cancel must not wait for the full queue (~900ms): ${wall.toFixed(0)}ms`);
  for (const id of ['a', 'b', 'c']) {
    const res = r.results.get(id);
    assert.equal(res.blocked, true, `${id} must end blocked, never ok`);
    assert.match(String(res.reason), /cancelled/i, `${id} must say cancelled, not timed-out or failed`);
  }
  assert.equal(r.okCount + r.failCount, 0, 'a cancelled queue produces zero ok and zero fail — honest blocked');
});

/* ---------------- Del 3D: parallel work cannot corrupt shared resources ---------------- */

test('ownership: the per-path file lock serializes owners deterministically (FIFO, no re-entrant deadlock)', async () => {
  const { fileLocks } = await import('../src/core/tasks.js');
  const p = '/tmp/majin-3d-lock-' + Math.random().toString(36).slice(2, 8);
  const order = [];
  const tA0 = Date.now();
  const releaseA = await fileLocks.acquire(p, 'workerA');
  let aEnd = 0;
  const holding = (async () => { await settle(80); order.push('A-out'); aEnd = Date.now(); releaseA(); })();
  const b0 = Date.now();
  const releaseB = await fileLocks.acquire(p, 'workerB');
  const bQueuedMs = Date.now() - b0;
  assert.ok(bQueuedMs >= 60, `workerB entered while workerA held the lock (+${bQueuedMs}ms queue)`);
  assert.ok(Date.now() >= aEnd, 'B entered only after A released');
  releaseB();
  order.push('B-out');
  await holding;
  assert.deepEqual(order, ['A-out', 'B-out'], 'FIFO order: A releases, then B proceeds');
  /* owner re-entry: the SAME session may re-acquire its own file without parking forever */
  const r1 = await fileLocks.acquire(p, 'ownerSelf');
  const r2 = await fileLocks.acquire(p, 'ownerSelf');
  r1(); r2();
  assert.ok(fileLocks.heldBy('ownerSelf').length === 0, 'heldBy must be empty after full release');
});

test('adversarial: racing fs.patch edits on one file never lose an update and never tear a line', async (t) => {
  const rt = await createRuntime({ channels: false, scheduler: false });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-3d-ws-'));
  rt.cfg.patch({
    models: { provider: 'demo', routes: { tasks: 'demo/demo-fast', tools: 'demo/demo-fast', chat: 'demo/demo-fast' } },
    providers: { demo: { kind: 'mock', apiKey: 'demo' } },
    guard: { mode: 'off' }, workspace: ws,
  }, { persist: false });
  assert.ok(rt.registry.list().some((x) => x.name === 'fs.patch'), 'fs.patch must be registered');
  fs.writeFileSync(path.join(ws, 'shared.txt'), 'BASE-one\nBASE-two\n');
  /* two hostile workers: interleaved rounds, distinct edits each, disjoint targets.
     Without the lock their read-modify-write interleaves and one update is lost. */
  const worker = async (who, session) => {
    for (let i = 0; i < 5; i++) {
      const marker = `${who}:line${i}`;
      const anchor = i % 2 ? 'BASE-two' : 'BASE-one';
      const out = await rt.registry.exec('fs.patch', { path: 'shared.txt', edits: [{ find: anchor, replace: `${anchor}\n${marker}` }] }, { session });
      if (out.error) throw new Error('fs.patch failed: ' + JSON.stringify(out.error).slice(0, 160));
    }
  };
  await Promise.all([worker('wA', 'workerA'), worker('wB', 'workerB')]);
  const final = fs.readFileSync(path.join(ws, 'shared.txt'), 'utf8');
  for (let i = 0; i < 5; i++) {
    assert.ok(final.includes(`wA:line${i}`), `wA update ${i} lost — lock violation`);
    assert.ok(final.includes(`wB:line${i}`), `wB update ${i} lost — lock violation`);
  }
  for (const line of final.split('\n').filter(Boolean)) {
    assert.match(line, /^(BASE-(one|two)|w[AB]:line\d)$/, `torn line = interleaved bytes: ${JSON.stringify(line)}`);
  }
  await rt.shutdown();
});
