import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { flowId, saveFlow, loadFlow, listFlows, fire, eventHash, isDuplicate, renderTemplate, underRateLimit, recordRun, newGithubEvents } from '../src/core/flows.js';

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flows-ws-'));

const fakeRegistry = (out = { ok: true, summary: 'acted' }) => ({
  exec: async (name, args, meta) => ({ ...out, meta: { name, args, meta } }),
});

function makeFlow(dir, over = {}) {
  const def = {
    id: flowId('test flow'), name: 'test flow',
    when: { type: 'manual' },
    then: { tool: 'fs.write', args: { path: 'seen.log', content: '{{path}} arrived ({{hash}})' } },
    enabled: true, maxFiresPerHour: 5, history: [], ...over,
  };
  saveFlow(dir, def);
  return def;
}

test('W5 state durability: add → state.json persists → reopen shows same flow incl. history', () => {
  const dir = ws();
  const flow = makeFlow(dir);
  recordRun(dir, loadFlow(dir, flow.id), { kind: 'fire', status: 'ok' });
  const fresh = listFlows(dir);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].id, flowId('test flow'));
  assert.equal(fresh[0].fireCount, 1);
  assert.equal(fresh[0].lastStatus, 'ok');
});

test('W5 dedupe: identical eventHash entries inside window suppressed', async () => {
  const dir = ws();
  const flow = makeFlow(dir);
  const ev = { eventHash: eventHash({ path: 'a.pdf' }), path: 'a.pdf', meta: {} };
  recordRun(dir, flow, { kind: 'fire', status: 'ok', eventHash: ev.eventHash });
  const fresh = loadFlow(dir, flow.id);
  assert.ok(isDuplicate(fresh, ev.eventHash), 'same hash inside window must be duplicate');
  assert.ok(!isDuplicate(fresh, eventHash('other')), 'different hash = new event');
});

test('W5 renderTemplate: only whitelisted bindings expand, unknown stay literal', () => {
  const out = renderTemplate({ a: '{{path}}', b: '{{event.kind}}', c: '{{unknown\x0driver}}' }, { path: '/tmp/x', meta: { kind: 'add' }, eventHash: 'h1' });
  assert.equal(out.a, '/tmp/x');
  assert.equal(out.b, 'add');
  assert.match(out.c, /\{\{/);
});

test('W5 rate limit cap honored (fires/hour)', () => {
  const dir = ws();
  const flow = makeFlow(dir);
  for (let i = 0; i < 5; i++) flow.history.push({ at: new Date().toISOString(), kind: 'fire', status: 'ok' });
  assert.equal(underRateLimit(flow, 5), false, '5 fires inside 1h + cap 5 -> capped');
});

test('W5 action executes with rendered args (end-to-end against fake registry)', async () => {
  const dir = ws();
  const flow = makeFlow(dir);
  const calls = [];
  const reg = { exec: async (name, args) => { calls.push([name, args]); return { ok: true, summary: 'wrote' }; } };
  const r = await fire(dir, loadFlow(dir, flow.id), { path: 'income.pdf', eventHash: eventHash('income.pdf') }, { registry: reg });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'fs.write');
  assert.match(calls[0][1].content, /income\.pdf arrived/);
  const after = loadFlow(dir, flow.id);
  assert.equal(after.history.length, 1);
  assert.equal(after.history[0].status, 'ok');
});

test('W5 deterministic failure: no retry avalanche, honest failed-state', async () => {
  const dir = ws();
  const flow = makeFlow(dir);
  let tries = 0;
  const reg = { exec: async () => { tries++; return { ok: false, error: { code: 'bad_input', message: 'invalid arg shape' } }; } };
  const r = await fire(dir, loadFlow(dir, flow.id), { path: 'x', eventHash: 'e1' }, { registry: reg, maxAttempts: 3 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'failed');
  assert.equal(tries, 1, 'deterministic error must exit after attempt #1 (never 3 silent retries)');
});

test('W5 approval-gate: exec-risk tool surfacing approval stops the flow honestly', async () => {
  const dir = ws();
  const flow = makeFlow(dir);
  const reg = { exec: async () => ({ ok: false, error: { code: 'approval_required', message: 'waiting' }, approval: { id: 'ap-1' } }) };
  const r = await fire(dir, loadFlow(dir, flow.id), { path: 'x', eventHash: 'e2' }, { registry: reg });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'waiting_approval');
  const after = loadFlow(dir, flow.id);
  assert.equal(after.history.slice(-1)[0].status, 'waiting_approval');
});

test('W5 github event dedupe across polls (offline events)', () => {
  const dir = ws();
  const flow = makeFlow(dir);
  flow.history = [{ at: new Date().toISOString(), kind: 'fire', status: 'ok', meta: { eventId: '999' } }];
  const fresh = newGithubEvents(flow, [{ id: '999', type: 'PushEvent' }, { id: '1000', type: 'PushEvent' }]);
  assert.deepEqual(fresh.map((e) => e.id), ['1000']);
});
