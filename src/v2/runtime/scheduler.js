/**
 * V2 DAG scheduler (master brief sections 21 + 26).
 *
 * Runs a TaskGraph with bounded concurrency via p-queue (adoption logged in
 * DEPENDENCIES_AND_LICENSES.md): ready tasks start together down to the
 * concurrency limit; dependents wake when their deps finish; failures are
 * classified, retried within maxAttempts, then blocked per graph policy.
 * Every attempt is receipted on the owning Goal. Emits plain events the
 * Studio timeline can render directly.
 */
import PQueue from 'p-queue';
import { TASK_STATES } from './dag.js';
import { normalizeError, POLICY } from './errors.js';

/**
 * execute(task, ctx) -> MUST return { result: 'success', evidence? } or { result:'failure', error?' }.
 * Work happens inside `execute`; the scheduler NEVER fabricates receipts for it.
 */
export async function runGraph({ goal, graph, execute, concurrency = 2, ctx = {}, onEvent = () => {}, signal = null, stopOnFirstFailure = false }) {
  if (!goal || !graph) throw new Error('runGraph requires goal and graph');
  if (typeof execute !== 'function') throw new Error('runGraph requires an execute(task, ctx) function');

  const queue = new PQueue({ concurrency });
  const started = new Set();
  let stopNew = false;

  const tryTask = (id) => queue.add(async () => {
    if (stopNew) return;
    if (signal && signal.aborted) return;

    const t = graph.tasks.get(id);
    graph.markState(id, TASK_STATES.RUNNING);
    t.attempt += 1;
    onEvent({ type: 'task.started', goalId: goal.id, taskId: id, attempt: t.attempt });

    let outcome;
    try {
      outcome = await execute(t, ctx);
    } catch (err) {
      outcome = { result: 'failure', error: err };
    }

    const { detail } = normalizeError(outcome.error);
    const receipt = goal.addReceipt({
      taskId: id,
      action: t.action,
      target: outcome.target || null,
      result: outcome.result,
      evidence: outcome.evidence || null,
      errorClass: outcome.result === 'failure' ? detail.cls : null,
      attempt: t.attempt,
      durationMs: outcome.durationMs || 0,
    });

    if (outcome.result === 'success') {
      graph.markState(id, TASK_STATES.DONE);
      onEvent({ type: 'task.completed', goalId: goal.id, taskId: id, receiptId: receipt.id });
      return;
    }

    if (detail.retry && t.attempt < t.maxAttempts && !stopOnFirstFailure) {
      graph.markState(id, TASK_STATES.PENDING);
      started.delete(id); // outer loop re-queues via readySet — single retry path only
      onEvent({ type: 'task.retry', goalId: goal.id, taskId: id, cls: detail.cls, attempt: t.attempt });
      const delay = Math.min(250 * Math.pow(2, t.attempt - 1), 2000);
      await new Promise((r) => setTimeout(r, delay));
      return;
    }

    graph.markState(id, TASK_STATES.FAILED);
    const blocked = graph.propagateFailure(id);
    onEvent({ type: 'task.failed', goalId: goal.id, taskId: id, cls: detail.cls, attempts: t.attempt, blocked });
    if (stopOnFirstFailure) stopNew = true;
  });

  // loop until graph exhausted or queue drained (retriggers retry/resume of failed dependents)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const id of started) {
      const st = graph.tasks.get(id).state;
      if (st === TASK_STATES.BLOCKED || st === TASK_STATES.FAILED) continue;
      if (st !== TASK_STATES.RUNNING && st !== TASK_STATES.DONE && st !== TASK_STATES.PENDING) started.delete(id);
    }
    const ready = graph.readySet().filter((id) => !started.has(id));
    for (const id of ready) {
      if (stopNew) break;
      started.add(id);
      tryTask(id);
    }
    if (graph.isExhausted()) break;
    if (stopNew && queue.size === 0 && queue.pending === 0) break;
    if (queue.size === 0 && queue.pending === 0 && ready.length === 0) break; // deadlock guard
    await Promise.race([queue.onIdle(), new Promise((r) => setTimeout(r, 150))]);
    if (queue.size === 0 && queue.pending === 0 && graph.isExhausted()) break;
  }

  await queue.onIdle();

  const done = [...graph.tasks.values()];
  return {
    exhausted: graph.isExhausted(),
    summary: {
      total: done.length,
      done: done.filter((t) => t.state === TASK_STATES.DONE).length,
      failed: done.filter((t) => t.state === TASK_STATES.FAILED).length,
      blocked: done.filter((t) => t.state === TASK_STATES.BLOCKED).length,
      classMap: POLICY.map((p) => p.cls),
    },
  };
}
