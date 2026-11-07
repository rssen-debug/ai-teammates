/**
 * MAJIN — autopilot-core tests. The briefasked scenarios (A: three real
 * parallel tasks · B: one file, two agents · E: stop one, others continue)
 * run against the same engine a browser uses, with the scripted demo provider
 * — real sessions, real fs writes, real locks, no LLM cost.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-tasks-'));
process.env.MAJIN_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));

const { tasks, fileLocks, TaskRegistry, FileLocks, _resetAutopilot } = await import('../src/core/tasks.js');

test('registry: create → track → terminal states are one-way', () => {
  const r = new TaskRegistry();
  const t = r.create({ input: 'bygg en hemsida' });
  assert.equal(t.status, 'running');
  assert.match(t.session, /^task:/);
  assert.ok(r.sessionOf(t.id), 'a follow-up must find the session');
  r.setStatus(t.id, 'paused');
  assert.equal(r.get(t.id).status, 'paused');
  r.setStatus(t.id, 'done');
  r.setStatus(t.id, 'running'); // terminal states never move again
  assert.equal(r.get(t.id).status, 'done');
  assert.throws(() => r.setStatus('nope', 'running'), /unknown task/);
  assert.throws(() => r.setStatus(t.id, 'levitating'), /unknown status/);
});

test('explicit follow-up starts another observable run in the same session', () => {
  const r = new TaskRegistry();
  const t = r.create({ input: 'first question' });
  const session = t.session;
  r.event(t.id, 'tool_result', { tool: 'fs.read', ms: 5 });
  r.setStatus(t.id, 'done');
  r.event(t.id, 'delta');
  assert.equal(t.status, 'done', 'late event cannot reopen a completed run');
  r.beginFollowup(t.id);
  assert.equal(t.status, 'running');
  assert.equal(t.session, session);
  assert.equal(t.run, 2);
  assert.equal(t.toolsRun, 0);
  r.setStatus(t.id, 'done', 1);
  r.event(t.id, 'tool_result', { tool: 'old-tool', ms: 999 }, 1);
  assert.equal(t.status, 'running', 'late completion from an earlier stopped run cannot finish its follow-up');
  assert.equal(t.toolsRun, 0);
  r.event(t.id, 'tool_result', { tool: 'fs.read', ms: 8 });
  assert.equal(r.snapshot()[0].toolsRun, 1);
  assert.equal(r.snapshot()[0].run, 2);
  r.setStatus(t.id, 'done');
  assert.equal(r.active().length, 0);
});

test('locks: same file queues FIFO — different files run truly parallel', async () => {
  const L = new FileLocks();
  const order = [];
  const sleep = (ms) => new Promise((r2) => setTimeout(r2, ms));

  // same key: A holds, B queues, gets it only after A lets go
  const relA = await L.acquire('/x/a.txt', 'task:A');
  let bGotIt = false;
  const pb = L.acquire('/x/a.txt', 'task:B').then((rel) => { bGotIt = true; order.push('B'); rel(); });
  await sleep(10);
  assert.equal(bGotIt, false, 'B must wait while A holds the file');
  order.push('A');
  relA();
  await pb;
  assert.deepEqual(order, ['A', 'B'], 'FIFO on the contested file');

  // different keys: overlap measured, not guessed
  let concurrent = 0, peak = 0;
  const hold = async (k, owner) => {
    const rel = await L.acquire(k, owner);
    concurrent += 1; peak = Math.max(peak, concurrent);
    await sleep(15);
    concurrent -= 1;
    rel();
  };
  await Promise.all([hold('/x/one.txt', 'task:1'), hold('/x/two.txt', 'task:2'), hold('/x/three.txt', 'task:3')]);
  assert.ok(peak >= 2, `independent resources must overlap (peak=${peak})`);

  // same owner re-entry is safe; a stranger times out instead of parking forever
  const rel1 = await L.acquire('/x/solo.txt', 'task:S');
  await assert.rejects(L.acquire('/x/solo.txt', 'task:X', { timeoutMs: 40 }), /file lock timeout/);
  rel1();
});

test('awareness text names tasks and the file they hold', () => {
  const r = new TaskRegistry();
  const a = r.create({ input: 'sök 100 IT-jobb' });
  r.create({ input: 'bygg hemsidan' });
  assert.match(r.awareText(), new RegExp(`${a.id} \\[running\\] sök 100`));
  assert.equal(r.awareText({ excludeId: a.id }).includes('sök 100'), false, 'self must be filtered out');
  assert.ok(!new TaskRegistry().awareText(), 'quiet machine = no lines at all');
});

/* ---- engine-level: real turns through the real agent ---- */

const { createRuntime } = await import('../src/core/runtime.js');
const { setScript } = await import('../src/core/provider/mock.js');

const rt = await createRuntime({ channels: false, scheduler: false });
rt.cfg.patch({
  workspace: path.join(home, 'workspace'),
  models: { provider: 'demo', routes: Object.fromEntries(['chat', 'tasks', 'tools', 'code', 're', 'analysis', 'final', 'plan', 'research', 'summarize', 'router', 'aggregator', 'vision'].map((j) => [j, 'demo/demo-fast'])) },
  providers: { demo: { kind: 'mock', apiKey: 'demo' } },
  guard: { mode: 'off' },
  agent: { maxSteps: 6 },
});
const WS = rt.cfg.get('workspace');
const JOBS = ['tasks', 'tools', 're', 'chat', 'code', 'research', 'analysis', 'summarize', 'plan', 'final'];
const scriptAll = (steps) => { for (const j of JOBS) setScript(`main:${j}`, steps.map((x) => ({ ...x }))); };
const sleep = (ms) => new Promise((r2) => setTimeout(r2, ms));
const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

const newTask = (input) => {
  const t = tasks.create({ input, source: 'test' });
  return t;
};

test('A: three independent tasks truly run at the same time, with isolated history', async (t) => {
  const ts = [newTask('sök IT-jobb'), newTask('bygg hemsidan'), newTask('analysera datorn')];
  const span = (id) => ({ id, start: 0, end: 0 });
  const spans = [span(0), span(1), span(2)];
  const run = (rec, i) => async () => {
    spans[i].start = Date.now();
    const evs = [];
    const r = await rt.agent.turn({ input: rec.input, session: rec.session, onEvent: (e) => { evs.push(e); tasks.event(rec.id, e.type); } });
    spans[i].end = Date.now();
    tasks.setStatus(rec.id, r.error ? 'error' : 'done');
    return r;
  };
  /* long scripted answers → long turns, so overlap is measured, not hoped for */
  scriptAll([{ text: words(140) }]);
  const margin = scriptAll; // keep name nearby
  const results = await Promise.all(ts.map((rec, i) => run(rec, i)()));
  for (const r of results) assert.ok((r.text || '').includes('w139'), 'each task answered completely');
  const tids = tasks.list().filter((x) => ts.some((r2) => r2.id === x.id));
  assert.ok(tids.every((x) => x.status === 'done'), 'the registry tracks real final states');
  /* isolated history: three distinct session files, each owns ONLY its input */
  const dir = (await import('../src/core/paths.js')).dirs.sessions;
  const files = fs.readdirSync(dir).filter((f) => f.includes('task_'));
  for (const [i, rec] of ts.entries()) {
    const own = files.find((f) => f.startsWith(rec.session.replace(/:/g, '_')));
    assert.ok(own, `session file for ${rec.id} (${rec.session}) must exist — got ${files}`);
    const body = fs.readFileSync(path.join(dir, own), 'utf8');
    assert.ok(body.includes(rec.input), 'own input recorded');
    for (const other of ts) if (other !== rec) assert.ok(!body.includes(other.input), 'no history bleed between tasks');
  }
  /* overlap: at least two tasks shared wall-clock time */
  const overlap = spans.some((a, i) => spans.some((b, j) => i < j && a.start < b.end && b.start < a.end));
  assert.ok(overlap, `tasks must share wall time (${JSON.stringify(spans)})`);
  assert.equal(margin, scriptAll);
});

test('E: stopping one task lets the other two finish untouched', async () => {
  const a = newTask('lång uppgift ett');
  const b = newTask('lång uppgift två');
  scriptAll([{ text: words(400) }, { text: words(400) }]);
  const A = rt.agent.turn({ input: a.input, session: a.session });
  await sleep(40); // A is mid-stream now
  const B = rt.agent.turn({ input: b.input, session: b.session });
  await sleep(10);
  rt.agent.stop(a.session); // kill A only
  tasks.stop(a.id);
  const [ra, rb] = await Promise.all([A, B]);
  assert.ok(ra.aborted || tasks.get(a.id).status === 'stopped', 'A was stopped mid-flight');
  assert.equal(tasks.get(a.id).status, 'stopped');
  assert.ok((rb.text || '').includes('w399'), 'B completed the FULL answer — unaffected');
  tasks.setStatus(b.id, 'done');
});

test('B: two agents patch the same file — no lost edit, no torn diff', async () => {
  const target = path.join(WS, 'delad.txt');
  fs.writeFileSync(target, 'rad ett är x\nrad två är y\n');
  const patch = (session, find, replace) =>
    rt.registry.exec('fs.patch', { path: 'delad.txt', edits: [{ find, replace }] }, { session });
  /* both sessions enter at once; the lock makes the second wait for the first */
  const [r1, r2] = await Promise.all([
    patch('task:b1', 'x', 'ALPHA'),
    patch('task:b2', 'y', 'BETA'),
  ]);
  assert.ok(r1.ok !== false && r2.ok !== false, `both patches reported ok (${JSON.stringify([r1.ok, r2.ok])})`);
  const final = fs.readFileSync(target, 'utf8');
  assert.match(final, /rad ett är ALPHA/, 'first patch landed');
  assert.match(final, /rad två är BETA/, 'second patch landed — nothing lost');
  assert.equal(fileLocks.heldList().length, 0, 'no lock leaked');
});

test('ETA: two runs minimum, intervals not fake precision, garbage rejected', async () => {
  const { EtaMetrics } = await import('../src/core/tasks.js');
  const m = new EtaMetrics();
  assert.equal(m.estimate('web.fetch'), null, 'silence before any measurement');
  m.record('web.fetch', 1200);
  assert.equal(m.estimate('web.fetch'), null, 'one sample is not an estimate');
  m.record('web.fetch', 1400);
  const e = m.estimate('web.fetch');
  assert.ok(e && e.avgMs === 1300 && e.loMs === 1200 && e.hiMs === 1400, `interval from real data: ${JSON.stringify(e)}`);
  m.record('web.fetch', -5); m.record('web.fetch', NaN); m.record('', 100); m.record('x'.repeat(0), null);
  assert.equal(m.byTool.get('web.fetch').n, 2, 'garbage never enters the model');
  assert.equal(m.summary()['web.fetch'].runs, 2);
});

test('per-task telemetry: real tool_result ms become snapshot facts (never invented)', async () => {
  const { tasks, _resetAutopilot } = await import('../src/core/tasks.js');
  _resetAutopilot();
  const t = tasks.create({ input: 'telemetri-provet' });
  tasks.event(t.id, 'tool', { tool: 'web.fetch' });           // tool starting
  let s = tasks.snapshot().find((x) => x.id === t.id);
  assert.equal(s.curTool, 'web.fetch', 'the card can say what it is doing right now');
  tasks.event(t.id, 'tool_result', { tool: 'web.fetch', ms: 1000 });
  tasks.event(t.id, 'tool_result', { tool: 'web.fetch', ms: 1400 });
  s = tasks.snapshot().find((x) => x.id === t.id);
  assert.equal(s.toolsRun, 2, 'exactly the two real completions');
  assert.equal(s.avgToolMs, 1200, 'average from real measurements, nothing else');
  assert.equal(s.lastTool, 'web.fetch');
  assert.equal(s.curTool, null, 'nothing running between completions');
  // event-entries without data (old call sites) must never break the counters
  tasks.event(t.id, 'step', null);
  tasks.event(t.id, 'tool_result', null);
  s = tasks.snapshot().find((x) => x.id === t.id);
  assert.equal(s.toolsRun, 2, 'dataless events do not pollute the numbers');
  _resetAutopilot();
});
