/* MAJIN — P1 (UI-agent handover 2026-10-19, deliver-in-order #2: durable
   journal / context / resume — engine side).
   R1: a plan persists to disk and a FRESH process hydrates it into the brief
   R2: a model/provider switch on a session writes a durable handoff and the
       new model gets goal+route+plan in the SAME turn (durable: artifact on
       disk, consumed exactly once)
   R3: the handoff is not re-injected on later turns (consume-once guard)
   R4: a pre-crash artifact written by an earlier process is picked up by a
       fresh runtime — restart-resume, not just same-process
   R5: a failed plan persist is honestly reported and never kills the turn
   R6: handoff() atomic write reports persisted:true on a healthy disk */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MAJIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-p1-'));

const { createRuntime } = await import('../src/core/runtime.js');
const { resetCalls, lastCalls } = await import('../src/core/provider/mock.js');
const { dirs } = await import('../src/core/paths.js');

const canEnforcePermissions = process.platform !== 'win32' && !(process.getuid && process.getuid() === 0);

const TWO_PROVIDERS = {
  providers: {
    alpha: { kind: 'mock', apiKey: 'a' },
    bravo: { kind: 'mock', apiKey: 'b' },
  },
  models: { routes: { tasks: 'alpha/f1', chat: 'alpha/f1', tools: 'alpha/f1', analysis: 'alpha/f1', final: 'alpha/f1' } },
  guard: { mode: 'off' },
  moa: { policy: 'off' },
};

const mkRuntime = () => createRuntime({ channels: false, scheduler: false });
const sysOf = (call) => String(call?.messages?.find((m) => m.role === 'system')?.content || '');
const lastCall = () => lastCalls().slice(-1)[0];

test('R1: plan hydrates from disk into a FRESH agent — restart does not lose the mission', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-r1-'));
  const rt = await mkRuntime();
  rt.cfg.patch({ ...TWO_PROVIDERS, workspace: dir }, { persist: false });
  rt.agent.setPlan('sess-r1', [
    { text: 'collect vendor quotes', status: 'done' },
    { text: 'draft comparison sheet', status: 'doing' },
  ]);
  await rt.shutdown();

  const rt2 = await mkRuntime(); // fresh map, fresh "process" state — same MAJIN_HOME
  rt2.cfg.patch({ ...TWO_PROVIDERS, workspace: dir }, { persist: false });
  assert.equal(rt2.agent.plans.has('sess-r1'), false, 'new runtime really starts with an empty memory map');
  resetCalls();
  const r = await rt2.agent.turn({ input: 'hello, continue', session: 'sess-r1' });
  assert.ok(r.text, 'turn answers');
  const sys = sysOf(lastCall());
  assert.match(sys, /ACTIVE PLAN:/, 'plan is back in the brief');
  assert.match(sys, /\[x\] collect vendor quotes/);
  assert.match(sys, /\[~\] draft comparison sheet/);
  await rt2.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('R2: per-chat model switch writes a durable handoff and injects it — same turn, same chat', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-r2-'));
  const rt = await mkRuntime();
  rt.cfg.patch({ ...TWO_PROVIDERS, workspace: dir }, { persist: false });
  const sess = 'sess-r2';
  resetCalls();
  const r1 = await rt.agent.turn({ input: 'prepare the quarterly hiring summary', session: sess });
  assert.ok(r1.text);
  assert.equal(rt.agent.lastServedRoute(sess), 'alpha/f1', 'served route tracked durably');
  const routeFile = rt.agent.servedRoutePath(sess);
  assert.ok(routeFile && fs.existsSync(routeFile), 'served route journal exists on disk');
  rt.agent.setPlan(sess, [{ text: 'gather feedback packets', status: 'doing' }]);

  // the picker binds THIS chat to bravo (per-chat binding from P0)
  rt.cfg.patch({ models: { sessionRoutes: { [sess]: { tasks: 'bravo/f1', chat: 'bravo/f1', tools: 'bravo/f1', analysis: 'bravo/f1', final: 'bravo/f1' } } } }, { persist: false });
  const events = [];
  const r2 = await rt.agent.turn({ input: 'where were we?', session: sess, onEvent: (e) => events.push(e) });
  assert.ok(r2.text);
  const sys = sysOf(lastCall());
  assert.match(sys, /HANDOFF CONTEXT \(from a previous model\/agent — continue, do NOT restart\):/);
  assert.match(sys, /GOAL: .*prepare the quarterly hiring summary/);
  assert.match(sys, /ROUTE: alpha\/f1 → bravo\/f1/);
  assert.match(sys, /\[~\] gather feedback packets/, 'the live plan rides along');
  assert.ok(events.some((e) => e.type === 'handoff' && e.persisted), 'handoff event reports durable write');
  const hoFile = rt.agent.handoffPath(sess);
  const hoDisk = JSON.parse(fs.readFileSync(hoFile, 'utf8'));
  assert.equal(hoDisk.consumed, true, 'artifact was consumed exactly once');
  assert.equal(rt.agent.lastServedRoute(sess), 'bravo/f1', 'served route moved on');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('R3: the handoff is NOT re-injected on the next turn (a re-run must not duplicate context)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-r3-'));
  const rt = await mkRuntime();
  rt.cfg.patch({ ...TWO_PROVIDERS, workspace: dir }, { persist: false });
  const sess = 'sess-r3';
  await rt.agent.turn({ input: 'start the audit', session: sess });
  rt.cfg.patch({ models: { sessionRoutes: { [sess]: { tasks: 'bravo/f1', chat: 'bravo/f1', tools: 'bravo/f1', analysis: 'bravo/f1', final: 'bravo/f1' } } } }, { persist: false });
  await rt.agent.turn({ input: 'go on', session: sess });
  resetCalls();
  const r3 = await rt.agent.turn({ input: 'and now?', session: sess });
  assert.ok(r3.text);
  const sys = sysOf(lastCall());
  assert.doesNotMatch(sys, /HANDOFF CONTEXT/, 'consume-once: the switch is delivered exactly once');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('R4: a pre-crash artifact is consumed by a FRESH runtime — restart-resume works read-side', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-r4-'));
  const rt = await mkRuntime();
  rt.cfg.patch({ ...TWO_PROVIDERS, workspace: dir }, { persist: false });
  const sess = 'sess-r4';
  const art = await rt.agent.handoff({ session: sess });
  assert.equal(art.skipped, 'nothing to hand off yet', 'no noise without a goal/plan');
  // simulate what the producer would have written before the crash
  const file = rt.agent.handoffPath(sess);
  fs.writeFileSync(file, JSON.stringify({ store: 'majin.handoff.v1', session: sess, goal: 'migrate the queue cluster', plan: [{ text: 'drain consumers', status: 'doing' }], from: 'alpha/f1', to: 'bravo/f1', ts: Date.now() }) + '\n');
  await rt.shutdown();

  const rt2 = await mkRuntime();
  rt2.cfg.patch({ ...TWO_PROVIDERS, workspace: dir }, { persist: false });
  resetCalls();
  await rt2.agent.turn({ input: 'status?', session: sess });
  assert.match(sysOf(lastCall()), /HANDOFF CONTEXT/, 'artifact picked up after restart');
  assert.match(sysOf(lastCall()), /GOAL: migrate the queue cluster/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).consumed, true, 'marked consumed durably');
  resetCalls();
  await rt2.agent.turn({ input: 'next?', session: sess });
  assert.doesNotMatch(sysOf(lastCall()), /HANDOFF CONTEXT/, 'never served twice');
  await rt2.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('R5: failed plan persist is honestly reported and never kills the turn', async (t) => {
  if (!canEnforcePermissions) return t.skip('permission bits not enforceable on this platform/user');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-r5-'));
  const rt = await mkRuntime();
  rt.cfg.patch({ ...TWO_PROVIDERS, workspace: dir }, { persist: false });
  const sessDir = dirs.sessions;
  fs.mkdirSync(sessDir, { recursive: true });
  fs.chmodSync(sessDir, 0o555);
  try {
    const rtFail = await mkRuntime();
    rtFail.cfg.patch({ ...TWO_PROVIDERS, workspace: dir }, { persist: false });
    rtFail.agent.setPlan('sess-r5', [{ text: 'unpersistable step', status: 'doing' }]);
    assert.ok(rtFail.agent.lastPlanPersistError, 'persist failure is recorded, not swallowed');
    assert.equal(rtFail.agent.plans.get('sess-r5')?.length, 1, 'the plan still lives in memory');
    const r = await rtFail.agent.turn({ input: 'hello', session: 'sess-r5', history: [{ role: 'user', content: 'hello' }] });
    assert.ok(r.text, 'a journal hiccup never kills a turn');
    await rtFail.shutdown();
  } finally {
    fs.chmodSync(sessDir, 0o755);
  }
  await rt.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('R6: handoff() reports persisted on a healthy disk and the artifact is well-formed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-r6-'));
  const rt = await mkRuntime();
  rt.cfg.patch({ ...TWO_PROVIDERS, workspace: dir }, { persist: false });
  const sess = 'sess-r6';
  await rt.agent.turn({ input: 'document the rollout', session: sess });
  rt.agent.setPlan(sess, [{ text: 'write runbook', status: 'doing' }]);
  const art = await rt.agent.handoff({ session: sess, to: 'bravo/f1' });
  assert.equal(art.persisted, true, 'honest success signal');
  assert.equal(art.goal, 'document the rollout', 'goal comes from the durable history');
  assert.deepEqual(art.plan.map((p) => p.text), ['write runbook']);
  assert.ok(fs.existsSync(rt.agent.handoffPath(sess)), 'artifact on disk');
  await rt.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});
