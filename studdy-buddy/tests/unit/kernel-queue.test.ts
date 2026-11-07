import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskQueue, EventLog, openKernel, ensureLayout } from '@studdy/agent-core';

/**
 * The durable queue is the part of MAJIN V6 that made "autonomous" honest:
 * nothing can be executed twice, nothing can be silently replayed after an
 * uncertain effect, and a crashed worker never loses work or duplicates an
 * irreversible action.
 *
 * These tests exercise the real filesystem (a real JSON state file, a real
 * cross-process lock directory) rather than a mocked store.
 */

let dir: string;
let queueFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studdy-queue-'));
  queueFile = join(dir, 'queue', 'queue.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeQueue(clock?: () => number): TaskQueue {
  return new TaskQueue({ file: queueFile, clock });
}

describe('durable kernel queue', () => {
  it('persists tasks, deduplicates by key and claims priority then age', async () => {
    let now = 1_700_000_000_000;
    const queue = makeQueue(() => now);
    const low = await queue.add({ kind: 'health.delay', payload: { ms: 1 }, priority: 0 });
    now += 1000;
    const high = await queue.add({ kind: 'health.delay', payload: { ms: 1 }, priority: 9 });
    expect(low.deduplicated).toBe(false);
    expect(high.task.id).not.toBe(low.task.id);

    const duplicate = await queue.add({ kind: 'health.delay', dedupeKey: 'same-work', priority: 1 });
    const again = await queue.add({ kind: 'health.delay', dedupeKey: 'same-work', priority: 1 });
    expect(duplicate.deduplicated).toBe(false);
    expect(again.deduplicated).toBe(true);
    expect(again.task.id).toBe(duplicate.task.id);

    const claimed = await queue.claim({ workerId: 'w1', now: now + 10 });
    // priority 9 beats priority 1 beats priority 0
    expect(claimed?.id).toBe(high.task.id);
    const next = await queue.claim({ workerId: 'w1', now: now + 20 });
    expect(next?.id).toBe(duplicate.task.id);
  });

  it('rejects an invalid task kind and survives a torn state file', async () => {
    const queue = makeQueue();
    await expect(queue.add({ kind: 'NOT VALID' })).rejects.toMatchObject({ code: 'TASK_KIND_INVALID' });

    await queue.add({ kind: 'health.delay' });
    // A half-written file is what a crash without atomic rename would leave.
    mkdirSync(join(dir, 'queue'), { recursive: true });
    writeFileSync(queueFile, '{"schema": "studdy.kernel.queue/v1", "tasks": [');
    await expect(queue.stats()).rejects.toMatchObject({ code: 'STATE_CORRUPT' });
  });

  it('gates dependencies: a failed dependency blocks the chain, a completed one releases it', async () => {
    const queue = makeQueue();
    const first = await queue.add({ kind: 'health.delay', maxAttempts: 1 });
    const second = await queue.add({ kind: 'health.delay', deps: [first.task.id] });

    const claimSecond = await queue.claim({ workerId: 'w1' });
    expect(claimSecond?.id).toBe(first.task.id);
    await queue.fail(first.task.id, { code: 'INJECTED', retryable: false });

    const recovered = await queue.recoverExpired();
    expect(recovered).toEqual([{ id: second.task.id, action: 'DEPENDENCY_BLOCKED' }]);

    const stored = await queue.get(second.task.id);
    expect(stored?.state).toBe('BLOCKED');
    expect(stored?.blocked?.code).toBe('DEPENDENCY_BLOCKED');

    // Requeueing the parent and completing it releases the child again.
    await queue.requeue(first.task.id);
    const parent = await queue.claim({ workerId: 'w1' });
    expect(parent?.id).toBe(first.task.id);
    await queue.complete(first.task.id, { summary: 'done' });
    await queue.requeue(second.task.id);
    const child = await queue.claim({ workerId: 'w1' });
    expect(child?.id).toBe(second.task.id);
  });

  it('treats a lost lease as retryable for safe work and UNCERTAIN for irreversible work', async () => {
    let now = 1_700_000_000_000;
    const queue = makeQueue(() => now);

    const safe = await queue.add({ kind: 'health.delay' });
    const safeClaim = await queue.claim({ workerId: 'w1', now, leaseMs: 1000 });
    expect(safeClaim?.id).toBe(safe.task.id);
    now += 5000;
    await queue.recoverExpired({ now });
    expect((await queue.get(safe.task.id))?.state).toBe('FAILED_RETRYABLE');

    // Higher priority so the retryable task above is not picked up again.
    const irreversible = await queue.add({ kind: 'health.delay', irreversible: true, effectKey: 'send:email:1', priority: 10 });
    const irreversibleClaim = await queue.claim({ workerId: 'w1', now, leaseMs: 1000 });
    expect(irreversibleClaim?.id).toBe(irreversible.task.id);
    now += 5000;
    await queue.recoverExpired({ now });
    const recovered = await queue.get(irreversible.task.id);
    expect(recovered?.state).toBe('UNCERTAIN');
    expect(recovered?.blocked?.requiresOwner).toBe(true);
    expect((await queue.effect('send:email:1'))?.state).toBe('uncertain');
  });

  it('never requeues an uncertain task without an explicit reconciliation', async () => {
    let now = 1_700_000_000_000;
    const queue = makeQueue(() => now);
    const task = await queue.add({ kind: 'health.delay', irreversible: true });
    await queue.claim({ workerId: 'w1', now, leaseMs: 1000 });
    now += 5000;
    await queue.recoverExpired({ now });

    await expect(queue.requeue(task.task.id)).rejects.toMatchObject({ code: 'TASK_UNCERTAIN_RETRY_REFUSED' });
    await expect(queue.resolveUncertain(task.task.id, { outcome: 'confirmed' })).rejects.toMatchObject({
      code: 'RECONCILE_EVIDENCE_REQUIRED',
    });
    await expect(queue.resolveUncertain(task.task.id, { outcome: 'nonsense' as 'confirmed' })).rejects.toMatchObject({
      code: 'RECONCILE_OUTCOME_INVALID',
    });
    const resolved = await queue.resolveUncertain(task.task.id, {
      outcome: 'confirmed',
      evidence: { screenshot: 'proof.png', operator: 'owner' },
    });
    expect(resolved.state).toBe('COMPLETED');
  });

  it('keeps one owner per effect key and never repeats a completed effect', async () => {
    const queue = makeQueue();
    const a = await queue.add({ kind: 'health.delay', effectKey: 'apply:job:42' });
    const b = await queue.add({ kind: 'health.delay', effectKey: 'apply:job:42', priority: 10 });

    const owner = await queue.claim({ workerId: 'w1' });
    expect(owner?.id).toBe(b.task.id);

    // The second task must not be claimed while the effect is owned elsewhere.
    const blockedClaim = await queue.claim({ workerId: 'w2' });
    expect(blockedClaim).toBeNull();
    const blockedTask = await queue.get(a.task.id);
    expect(blockedTask?.state).toBe('BLOCKED');
    expect(blockedTask?.blocked?.code).toBe('EFFECT_OWNED_ELSEWHERE');

    // The owner completes the real effect exactly once.
    await queue.complete(b.task.id, { summary: 'sent once', receipt: { reference: 'ref-1' } });
    expect((await queue.effect('apply:job:42'))?.state).toBe('completed');

    // A queued duplicate added afterwards is settled by the ledger, never run.
    const late = await queue.add({ kind: 'health.delay', effectKey: 'apply:job:42', priority: 100 });
    expect(await queue.claim({ workerId: 'w4' })).toBeNull();
    const settled = await queue.get(late.task.id);
    expect(settled?.state).toBe('COMPLETED');
    expect(settled?.result?.deduplicated).toBe(true);
  });

  it('refuses to cancel an already terminal task and records attempts in history', async () => {
    const queue = makeQueue();
    const task = await queue.add({ kind: 'health.delay' });
    await queue.claim({ workerId: 'w1' });
    await queue.complete(task.task.id, { summary: 'ok' });
    await expect(queue.cancel(task.task.id)).rejects.toMatchObject({ code: 'TASK_STATE_INVALID' });

    const stored = await queue.get(task.task.id);
    expect(stored?.history.map((h) => h.state)).toEqual(['QUEUED', 'RUNNING', 'COMPLETED']);
  });

  it('writes a real atomically-replaced state file and an append-only event log', async () => {
    const eventsDir = join(dir, 'events');
    const log = new EventLog(eventsDir);
    const queue = new TaskQueue({ file: queueFile, log });
    const { task } = await queue.add({ kind: 'health.delay', title: 'probe' });
    expect(existsSync(queueFile)).toBe(true);
    const parsed = JSON.parse(readFileSync(queueFile, 'utf8')) as { tasks: { id: string }[] };
    expect(parsed.tasks[0]?.id).toBe(task.id);

    const events = log.read({ limit: 50 });
    expect(events.some((event) => event.type === 'task.queued')).toBe(true);
    // Every line is valid JSONL with a monotonic seq.
    const raw = readFileSync(join(eventsDir, 'events.jsonl'), 'utf8').trim().split('\n');
    const seqs = raw.map((line) => (JSON.parse(line) as { seq: number }).seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('opens an isolated kernel home under the data directory', async () => {
    const kernel = openKernel({ dataDir: dir });
    expect(kernel.home).toBe(join(dir, 'kernel'));
    expect(kernel.paths.queueFile).toBe(join(dir, 'kernel', 'queue', 'queue.json'));
    expect(existsSync(kernel.paths.eventsDir)).toBe(true);
    const stats = await kernel.queue.stats();
    expect(stats.total).toBe(0);

    // An explicit override wins, and environment resolution is pure.
    const override = openKernel({ dataDir: dir, home: join(dir, 'other') });
    expect(override.home).toBe(join(dir, 'other'));
    const third = ensureLayout(join(dir, 'third'));
    expect(third.home).toBe(join(dir, 'third'));
    expect(third.queueFile).toBe(join(dir, 'third', 'queue', 'queue.json'));
  });
});
