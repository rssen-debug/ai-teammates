/**
 * MAJIN V6 — bounded work supervisor.
 *
 * This is not a model loop. It executes queued, owner-authorized tasks one at
 * a time, records real progress, isolates blockers and stops on budgets.
 * Several worker processes may share one queue; claims are serialized and
 * irreversible effects are single-owner.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskQueue } from './queue.js';
import { WorkerHeartbeat } from './worker-state.js';
import { clampInt } from './util.js';

export const DEFAULT_LIMITS = Object.freeze({
  maxTasks: 25,
  maxRuntimeMs: 15 * 60 * 1000,
  maxToolCalls: 100,
  taskTimeoutMs: 5 * 60 * 1000,
  stallMs: 90 * 1000,
  leaseMs: 120 * 1000,
  heartbeatIntervalMs: 5000,
  pollMs: 500,
});

export class Supervisor {
  constructor({
    queue, log, handlers, workerId = `w-${process.pid}-${randomUUID().slice(0, 6)}`,
    heartbeatFile, stopFile = null, clock = Date.now, limits = {}, toolInvoker = null,
  } = {}) {
    if (!queue) throw new Error('Supervisor requires a TaskQueue');
    this.queue = queue;
    this.log = log;
    this.handlers = handlers instanceof Map
      ? handlers
      : (typeof handlers?.map === 'function' && typeof handlers?.get === 'function'
        ? handlers.map()
        : new Map(Object.entries(handlers || {})));
    this.workerId = workerId;
    this.clock = clock;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.stopFile = stopFile;
    this.toolInvoker = toolInvoker;
    this.heartbeat = new WorkerHeartbeat({
      file: heartbeatFile || path.join(path.dirname(queue.file), '..', 'worker-heartbeat.json'),
      workerId,
      clock,
    });
    this.stopping = false;
    this.stats = { claimed: 0, completed: 0, failed: 0, blocked: 0, uncertain: 0, stalled: 0, toolCalls: 0 };
  }

  requestStop(reason = 'requested') {
    this.stopping = true;
    this.stopReason = reason;
  }

  #stopRequested() {
    if (this.stopping) return this.stopReason || 'stop requested';
    if (this.stopFile && fs.existsSync(this.stopFile)) return 'STOP file present';
    return null;
  }

  #emit(type, data) {
    try { this.log?.append(type, { workerId: this.workerId, ...data }); } catch { /* never break work for telemetry */ }
  }

  async run({ maxTasks = this.limits.maxTasks, maxRuntimeMs = this.limits.maxRuntimeMs, untilEmpty = true } = {}) {
    const started = this.clock();
    this.#emit('engine.started', { maxTasks, maxRuntimeMs, queue: this.queue.file });
    this.heartbeat.beat({ state: 'ACTIVE', lastAction: 'engine started' });
    let executed = 0;
    let reason = 'queue empty';
    try {
      while (true) {
        const stop = this.#stopRequested();
        if (stop) { reason = stop; break; }
        const elapsed = this.clock() - started;
        if (executed >= maxTasks) { reason = 'task budget reached'; this.#emit('engine.budget_reached', { budget: 'maxTasks', maxTasks }); break; }
        if (elapsed >= maxRuntimeMs) { reason = 'runtime budget reached'; this.#emit('engine.budget_reached', { budget: 'maxRuntimeMs', maxRuntimeMs }); break; }
        // Tool budget is per task in the handler context; the engine keeps a
        // hard cap across the whole run as well.
        if (this.stats.toolCalls >= this.limits.maxToolCalls) { reason = 'tool budget reached'; this.#emit('engine.budget_reached', { budget: 'maxToolCalls' }); break; }

        await this.queue.recoverExpired();
        let task = null;
        try {
          task = await this.queue.claim({ workerId: this.workerId, leaseMs: this.limits.leaseMs, now: this.clock() });
        } catch (error) {
          this.#emit('engine.error', { code: error.code || 'CLAIM_FAILED', message: error.message });
          reason = 'claim failed';
          break;
        }
        if (!task) {
          const stats = await this.queue.stats();
          const active = (stats.byState.QUEUED || 0) + (stats.byState.RUNNING || 0) + (stats.byState.FAILED_RETRYABLE || 0);
          if (!untilEmpty || active === 0) { reason = 'no eligible tasks'; break; }
          // Work exists but is waiting for a dependency or retry backoff.
          this.heartbeat.beat({ state: 'IDLE', currentTaskId: null, lastAction: 'waiting for eligible task' });
          await new Promise((resolve) => setTimeout(resolve, this.limits.pollMs));
          continue;
        }
        executed += 1;
        this.stats.claimed += 1;
        await this.#execute(task);
      }
    } finally {
      this.heartbeat.beat({ state: 'STOPPED', currentTaskId: null, lastAction: `engine stopped: ${reason}` });
      this.#emit('engine.stopped', { reason, ...this.stats });
    }
    return { reason, executed, ...this.stats };
  }

  async #execute(task) {
    const handler = this.handlers.get(task.kind);
    this.heartbeat.beat({
      state: 'ACTIVE', currentTaskId: task.id,
      lastAction: `running ${task.kind}`, toolCalls: this.heartbeat.toolCalls,
    });
    this.#emit('worker.assigned', { taskId: task.id, kind: task.kind, attempt: task.attempts });

    if (!handler) {
      await this.queue.fail(task.id, {
        code: 'HANDLER_NOT_IMPLEMENTED', messageClass: 'missing-handler',
        retryable: false, workerId: this.workerId, summary: `No handler for task kind ${task.kind}`,
      });
      this.stats.failed += 1;
      this.heartbeat.beat({ tasksFailed: this.heartbeat.tasksFailed + 1 });
      return;
    }

    const abort = new AbortController();
    let lastProgressAt = this.clock();
    let stallTimer = null;
    let heartbeatTimer = null;
    let currentAction = `running ${task.kind}`;
    let taskToolCalls = 0;

    const progress = async (action) => {
      currentAction = String(action || 'working').slice(0, 120);
      lastProgressAt = this.clock();
      this.heartbeat.beat({ lastAction: currentAction });
      try {
        await this.queue.heartbeat(task.id, {
          workerId: this.workerId, action: currentAction, now: this.clock(), leaseMs: this.limits.leaseMs,
        });
      } catch { /* a lease race is handled by the watchdog result */ }
    };

    const callTool = async (name, args = {}, { operationId = null, irreversible = false, progressLabel = null } = {}) => {
      if (taskToolCalls >= this.limits.maxToolCalls) {
        throw Object.assign(new Error('Per-task tool budget exceeded'), { code: 'TOOL_BUDGET_EXCEEDED', retryable: false });
      }
      taskToolCalls += 1;
      this.stats.toolCalls += 1;
      this.heartbeat.beat({ toolCalls: this.heartbeat.toolCalls + 1 });
      if (!this.toolInvoker) {
        throw Object.assign(new Error('No tool invoker is configured for this worker; check the V5 data directory and grants'), {
          code: 'TOOL_INVOKER_MISSING', retryable: false,
        });
      }
      await progress(progressLabel || `tool ${name} started`);
      this.#emit('tool.started', { taskId: task.id, tool: name, irreversible: irreversible === true });
      try {
        const result = await this.toolInvoker(name, args, {
          operationId: operationId || TaskQueue.operationId(task, name),
          signal: abort.signal,
        });
        this.#emit('tool.completed', { taskId: task.id, tool: name });
        await progress(`tool ${name} completed`);
        return result;
      } catch (error) {
        this.#emit('tool.failed', { taskId: task.id, tool: name, code: error.code || 'TOOL_FAILED' });
        await progress(`tool ${name} failed`);
        throw error;
      }
    };

    const ctx = {
      task, workerId: this.workerId, log: this.log, queue: this.queue, heartbeat: this.heartbeat,
      progress, callTool, signal: abort.signal, clock: this.clock,
      limits: this.limits,
    };

    const startedAt = this.clock();
    stallTimer = setInterval(() => {
      if (this.clock() - lastProgressAt > this.limits.stallMs) {
        this.stats.stalled += 1;
        this.#emit('watchdog.stalled', {
          taskId: task.id, silentMs: this.clock() - lastProgressAt, lastAction: currentAction,
          note: 'No tool or handler progress. Slow model thinking is not observable here; this is an execution stall.',
        });
        abort.abort(Object.assign(new Error('Task stalled without progress'), { code: 'WATCHDOG_STALL' }));
      }
    }, Math.max(25, Math.min(1000, Math.floor(this.limits.stallMs / 4))));

    heartbeatTimer = setInterval(() => {
      this.#emit('heartbeat', {
        taskId: task.id, action: currentAction, durationMs: this.clock() - startedAt,
        toolCalls: taskToolCalls,
      });
      this.heartbeat.beat({ lastAction: currentAction });
    }, Math.max(250, this.limits.heartbeatIntervalMs));

    let timeoutTimer;
    const timeout = new Promise((_, reject) => {
      timeoutTimer = setTimeout(() => {
        abort.abort(Object.assign(new Error('Task exceeded its time limit'), { code: 'TASK_TIMEOUT' }));
        reject(Object.assign(new Error('Task exceeded its time limit'), { code: 'TASK_TIMEOUT' }));
      }, this.limits.taskTimeoutMs);
    });
    const onAbort = () => rejectAborted(abort.signal.reason || Object.assign(new Error('Aborted'), { code: 'ABORTED' }));
    let rejectAborted = () => {};
    const aborted = new Promise((_, reject) => {
      rejectAborted = reject;
      abort.signal.addEventListener('abort', onAbort, { once: true });
    });

    try {
      const outcome = await Promise.race([Promise.resolve().then(() => handler(ctx)), timeout, aborted]);
      await this.#applyOutcome(task, outcome);
    } catch (error) {
      const code = error?.code || 'TASK_ERROR';
      const retryable = error?.retryable !== false && !['WATCHDOG_STALL', 'TASK_TIMEOUT'].includes(code);
      if (abort.signal.aborted && ['WATCHDOG_STALL', 'TASK_TIMEOUT'].includes(code)) {
        await this.queue.fail(task.id, { code, messageClass: 'watchdog', retryable: true, workerId: this.workerId });
        this.stats.failed += 1;
        this.heartbeat.beat({ tasksFailed: this.heartbeat.tasksFailed + 1 });
      } else {
        await this.queue.fail(task.id, {
          code, messageClass: error?.name === 'ZodError' ? 'validation' : 'handler-error',
          retryable, workerId: this.workerId, summary: String(error?.message || error).slice(0, 300),
        });
        this.stats.failed += 1;
        this.heartbeat.beat({ tasksFailed: this.heartbeat.tasksFailed + 1 });
      }
    } finally {
      clearInterval(stallTimer);
      clearInterval(heartbeatTimer);
      clearTimeout(timeoutTimer);
      abort.signal.removeEventListener('abort', onAbort);
      this.heartbeat.beat({ currentTaskId: null, state: 'ACTIVE', lastAction: `${task.kind} finished` });
    }
  }

  async #applyOutcome(task, outcome) {
    if (this.#stopRequested()) {
      // A graceful stop does not create an uncertain claim: the handler
      // finished, so the result is applied before leaving.
    }
    if (!outcome || typeof outcome !== 'object') {
      await this.queue.fail(task.id, {
        code: 'HANDLER_NO_RESULT', messageClass: 'handler-contract', retryable: false,
        workerId: this.workerId, summary: 'Handler returned no structured result',
      });
      this.stats.failed += 1;
      this.heartbeat.beat({ tasksFailed: this.heartbeat.tasksFailed + 1 });
      return;
    }
    if (outcome.blocked) {
      const blocked = outcome.blocked;
      await this.queue.block(task.id, {
        code: blocked.code || 'BLOCKED',
        reason: String(blocked.reason || 'Blocked').slice(0, 500),
        requiresOwner: blocked.requiresOwner === true,
        workerId: this.workerId,
      });
      this.stats.blocked += 1;
      this.heartbeat.beat({ tasksBlocked: this.heartbeat.tasksBlocked + 1 });
      return;
    }
    if (outcome.uncertain) {
      await this.queue.uncertain(task.id, {
        code: outcome.uncertain.code || 'UNCERTAIN',
        reason: String(outcome.uncertain.reason || 'External outcome unknown').slice(0, 500),
        workerId: this.workerId,
      });
      this.stats.uncertain += 1;
      return;
    }
    if (outcome.ok === false) {
      await this.queue.fail(task.id, {
        code: outcome.error?.code || 'TASK_FAILED',
        messageClass: outcome.error?.messageClass || 'handler-error',
        retryable: outcome.retryable !== false,
        workerId: this.workerId, summary: outcome.summary || null,
      });
      this.stats.failed += 1;
      this.heartbeat.beat({ tasksFailed: this.heartbeat.tasksFailed + 1 });
      return;
    }
    await this.queue.complete(task.id, {
      workerId: this.workerId,
      summary: outcome.summary || `Completed ${task.kind}`,
      receipt: outcome.receipt || null,
      evidence: outcome.evidence || null,
    });
    this.stats.completed += 1;
    this.heartbeat.beat({ tasksCompleted: this.heartbeat.tasksCompleted + 1 });
  }
}

/** In-memory handler registry; extension point for job/tool handlers. */
export function createHandlers(map = {}) {
  const handlers = new Map(Object.entries(map));
  return {
    register(kind, fn) {
      if (typeof fn !== 'function') throw new Error('Handler must be a function');
      handlers.set(kind, fn);
      return fn;
    },
    get: (kind) => handlers.get(kind),
    has: (kind) => handlers.has(kind),
    kinds: () => [...handlers.keys()].sort(),
    map: () => handlers,
    [Symbol.iterator]: () => handlers.entries(),
  };
}

export { clampInt };
