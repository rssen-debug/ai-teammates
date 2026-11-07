import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskQueue } from '../../src/v6/queue.js';
import { EventLog } from '../../src/v6/events.js';
import { Supervisor } from '../../src/v6/supervisor.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v6-supervisor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = new EventLog(path.join(root, 'events'));
  const queue = new TaskQueue({ file: path.join(root, 'queue.json'), log });
  return { root, log, queue };
}

const limits = { stallMs: 400, pollMs: 10, heartbeatIntervalMs: 1000, taskTimeoutMs: 3000, leaseMs: 5000 };

test('the supervisor continues through independent work without another prompt and isolates blockers', async (t) => {
  const { root, log, queue } = fixture(t);
  await queue.setBudget({ backoffMs: 10 });
  const completed = [];
  await queue.add({ kind: 'test.ok', title: 'first' });
  await queue.add({ kind: 'test.ok', title: 'second' });
  await queue.add({ kind: 'test.blocked', title: 'needs owner' });
  await queue.add({ kind: 'test.fail', title: 'final failure' });

  const handlers = {
    'test.ok': async (ctx) => {
      completed.push(ctx.task.id);
      await ctx.progress('half way');
      return { ok: true, summary: 'verified by test handler' };
    },
    'test.blocked': async () => ({ blocked: { code: 'CAPTCHA', reason: 'A CAPTCHA requires the owner', requiresOwner: true } }),
    'test.fail': async () => ({ ok: false, retryable: false, error: { code: 'INVALID_PORTAL' }, summary: 'bad portal' }),
  };
  const heartbeatFile = path.join(root, 'workers', 'w1.json');
  const supervisor = new Supervisor({
    queue, log, handlers, workerId: 'w1', heartbeatFile, limits,
  });
  const result = await supervisor.run({ maxTasks: 10, maxRuntimeMs: 5000 });

  assert.equal(result.completed, 2);
  assert.equal(result.blocked, 1);
  assert.equal(result.failed, 1);
  assert.equal(completed.length, 2);
  const stats = await queue.stats();
  assert.equal(stats.byState.COMPLETED, 2);
  assert.equal(stats.byState.BLOCKED, 1);
  assert.equal(stats.byState.FAILED_FINAL, 1);
  assert.equal(stats.byState.QUEUED, 0);

  const heartbeat = JSON.parse(fs.readFileSync(heartbeatFile, 'utf8'));
  assert.equal(heartbeat.workerId, 'w1');
  assert.equal(heartbeat.currentTaskId, null);
  assert.equal(heartbeat.tasksCompleted, 2);
  assert.equal(heartbeat.tasksBlocked, 1);

  const events = log.read({ limit: 200 });
  const types = events.map((event) => event.type);
  for (const expected of ['engine.started', 'worker.assigned', 'task.progress', 'task.completed', 'task.blocked', 'task.failed', 'engine.stopped']) {
    assert.ok(types.includes(expected), `missing real event ${expected}`);
  }
  const closed = events.filter((event) => event.type === 'task.completed');
  assert.ok(closed.every((event) => event.data.summary));
});

test('a completed external effect is not executed again after restart', async (t) => {
  const { root, log, queue } = fixture(t);
  let externalWrites = 0;
  const handlers = {
    'test.effect': async () => {
      externalWrites += 1;
      return { ok: true, summary: 'effect performed once', receipt: { kind: 'portal', reference: 'R-42' } };
    },
  };
  const first = await queue.add({ kind: 'test.effect', irreversible: true, effectKey: 'portal:job:42' });
  const run1 = await new Supervisor({ queue, log, handlers, workerId: 'w1', heartbeatFile: path.join(root, 'workers', 'w1.json'), limits })
    .run({ maxTasks: 5, maxRuntimeMs: 3000 });
  assert.equal(run1.completed, 1);
  assert.equal(externalWrites, 1);

  await queue.add({ kind: 'test.effect', irreversible: true, effectKey: 'portal:job:42', dedupeKey: 'different-key' });
  const run2 = await new Supervisor({ queue, log, handlers, workerId: 'w2', heartbeatFile: path.join(root, 'workers', 'w2.json'), limits })
    .run({ maxTasks: 5, maxRuntimeMs: 3000 });
  assert.equal(externalWrites, 1, 'the external effect must not run twice');
  assert.equal(run2.completed, 0);
  const stats = await queue.stats();
  assert.equal(stats.byState.COMPLETED, 2, 'the duplicate is settled from the ledger, not executed');
});

test('a silent handler is detected by the watchdog and failed instead of hanging forever', async (t) => {
  const { root, log, queue } = fixture(t);
  await queue.setBudget({ backoffMs: 10 });
  const handlers = { 'test.hang': async () => new Promise(() => {}) };
  const task = await queue.add({ kind: 'test.hang', maxAttempts: 1, title: 'hangs' });
  const supervisor = new Supervisor({
    queue, log, handlers, workerId: 'w1', heartbeatFile: path.join(root, 'workers', 'w1.json'),
    limits: { ...limits, stallMs: 60, pollMs: 10, taskTimeoutMs: 2000 },
  });
  const result = await supervisor.run({ maxTasks: 2, maxRuntimeMs: 4000 });
  assert.equal(result.stalled, 1);
  const stored = await queue.get(task.task.id);
  assert.equal(stored.state, 'FAILED_FINAL');
  assert.equal(stored.lastError.code, 'WATCHDOG_STALL');
  const stalled = log.read({ types: ['watchdog.stalled'], limit: 10 });
  assert.equal(stalled.length, 1);
  assert.match(stalled[0].data.note, /No tool or handler progress/);
});

test('two workers share the queue without executing a task twice', async (t) => {
  const { root, log, queue } = fixture(t);
  const executed = new Map();
  const handlers = {
    'test.shared': async (ctx) => {
      executed.set(ctx.task.id, (executed.get(ctx.task.id) || 0) + 1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true, summary: 'shared work done' };
    },
  };
  for (let index = 0; index < 6; index += 1) await queue.add({ kind: 'test.shared', title: `task ${index}` });
  const make = (workerId) => new Supervisor({
    queue, log, handlers, workerId,
    heartbeatFile: path.join(root, 'workers', `${workerId}.json`),
    limits,
  });
  const [a, b] = await Promise.all([
    make('wa').run({ maxTasks: 6, maxRuntimeMs: 5000 }),
    make('wb').run({ maxTasks: 6, maxRuntimeMs: 5000 }),
  ]);
  assert.equal(a.completed + b.completed, 6);
  assert.equal(executed.size, 6);
  assert.ok([...executed.values()].every((count) => count === 1), 'no task ran twice');
  const stats = await queue.stats();
  assert.equal(stats.byState.COMPLETED, 6);
});

test('budgets stop the worker and leave remaining work queued', async (t) => {
  const { root, log, queue } = fixture(t);
  const handlers = { 'test.ok': async () => ({ ok: true, summary: 'done' }) };
  for (let index = 0; index < 3; index += 1) await queue.add({ kind: 'test.ok', title: `task ${index}` });
  const supervisor = new Supervisor({ queue, log, handlers, workerId: 'w1', heartbeatFile: path.join(root, 'workers', 'w1.json'), limits });
  const result = await supervisor.run({ maxTasks: 1, maxRuntimeMs: 5000 });
  assert.equal(result.executed, 1);
  assert.equal(result.reason, 'task budget reached');
  const stats = await queue.stats();
  assert.equal(stats.byState.COMPLETED, 1);
  assert.equal(stats.byState.QUEUED, 2);
  assert.ok(log.read({ types: ['engine.budget_reached'], limit: 5 }).length === 1);
});
