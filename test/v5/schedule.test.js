import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { V5Schedule, createScheduleTool } from '../../src/v5/schedule.js';
import { createV5Server } from '../../src/v5/server.js';

function fixture(t, execute = async () => ({ status: 'COMPLETED', goal_id: 'fixture-goal' })) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-schedule-'));
  let now = Date.now(), busy = false, allowed = true;
  const options = { dataDir: root, execute, isBusy: () => busy, isAllowed: () => allowed, now: () => now };
  const service = new V5Schedule(options); service.start();
  t.after(async () => { await service.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, service, options, advance: () => { now += 2000; }, busy: value => { busy = value; }, allowed: value => { allowed = value; } };
}

test('scheduled V5 work persists, respects busy/grants, runs once, and records its goal id', async t => {
  let calls = 0;
  const f = fixture(t, async ({ goalText }) => { calls++; assert.equal(goalText, 'Inspect saved CV'); return { status: 'COMPLETED', goal_id: 'scheduled-proof' }; });
  const tool = createScheduleTool(f.service);
  assert.equal(tool.inputSchema.type, 'object');
  const { job } = tool.run({ action: 'add', when: 'every 1s', task: 'Inspect saved CV' });
  f.advance(); f.busy(true); await f.service.tick(); assert.equal(calls, 0);
  f.busy(false); f.allowed(false); await f.service.tick(); assert.equal(calls, 0);
  f.allowed(true); await f.service.tick(); assert.equal(calls, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'v5-schedule.json')))[0];
  assert.equal(saved.metadata.goalId, 'scheduled-proof'); assert.equal(saved.paused, true);
  f.advance(); await f.service.tick(); assert.equal(calls, 1);
  await f.service.stop(); f.service.start();
  assert.equal(f.service.status().jobs[0].id, job.id);
  await f.service.tick(); assert.equal(calls, 1);
});

test('uncertain results pause recurrence; simultaneous ticks and competing hosts cannot duplicate execution', async t => {
  let release, calls = 0;
  const f = fixture(t, async () => { calls++; await new Promise(r => { release = r; }); return { status: 'PARTIAL', goal_id: 'uncertain' }; });
  f.service.manage({ action: 'add', when: 'every 1s', task: 'Apply once', maxRuns: 3 });
  const competing = new V5Schedule(f.options); competing.start();
  assert.equal(competing.status().running, false); assert.match(competing.status().error, /lock exists/);
  await competing.stop(); assert.ok(fs.existsSync(f.service.lockFile));
  f.advance(); const run = f.service.tick(); await f.service.tick(); assert.equal(calls, 1);
  release(); await run;
  f.advance(); await f.service.tick(); assert.equal(calls, 1);
  assert.equal(f.service.status().jobs[0].paused, true);
});

test('interrupted checkpoints are paused on restart, invalid schedules are rejected, and lifecycle actions persist', async t => {
  const f = fixture(t);
  assert.throws(() => f.service.manage({ action: 'add', when: '2000-01-01 09:00', task: 'old' }), /future/);
  assert.equal(f.service.status().jobs.length, 0);
  assert.throws(() => f.service.manage({ action: 'add', when: 'every 1s', task: 'x', model: 'other' }));
  const { job } = f.service.manage({ action: 'add', when: 'every 1s', task: 'x', maxRuns: 2 });
  f.service.manage({ action: 'pause', id: job.id }); assert.equal(f.service.status().jobs[0].paused, true);
  f.service.manage({ action: 'resume', id: job.id }); assert.equal(f.service.status().jobs[0].paused, false);
  f.service.scheduler.jobs[0].running = true; f.service.scheduler.save();
  await f.service.stop(); f.service.start();
  assert.equal(f.service.status().jobs[0].lastStatus, 'interrupted');
  assert.equal(f.service.status().jobs[0].paused, true);
  f.service.manage({ action: 'remove', id: job.id }); assert.equal(f.service.status().jobs.length, 0);
});

test('server exposes schedule tool to DeepSeek and executes scheduled file work through real V5 tools and verification', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-schedule-agent-'));
  let sawSchedule = false, calls = 0;
  const srv = createV5Server({ dataDir: root, completeImpl: async request => {
    calls++; sawSchedule ||= request.tools.some(tool => tool.name === 'majin_schedule');
    assert.equal(request.model, 'deepseek-fixture');
    const call = (name, args) => ({ text: '', toolCalls: [{ id: `schedule-${calls}`, name, argsJson: JSON.stringify(args) }], usage: {} });
    if (calls === 1) return call('goal_criteria', { criteria: [{ kind: 'file', path: 'scheduled.txt', contains: 'verified schedule' }] });
    if (calls === 2) return call('fs_write', { path: 'scheduled.txt', content: 'verified schedule' });
    return { text: 'Done', toolCalls: [], usage: {} };
  } });
  await srv.architect.providers.configureProvider({ providerId: 'deepseek', apiKey: 'dummy-local-key', discover: false });
  srv.architect.providers.selectModel({ providerId: 'deepseek', modelId: 'deepseek-fixture', allowManualFallback: true });
  srv.architect.files.ownerMode.grant({ lanes: ['files', 'sys'], folders: [srv.architect.workspaceDir] });
  t.after(async () => { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const { url } = await srv.start();
  const response = await fetch(url + '/api/v5/schedule', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'add', when: 'every 1s', task: 'Create scheduled.txt with verified schedule' }) });
  assert.equal(response.status, 200);
  srv.schedule.scheduler.jobs[0].nextRun = Date.now() - 1;
  await srv.schedule.tick();
  assert.equal(srv.schedule.status().jobs[0].lastStatus, 'COMPLETED');
  assert.equal(sawSchedule, true);
  assert.equal(fs.readFileSync(path.join(srv.architect.workspaceDir, 'scheduled.txt'), 'utf8'), 'verified schedule');
  assert.ok(srv.providerAgent.getGoalState().verification_evidence.length);
});

test('provider exceptions pause recurrence and owner can remove schedules after grants are revoked', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; throw new Error('connection lost after unknown effect'); });
  const { job } = f.service.manage({ action: 'add', when: 'every 1s', task: 'Run once', maxRuns: 4 });
  f.advance(); await f.service.tick();
  assert.equal(f.service.status().jobs[0].paused, true);
  f.advance(); await f.service.tick(); assert.equal(calls, 1);
  f.allowed(false);
  assert.throws(() => f.service.manage({ action: 'resume', id: job.id }), /Owner sys lane/);
  assert.equal(f.service.manage({ action: 'remove', id: job.id }).removed, true);
});

test('model-created schedule can reach COMPLETED by independently reading the real host schedule endpoint', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-schedule-create-'));
  let calls = 0;
  const srv = createV5Server({ dataDir: root, completeImpl: async () => {
    calls++;
    const call = (name, args) => ({ text: '', toolCalls: [{ id: `create-${calls}`, name, argsJson: JSON.stringify(args) }], usage: {} });
    if (calls === 1) return call('majin_schedule', { action: 'add', when: 'every 1h', task: 'Find matching jobs', maxRuns: 3 });
    if (calls === 2) return call('goal_criteria', { criteria: [{ kind: 'http', url: srv.schedule.verificationUrl, contains: srv.schedule.status().jobs[0].id, status: 200 }] });
    return { text: 'Schedule created', toolCalls: [], usage: {} };
  } });
  await srv.architect.providers.configureProvider({ providerId: 'deepseek', apiKey: 'dummy-local-key', discover: false });
  srv.architect.providers.selectModel({ providerId: 'deepseek', modelId: 'deepseek-fixture', allowManualFallback: true });
  srv.architect.files.ownerMode.grant({ lanes: ['sys', 'web'] });
  t.after(async () => { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await srv.start();
  const goal = await srv.providerAgent.execute({ goalText: 'Find matching jobs every hour, three times.' });
  assert.equal(goal.status, 'COMPLETED', goal.blocker);
  assert.ok(goal.verification_evidence.length);
  assert.equal(srv.schedule.status().jobs[0].maxRuns, 3);
});
