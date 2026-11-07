import test from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout, RepeatDetector, StallTracker, TurnClock, ApprovalWatch } from '../src/core/watchdog.js';
import { loop } from '../src/core/loop.js';

const stubCfg = (over = {}) => ({
  get: (k) => (over[k] ?? (k === 'routing.escalateAfterErrors' ? 99 : k === 'models.routes' ? { tasks: 'demo/echo' } : undefined)),
  resolveModel: (ref) => ({ ref: ref || 'demo/echo', apiKey: 'x', kind: 'mock', provider: 'demo', model: 'echo' }),
});
const fakeModelOk = () => async () => ({
  text: 'final', toolCalls: [], usage: { input: 1, output: 1, costUsd: 0 }, elapsedMs: 1,
});
const fakeModelCalls = (calls) => {
  let i = 0;
  return async () => {
    const c = calls[i];
    if (c) { i += 1; return { text: '', toolCalls: [c], usage: { input: 1, output: 1 }, elapsedMs: 1 }; }
    return { text: 'final', toolCalls: [], usage: { input: 1, output: 1 }, elapsedMs: 1 };
  };
};

test('W13 withTimeout: a hanging promise ends as explicit tool_timeout, never silent', async () => {
  const t0 = Date.now();
  const r = await withTimeout(new Promise(() => {}), { ms: 150, label: 'hang.tool' })
    .catch((e) => ({ code: e.code, message: e.message }));
  const dt = Date.now() - t0;
  assert.equal(r.code, 'tool_timeout');
  assert.match(r.message, /killed/);
  assert.ok(dt < 1000, `timeout must fire near its bound, got ${dt}ms`);
});

test('W13 RepeatDetector: N identical calls flagged — the wall is visible', () => {
  const d = new RepeatDetector(3);
  const args = { path: 'x.txt' };
  assert.equal(d.hit('fs.write', args).repeat, false);
  assert.equal(d.hit('fs.write', args).repeat, false);
  const third = d.hit('fs.write', args);
  assert.equal(third.repeat, true);
  assert.equal(third.count, 3);
  assert.equal(d.hit('fs.write', { path: 'y.txt' }).repeat, false, 'different args must NOT count against the same key');
});

test('W13 StallTracker: inactivity beyond stallMs reports stalled (truthful, not guessed)', () => {
  let nowT = 1000;
  const st = new StallTracker({ now: () => nowT });
  assert.deepEqual(st.checkStall(100).stalled, false);
  nowT = 1000 + 500;
  assert.equal(st.checkStall(100).stalled, true);
  st.bump();
  assert.equal(st.checkStall(100).stalled, false, 'progress bump resets');
});

test('W13 ApprovalWatch: pending -> stalled -> timed_out explicit transitions', () => {
  const events = [];
  const aw = new ApprovalWatch({ stallMs: 100, timeoutMs: 200, onStall: (e) => events.push(['stall', e.id]), onTimeout: (e) => events.push(['timeout', e.id]) });
  const t0 = Date.now();
  aw.watch('ap-1', { at: t0 });
  aw.tick(t0 + 150);
  assert.deepEqual(events, [['stall', 'ap-1']]);
  aw.tick(t0 + 300);
  assert.deepEqual(events, [['stall', 'ap-1'], ['timeout', 'ap-1']]);
  assert.deepEqual(aw.states(), [], 'timed-out approvals leave the pending map — never silently stuck');
});

test('W13 loop: identical tool calls stop with repeat_block stopReason (bounded)', async () => {
  const modelCall = fakeModelCalls([
    { id: '1', name: 'fs.write', argsJson: '{"path":"a.txt"}' },
    { id: '2', name: 'fs.write', argsJson: '{"path":"a.txt"}' },
    { id: '3', name: 'fs.write', argsJson: '{"path":"a.txt"}' },
    { id: '4', name: 'fs.write', argsJson: '{"path":"a.txt"}' },
  ]);
  const registry = {
    list: () => [], search: () => [], schemas: () => [],
    exec: async () => ({ ok: true, ms: 1, result: 'ok' }),
  };
  const out = await loop({ cfg: stubCfg({ 'agent.maxRepeatCalls': 3 }), registry, messages: [], job: 'tasks', modelCall: async () => modelCall(), });
  assert.equal(out.stopReason, 'repeat_block');
  assert.ok(out.blocked);
  assert.equal(out.toolLog.length, 3, 'bounded: never a 4th silent attempt');
  assert.ok(out.toolLog.some((t) => t.error && /repeat_loop|identical/i.test(t.error)));
});

test('W13 loop: turn time-box trip → turn_timeout with duration measured', async () => {
  const slow = async () => { await new Promise((r) => setTimeout(r, 120)); return { ok: true, ms: 120, result: 'ok' }; };
  const modelCall = fakeModelCalls([
    { id: '1', name: 'fs.write', argsJson: '{"path":"a.txt"}' },
    { id: '2', name: 'fs.write', argsJson: '{"path":"b.txt"}' },
    { id: '3', name: 'fs.write', argsJson: '{"path":"c.txt"}' },
    { id: '4', name: 'fs.write', argsJson: '{"path":"d.txt"}' },
    { id: '5', name: 'fs.write', argsJson: '{"path":"e.txt"}' },
  ]);
  const registry = { list: () => [], search: () => [], schemas: () => [], exec: slow };
  const events = [];
  const t0 = Date.now();
  const out = await loop({ cfg: stubCfg({ 'agent.maxTurnSec': 0.25, 'agent.maxRepeatCalls': 99 }), registry, messages: [], job: 'tasks', onEvent: (e) => events.push(e), modelCall: async () => modelCall() });
  const elapsed = Date.now() - t0;
  assert.equal(out.stopReason, 'turn_timeout');
  assert.ok(events.some((e) => e.type === 'turn_timeout'));
  assert.ok(elapsed < 3000, `time-box must actually bound the turn, got ${elapsed}ms`);
});

test('W13 loop: hanging tool gets tool_timeout and the conversation continues', async () => {
  const modelCall = fakeModelCalls([{ id: '1', name: 'hang.tool', argsJson: '{}' }]);
  const registry = { list: () => [], search: () => [], schemas: () => [], exec: async () => new Promise(() => {}) };
  const t0 = Date.now();
  const out = await loop({ cfg: stubCfg({ 'agent.toolTimeoutSec': 0.4 }), registry, messages: [], job: 'tasks', modelCall: async () => modelCall() });
  const dt = Date.now() - t0;
  assert.equal(out.text, 'final', 'after the timed-out tool the model could still answer');
  assert.ok(out.toolLog.some((t) => t.tool === 'hang.tool' && !t.ok && /timeout/i.test(t.error)));
  assert.ok(dt < 4000, `bounded, not stuck: took ${dt}ms`);
});
