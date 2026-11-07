import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskQueue, TASK_STATES } from '../../src/v6/queue.js';
import { EventLog } from '../../src/v6/events.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v6-queue-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = new EventLog(path.join(root, 'events'));
  const queue = new TaskQueue({ file: path.join(root, 'queue.json'), log });
  return { root, log, queue };
}

test('tasks are durable, deduplicated and claimed by priority then age', async (t) => {
  const { queue, log } = fixture(t);
  const low = await queue.add({ kind: 'test.low', title: 'low', priority: 0 });
  const high = await queue.add({ kind: 'test.high', title: 'high', priority: 5, dedupeKey: 'same-work' });
  const duplicate = await queue.add({ kind: 'test.high', title: 'high again', priority: 9, dedupeKey: 'same-work' });
  assert.equal(low.deduplicated, false);
  assert.equal(high.deduplicated, false);
  assert.equal(duplicate.deduplicated, true, 'a live task with the same dedupeKey is reused');

  const first = await queue.claim({ workerId: 'w1' });
  assert.equal(first.id, high.task.id, 'higher priority wins');
  assert.equal(first.state, 'RUNNING');
  assert.equal(first.attempts, 1);
  assert.ok(first.lease.expiresAt);

  await queue.heartbeat(first.id, { workerId: 'w1', action: 'testing' });
  const done = await queue.complete(first.id, { summary: 'ok', receipt: { kind: 'test', reference: 'ref-1' } });
  assert.equal(done.state, 'COMPLETED');
  assert.equal(done.lease, null);

  const second = await queue.claim({ workerId: 'w1' });
  assert.equal(second.id, low.task.id);
  const stats = await queue.stats();
  assert.equal(stats.total, 2);
  assert.equal(stats.byState.COMPLETED, 1);
  assert.equal(stats.byState.RUNNING, 1);
  assert.ok(Object.keys(stats.byState).every((state) => TASK_STATES.includes(state)));

  const types = log.read({ limit: 50 }).map((event) => event.type);
  assert.ok(types.includes('task.queued'));
  assert.ok(types.includes('task.claimed'));
  assert.ok(types.includes('task.completed'));
  assert.ok(types.includes('receipt.observed'));
  assert.ok(types.includes('task.deduplicated'));
});

test('dependencies gate work and a failed dependency blocks the chain', async (t) => {
  const { queue } = fixture(t);
  const parent = await queue.add({ kind: 'test.parent' });
  const child = await queue.add({ kind: 'test.child', deps: [parent.task.id] });
  const first = await queue.claim({ workerId: 'w1' });
  assert.equal(first.id, parent.task.id, 'the dependent task must not be claimed first');

  await queue.fail(first.id, { code: 'PARENT_FAILED', retryable: false });
  const recovered = await queue.recoverExpired();
  assert.ok(recovered.some((entry) => entry.id === child.task.id && entry.action === 'DEPENDENCY_BLOCKED'));
  const childTask = await queue.get(child.task.id);
  assert.equal(childTask.state, 'BLOCKED');
  assert.equal(childTask.blocked.code, 'DEPENDENCY_BLOCKED');
});

test('a lost lease is retryable for safe work and UNCERTAIN for irreversible work', async (t) => {
  const { queue } = fixture(t);
  const safe = await queue.add({ kind: 'test.safe', maxAttempts: 3 });
  const risky = await queue.add({ kind: 'test.risky', irreversible: true, effectKey: 'application:aten:1' });
  await queue.claim({ workerId: 'w1', leaseMs: 1000 });
  await queue.claim({ workerId: 'w1', leaseMs: 1000 });

  const later = Date.now() + 5000;
  const recovered = await queue.recoverExpired({ now: later });
  assert.ok(recovered.length >= 1);
  const safeTask = await queue.get(safe.task.id);
  const riskyTask = await queue.get(risky.task.id);
  assert.equal(safeTask.state, 'FAILED_RETRYABLE');
  assert.equal(safeTask.lastError.code, 'WORKER_LOST');
  assert.equal(riskyTask.state, 'UNCERTAIN');
  assert.equal(riskyTask.blocked.code, 'WORKER_LOST_IRREVERSIBLE');

  const retried = await queue.requeue(safe.task.id, { by: 'owner' });
  assert.equal(retried.state, 'QUEUED');
  await assert.rejects(
    () => queue.requeue(risky.task.id, { by: 'owner' }),
    (error) => error.code === 'TASK_UNCERTAIN_RETRY_REFUSED',
  );
  await assert.rejects(
    () => queue.requeue(risky.task.id, { by: 'owner', allowUncertain: true }),
    (error) => error.code === 'TASK_UNCERTAIN_RETRY_REFUSED',
  );
  await assert.rejects(
    () => queue.resolveUncertain(risky.task.id, { outcome: 'confirmed' }),
    (error) => error.code === 'RECONCILE_EVIDENCE_REQUIRED',
  );
  const confirmed = await queue.resolveUncertain(risky.task.id, {
    outcome: 'confirmed', evidence: { confirmationId: 'portal-1' },
  });
  assert.equal(confirmed.state, 'COMPLETED');
});

test('one effect key has a single owner and a completed effect is never repeated', async (t) => {
  const { queue } = fixture(t);
  const first = await queue.add({ kind: 'test.submit', effectKey: 'effect:1', irreversible: true });
  const claimed = await queue.claim({ workerId: 'w1' });
  assert.equal(claimed.id, first.task.id);
  await queue.complete(claimed.id, { receipt: { kind: 'portal', reference: 'R-1' } });

  const second = await queue.add({ kind: 'test.submit', effectKey: 'effect:1', irreversible: true, dedupeKey: 'other-key' });
  assert.equal(second.deduplicated, false, 'a different dedupe key still creates a task');
  const next = await queue.claim({ workerId: 'w1' });
  assert.equal(next, null, 'the ledger completes the duplicate instead of running it');
  const duplicate = await queue.get(second.task.id);
  assert.equal(duplicate.state, 'COMPLETED');
  assert.equal(duplicate.result.deduplicated, true);
  const effect = await queue.effect('effect:1');
  assert.equal(effect.state, 'completed');
  assert.equal(effect.receipt.reference, 'R-1');
});

test('two tasks cannot own the same effect at the same time', async (t) => {
  const { queue } = fixture(t);
  await queue.add({ kind: 'test.a', effectKey: 'same', irreversible: true });
  const owner = await queue.claim({ workerId: 'w1' });
  assert.ok(owner);
  const rival = await queue.add({ kind: 'test.b', effectKey: 'same', irreversible: true });
  const other = await queue.claim({ workerId: 'w2' });
  assert.equal(other, null);
  const rivalTask = await queue.get(rival.task.id);
  assert.equal(rivalTask.state, 'BLOCKED');
  assert.equal(rivalTask.blocked.code, 'EFFECT_OWNED_ELSEWHERE');
});
