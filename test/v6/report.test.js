import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openV6 } from '../../src/v6/home.js';
import { buildReport, renderReport } from '../../src/v6/report.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v6-report-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, ...openV6({ home: path.join(root, 'v6') }) };
}

test('the report is derived from persisted queue, events and job state', async (t) => {
  const ctx = fixture(t);
  const first = await ctx.queue.add({ kind: 'health.delay', title: 'wait briefly' });
  await ctx.queue.add({ kind: 'tool', title: 'queued work' });
  const claimed = await ctx.queue.claim({ workerId: 'w1' });
  await ctx.queue.complete(claimed.id, { summary: 'verified by test' });

  await ctx.jobs.upsertDiscovered({
    site: 'platsbanken', siteId: '99', title: 'Developer', company: 'Acme',
    url: 'https://example.com/job/99',
  }, 'it-candidate');

  const report = await buildReport({
    queue: ctx.queue, log: ctx.log, jobs: ctx.jobs, workersDir: ctx.workersDir, home: ctx.home,
    gmailStatus: { state: 'NOT_CONFIGURED' }, syncStatus: { state: 'NOT_CONFIGURED' },
  });
  assert.equal(report.queue.total, 2);
  assert.equal(report.queue.byState.COMPLETED, 1);
  assert.equal(report.queue.byState.QUEUED, 1);
  assert.equal(report.jobs.total, 1);
  assert.equal(report.jobs.byState.DISCOVERED, 1);
  assert.equal(report.model, 'OpenCode-owned (not reported by MAJIN)');
  assert.ok(report.activity.some((line) => line.includes('Task completed: verified by test')));
  assert.ok(!report.activity.some((line) => line.includes('Job search completed')), 'no invented activity');
  assert.equal(report.engine.state, 'NOT_RUNNING');

  const rendered = renderReport(report);
  assert.match(rendered, /OPENCODE V6 — LIVE STATUS/);
  assert.match(rendered, /Running:\s+0/);
  assert.match(rendered, /Completed:\s+1/);
  assert.match(rendered, /Gmail: NOT_CONFIGURED/);
  assert.match(rendered, /WHAT IS NOT KNOWN/);
  assert.equal(first.task.state, 'QUEUED');
});

test('worker health distinguishes a live heartbeat from a stale one', async (t) => {
  const ctx = fixture(t);
  const now = Date.now();
  const fresh = {
    workerId: 'w-fresh', pid: process.pid, state: 'ACTIVE', updatedAt: new Date(now).toISOString(),
    currentTaskId: 'tsk_1', lastAction: 'tool started', lastActionAt: new Date(now).toISOString(),
    tasksCompleted: 2, tasksFailed: 0, tasksBlocked: 0, toolCalls: 3,
  };
  fs.writeFileSync(path.join(ctx.workersDir, 'w-fresh.json'), JSON.stringify(fresh));
  let report = await buildReport({ queue: ctx.queue, log: ctx.log, workersDir: ctx.workersDir, home: ctx.home });
  assert.equal(report.workers[0].state, 'ACTIVE');
  assert.equal(report.health.watchdog, 'HEALTHY');
  assert.equal(report.engine.state, 'RUNNING');

  const stale = { ...fresh, workerId: 'w-stale', state: 'ACTIVE', updatedAt: new Date(now - 120000).toISOString() };
  fs.writeFileSync(path.join(ctx.workersDir, 'w-stale.json'), JSON.stringify(stale));
  report = await buildReport({ queue: ctx.queue, log: ctx.log, workersDir: ctx.workersDir, home: ctx.home });
  const staleWorker = report.workers.find((worker) => worker.workerId === 'w-stale');
  assert.equal(staleWorker.state, 'STALLED');
  assert.equal(report.health.watchdog, 'STALLED');

  fs.rmSync(path.join(ctx.workersDir, 'w-fresh.json'));
  fs.rmSync(path.join(ctx.workersDir, 'w-stale.json'));
  report = await buildReport({ queue: ctx.queue, log: ctx.log, workersDir: ctx.workersDir, home: ctx.home });
  assert.equal(report.engine.state, 'NOT_RUNNING');
  assert.deepEqual(report.health.workers, ['No worker heartbeat recorded']);
});

test('the report stays truthful with no state at all', async (t) => {
  const ctx = fixture(t);
  const report = await buildReport({ queue: ctx.queue, log: ctx.log, workersDir: ctx.workersDir, home: ctx.home });
  assert.equal(report.queue.total, 0);
  assert.deepEqual(report.activity, []);
  const rendered = renderReport(report);
  assert.match(rendered, /no persisted events/);
  assert.match(rendered, /No worker heartbeat recorded/);
});
