import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openV6 } from '../../src/v6/home.js';

const execFileAsync = promisify(execFile);
const BIN = path.resolve('bin/majin-v6.mjs');

test('a detached worker executes queued tool work and records real evidence', { timeout: 60000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v6-live-worker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const dataDir = path.join(root, 'v5');
  const v6Home = path.join(root, 'v6');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'owner-mode.json'), JSON.stringify({
    schema: 'majin.v4.owner-mode/v1', version: 1, lanes: ['files'], folders: [workspace], browserOrigins: [], history: [],
  }));

  const ctx = openV6({ home: v6Home });
  const writeTask = await ctx.queue.add({
    kind: 'tool', title: 'write evidence file',
    payload: { tool: 'fs_write', arguments: { path: 'evidence.txt', content: 'worker wrote this' } },
    irreversible: false, dedupeKey: 'write-evidence',
  });
  const unhandled = await ctx.queue.add({ kind: 'job.publish', title: 'no handler exists for this' });

  const first = await execFileAsync(process.execPath, [
    BIN, 'worker', '--workspace', workspace, '--data-dir', dataDir, '--v6-home', v6Home,
    '--worker-id', 'live-w1', '--max-tasks', '5', '--max-runtime-ms', '20000', '--once',
  ], { timeout: 45000, maxBuffer: 4 * 1024 * 1024 });

  const summary = JSON.parse(first.stdout.trim().split('\n').at(-1));
  assert.equal(summary.workerId, 'live-w1');
  assert.equal(summary.completed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(fs.readFileSync(path.join(workspace, 'evidence.txt'), 'utf8'), 'worker wrote this');

  const written = await ctx.queue.get(writeTask.task.id);
  assert.equal(written.state, 'COMPLETED');
  assert.ok(written.result.summary);
  const unhandledTask = await ctx.queue.get(unhandled.task.id);
  assert.equal(unhandledTask.state, 'FAILED_FINAL');
  assert.equal(unhandledTask.lastError.code, 'HANDLER_NOT_IMPLEMENTED');

  const heartbeat = JSON.parse(fs.readFileSync(path.join(v6Home, 'workers', 'live-w1.json'), 'utf8'));
  assert.equal(heartbeat.state, 'STOPPED');
  assert.equal(heartbeat.tasksCompleted, 1);
  const events = ctx.log.read({ limit: 200 }).map((event) => event.type);
  for (const expected of ['engine.started', 'task.claimed', 'tool.started', 'tool.completed', 'task.completed', 'task.failed', 'engine.stopped']) {
    assert.ok(events.includes(expected), `missing event ${expected}`);
  }

  const second = await execFileAsync(process.execPath, [
    BIN, 'worker', '--workspace', workspace, '--data-dir', dataDir, '--v6-home', v6Home,
    '--worker-id', 'live-w2', '--max-tasks', '5', '--max-runtime-ms', '20000', '--once',
  ], { timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
  const secondSummary = JSON.parse(second.stdout.trim().split('\n').at(-1));
  assert.equal(secondSummary.completed, 0, 'completed work is never replayed');
  assert.equal(secondSummary.executed, 0);
});
