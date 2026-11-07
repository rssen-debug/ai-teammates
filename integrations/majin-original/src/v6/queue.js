/**
 * MAJIN V6 — durable task queue.
 *
 * One JSON state file, one writer at a time, atomic replacement. None of the
 * orchestration state lives in a terminal window or in model context.
 *
 * Invariants:
 *  - a RUNNING task always has a lease; an expired lease is recoverable;
 *  - an irreversible task is never replayed after an uncertain outcome;
 *  - an effect key can only be claimed by one live task at a time;
 *  - a completed effect is never executed twice.
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, ensureDir, newId, nowIso, readJson, sha256, sleep } from './util.js';

export const QUEUE_SCHEMA = 'majin.v6.queue/v1';

export const TASK_STATES = Object.freeze([
  'QUEUED', 'RUNNING', 'COMPLETED', 'BLOCKED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'UNCERTAIN', 'CANCELLED',
]);

export const TERMINAL_STATES = Object.freeze(['COMPLETED', 'FAILED_FINAL', 'CANCELLED']);
export const ACTIVE_STATES = Object.freeze(['QUEUED', 'RUNNING', 'FAILED_RETRYABLE']);

const KIND_PATTERN = /^[a-z][a-z0-9_.-]{1,60}$/;

function emptyState(clock) {
  return {
    schema: QUEUE_SCHEMA,
    version: 1,
    createdAt: nowIso(clock),
    updatedAt: nowIso(clock),
    seq: 0,
    tasks: [],
    effects: {},
    budget: {
      maxTasks: 100,
      maxRuntimeMs: 30 * 60 * 1000,
      maxToolCalls: 200,
      maxAttempts: 3,
      backoffMs: 5000,
    },
  };
}

function publicTask(task) {
  if (!task) return null;
  return { ...task, payload: task.payload ? structuredClone(task.payload) : {} };
}

export class TaskQueue {
  constructor({ file, log = null, clock = Date.now, lockTimeoutMs = 5000, lockStaleMs = 30000 } = {}) {
    if (!file) throw new Error('TaskQueue requires a state file');
    this.file = path.resolve(file);
    this.log = log;
    this.clock = clock;
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockStaleMs = lockStaleMs;
    ensureDir(path.dirname(this.file));
  }

  #emit(type, data) {
    if (!this.log) return;
    try { this.log.append(type, data); } catch { /* observability must not break durable work */ }
  }

  async #withLock(fn) {
    const lockDir = `${this.file}.lock`;
    const deadline = this.clock() + this.lockTimeoutMs;
    let held = false;
    while (!held) {
      try {
        fs.mkdirSync(lockDir, { mode: 0o700 });
        fs.writeFileSync(path.join(lockDir, 'owner'), JSON.stringify({ pid: process.pid, at: nowIso(this.clock) }), { mode: 0o600 });
        held = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const stat = fs.statSync(lockDir);
          if (this.clock() - stat.mtimeMs > this.lockStaleMs) {
            // A crashed holder cannot be trusted to release; stale data is
            // still repaired by recoverExpired(), never replayed blindly.
            fs.rmSync(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch { /* lock disappeared between attempts */ }
        if (this.clock() > deadline) {
          throw Object.assign(new Error('Timed out waiting for the V6 queue lock'), { code: 'QUEUE_LOCK_TIMEOUT' });
        }
        await sleep(15);
      }
    }
    try {
      const state = readJson(this.file, emptyState(this.clock));
      if (!state || !Array.isArray(state.tasks)) throw Object.assign(new Error('Queue state is not recognisable'), { code: 'STATE_CORRUPT' });
      const next = await fn(state);
      state.updatedAt = nowIso(this.clock);
      atomicWriteJson(this.file, state);
      return next;
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }

  #find(state, id) {
    const task = state.tasks.find((item) => item.id === id);
    if (!task) throw Object.assign(new Error(`Unknown task ${id}`), { code: 'TASK_NOT_FOUND' });
    return task;
  }

  #depsSatisfied(state, task) {
    const deps = (task.deps || []).map((id) => state.tasks.find((item) => item.id === id)).filter(Boolean);
    return deps.every((dep) => dep.state === 'COMPLETED');
  }

  #depBlocked(state, task) {
    return (task.deps || [])
      .map((id) => state.tasks.find((item) => item.id === id))
      .filter((dep) => dep && ['FAILED_FINAL', 'BLOCKED', 'UNCERTAIN', 'CANCELLED'].includes(dep.state));
  }

  async add(input = {}) {
    const kind = String(input.kind || '').trim();
    if (!KIND_PATTERN.test(kind)) throw Object.assign(new Error('Task kind must be lowercase letters, digits, dot, dash or underscore'), { code: 'TASK_KIND_INVALID' });
    return this.#withLock((state) => {
      const dedupeKey = input.dedupeKey == null ? null : String(input.dedupeKey).slice(0, 200);
      if (dedupeKey) {
        const duplicate = state.tasks.find((task) => task.dedupeKey === dedupeKey && !['COMPLETED', 'CANCELLED', 'FAILED_FINAL'].includes(task.state));
        if (duplicate) {
          this.#emit('task.deduplicated', { taskId: duplicate.id, workerId: input.workerId || null, kind, dedupeKey, state: duplicate.state });
          return { task: publicTask(duplicate), deduplicated: true };
        }
      }
      const now = nowIso(this.clock);
      const task = {
        schema: 'majin.v6.task/v1',
        id: newId('tsk', this.clock),
        kind,
        title: String(input.title || kind).slice(0, 200),
        payload: input.payload && typeof input.payload === 'object' ? structuredClone(input.payload) : {},
        state: 'QUEUED',
        priority: Number.isFinite(Number(input.priority)) ? Math.trunc(Number(input.priority)) : 0,
        deps: Array.isArray(input.deps) ? [...new Set(input.deps.map(String))] : [],
        dedupeKey,
        effectKey: input.effectKey == null ? null : String(input.effectKey).slice(0, 200),
        irreversible: input.irreversible === true,
        attempts: 0,
        maxAttempts: Math.max(1, Math.min(10, Number(input.maxAttempts) || state.budget.maxAttempts || 3)),
        notBefore: input.notBefore || now,
        lease: null,
        progress: null,
        lastError: null,
        blocked: null,
        result: null,
        history: [{ at: now, state: 'QUEUED', by: input.by || 'owner' }],
        createdAt: now,
        updatedAt: now,
      };
      state.tasks.push(task);
      state.seq += 1;
      this.#emit('task.queued', { taskId: task.id, kind: task.kind, state: task.state, priority: task.priority, dedupeKey });
      return { task: publicTask(task), deduplicated: false };
    });
  }

  async addMany(inputs = []) {
    return this.#withLock((state) => {
      const created = [];
      for (const input of inputs) {
        // addMany is used by the CLI/worker bootstrap; nested locking is not
        // possible, so this is the only copy of the insert logic that skips it.
        const kind = String(input.kind || '').trim();
        if (!KIND_PATTERN.test(kind)) continue;
        const now = nowIso(this.clock);
        const task = {
          schema: 'majin.v6.task/v1', id: newId('tsk', this.clock), kind,
          title: String(input.title || kind).slice(0, 200), payload: structuredClone(input.payload || {}),
          state: 'QUEUED', priority: Number(input.priority) || 0, deps: Array.isArray(input.deps) ? input.deps.map(String) : [],
          dedupeKey: input.dedupeKey == null ? null : String(input.dedupeKey).slice(0, 200),
          effectKey: input.effectKey == null ? null : String(input.effectKey).slice(0, 200),
          irreversible: input.irreversible === true, attempts: 0,
          maxAttempts: Math.max(1, Math.min(10, Number(input.maxAttempts) || state.budget.maxAttempts || 3)),
          notBefore: input.notBefore || now, lease: null, progress: null, lastError: null, blocked: null, result: null,
          history: [{ at: now, state: 'QUEUED', by: input.by || 'owner' }], createdAt: now, updatedAt: now,
        };
        state.tasks.push(task);
        created.push(publicTask(task));
        this.#emit('task.queued', { taskId: task.id, kind, state: task.state });
      }
      return created;
    });
  }

  async get(id) {
    return this.#withLock((state) => {
      const task = state.tasks.find((item) => item.id === id);
      return task ? publicTask(task) : null;
    });
  }

  async list({ state = null, kind = null, limit = 200 } = {}) {
    return this.#withLock((current) => current.tasks
      .filter((task) => (!state || task.state === state) && (!kind || task.kind === kind))
      .slice(0, Math.max(1, limit))
      .map(publicTask));
  }

  async stats() {
    return this.#withLock((state) => {
      const byState = Object.fromEntries(TASK_STATES.map((name) => [name, 0]));
      const byKind = {};
      for (const task of state.tasks) {
        byState[task.state] = (byState[task.state] || 0) + 1;
        byKind[task.kind] = (byKind[task.kind] || 0) + 1;
      }
      return { total: state.tasks.length, byState, byKind, effects: Object.keys(state.effects).length, updatedAt: state.updatedAt };
    });
  }

  async setBudget(patch = {}) {
    return this.#withLock((state) => {
      for (const key of ['maxTasks', 'maxRuntimeMs', 'maxToolCalls', 'maxAttempts', 'backoffMs']) {
        if (Number.isFinite(Number(patch[key]))) state.budget[key] = Math.max(1, Math.trunc(Number(patch[key])));
      }
      return { ...state.budget };
    });
  }

  async budget() {
    return this.#withLock((state) => ({ ...state.budget }));
  }

  async #settleLedger(state) {
    const changed = [];
    for (const task of state.tasks) {
      if (!task.effectKey) continue;
      if (!['QUEUED', 'FAILED_RETRYABLE'].includes(task.state)) continue;
      const effect = state.effects[task.effectKey];
      if (!effect) continue;
      if (effect.state === 'completed') {
        task.state = 'COMPLETED'; task.updatedAt = nowIso(this.clock);
        task.result = { summary: 'Skipped: this external effect was already completed by another task.', deduplicated: true, receipt: effect.receipt || null };
        task.history.push({ at: task.updatedAt, state: 'COMPLETED', by: 'v6-dedupe' });
        this.#emit('task.deduplicated', { taskId: task.id, effectKey: task.effectKey });
        changed.push(task.id);
      } else if (effect.state === 'uncertain' && effect.taskId !== task.id) {
        task.state = 'UNCERTAIN'; task.updatedAt = nowIso(this.clock);
        task.blocked = { code: 'EFFECT_UNCERTAIN', reason: 'Another task has an uncertain outcome for the same external effect; reconcile before retrying.', requiresOwner: true };
        task.lease = null;
        task.history.push({ at: task.updatedAt, state: 'UNCERTAIN', by: 'v6-dedupe' });
        this.#emit('task.uncertain', { taskId: task.id, effectKey: task.effectKey, code: 'EFFECT_UNCERTAIN' });
        changed.push(task.id);
      }
    }
    return changed;
  }

  /** Recover leases lost to a crash and dependency chains that can never run. */
  async recoverExpired({ now = this.clock() } = {}) {
    const nowTime = new Date(now).getTime();
    return this.#withLock((state) => {
      const recovered = [];
      for (const task of state.tasks) {
        if (task.state === 'QUEUED' || task.state === 'FAILED_RETRYABLE') {
          const blocked = this.#depBlocked(state, task);
          if (blocked.length) {
            task.state = 'BLOCKED';
            task.blocked = { code: 'DEPENDENCY_BLOCKED', reason: `Dependency ${blocked[0].id} is ${blocked[0].state}`, requiresOwner: false };
            task.updatedAt = nowIso(this.clock);
            task.history.push({ at: task.updatedAt, state: 'BLOCKED', by: 'v6-recovery' });
            this.#emit('task.blocked', { taskId: task.id, code: 'DEPENDENCY_BLOCKED', requiresOwner: false });
            recovered.push({ id: task.id, action: 'DEPENDENCY_BLOCKED' });
          }
        }
        if (task.state !== 'RUNNING' || !task.lease) continue;
        if (new Date(task.lease.expiresAt).getTime() > nowTime) continue;
        const wasIrreversible = task.irreversible === true;
        task.lease = null;
        task.updatedAt = nowIso(this.clock);
        if (wasIrreversible) {
          task.state = 'UNCERTAIN';
          task.blocked = {
            code: 'WORKER_LOST_IRREVERSIBLE',
            reason: 'The worker stopped while performing an irreversible action. Its external outcome is unknown; reconcile before any retry.',
            requiresOwner: true,
          };
          if (task.effectKey) state.effects[task.effectKey] = { state: 'uncertain', taskId: task.id, at: task.updatedAt };
          this.#emit('task.uncertain', { taskId: task.id, code: 'WORKER_LOST_IRREVERSIBLE', requiresOwner: true });
        } else if (task.attempts >= task.maxAttempts) {
          task.state = 'FAILED_FINAL';
          task.lastError = { code: 'WORKER_LOST', messageClass: 'lease-expired' };
          this.#emit('task.failed', { taskId: task.id, code: 'WORKER_LOST', final: true });
        } else {
          task.state = 'FAILED_RETRYABLE';
          task.lastError = { code: 'WORKER_LOST', messageClass: 'lease-expired' };
          task.notBefore = nowIso(this.clock);
          this.#emit('task.recovered', { taskId: task.id, code: 'WORKER_LOST', attempts: task.attempts });
        }
        task.history.push({ at: task.updatedAt, state: task.state, by: 'v6-recovery' });
        recovered.push({ id: task.id, action: task.state });
      }
      if (recovered.length) state.seq += 1;
      return recovered;
    });
  }

  async claim({ workerId, now = this.clock(), leaseMs = 60000 } = {}) {
    return this.#withLock((state) => {
      this.#settleLedger(state);
      const nowTime = new Date(now).getTime();
      const candidates = state.tasks
        .filter((task) => ['QUEUED', 'FAILED_RETRYABLE'].includes(task.state))
        .filter((task) => new Date(task.notBefore).getTime() <= nowTime)
        .filter((task) => this.#depsSatisfied(state, task))
        .sort((a, b) => (b.priority - a.priority) || String(a.createdAt).localeCompare(String(b.createdAt)));
      const task = candidates[0];
      if (!task) return null;
      if (task.effectKey) {
        const effect = state.effects[task.effectKey];
        if (effect && effect.taskId !== task.id && effect.state === 'claimed') {
          task.state = 'BLOCKED';
          task.blocked = { code: 'EFFECT_OWNED_ELSEWHERE', reason: `Effect is owned by task ${effect.taskId}`, requiresOwner: false };
          task.updatedAt = nowIso(this.clock);
          task.history.push({ at: task.updatedAt, state: 'BLOCKED', by: 'v6-queue' });
          this.#emit('task.blocked', { taskId: task.id, code: 'EFFECT_OWNED_ELSEWHERE' });
          return null;
        }
        if (!effect) state.effects[task.effectKey] = { state: 'claimed', taskId: task.id, at: nowIso(this.clock) };
      }
      task.state = 'RUNNING';
      task.attempts += 1;
      task.lease = { workerId, startedAt: nowIso(this.clock), expiresAt: new Date(nowTime + leaseMs).toISOString() };
      task.progress = { lastActionAt: nowIso(this.clock), lastAction: 'claimed', toolCalls: 0 };
      task.updatedAt = nowIso(this.clock);
      task.history.push({ at: task.updatedAt, state: 'RUNNING', by: workerId, attempt: task.attempts });
      state.seq += 1;
      this.#emit('task.claimed', { taskId: task.id, workerId, kind: task.kind, attempt: task.attempts });
      return publicTask(task);
    });
  }

  async heartbeat(id, { workerId = null, action = 'working', toolCall = null, now = this.clock(), leaseMs = 60000 } = {}) {
    return this.#withLock((state) => {
      const task = this.#find(state, id);
      if (task.state !== 'RUNNING') throw Object.assign(new Error(`Task ${id} is ${task.state}, not RUNNING`), { code: 'TASK_NOT_RUNNING' });
      if (workerId && task.lease && task.lease.workerId !== workerId) {
        throw Object.assign(new Error('Task lease belongs to another worker'), { code: 'TASK_LEASE_CONFLICT' });
      }
      task.lease = { ...(task.lease || {}), workerId: workerId || task.lease?.workerId || null, expiresAt: new Date(new Date(now).getTime() + leaseMs).toISOString() };
      task.progress = {
        lastActionAt: nowIso(this.clock()),
        lastAction: String(action).slice(0, 120),
        toolCalls: (task.progress?.toolCalls || 0) + (toolCall ? 1 : 0),
        ...(toolCall ? { lastTool: String(toolCall).slice(0, 120) } : {}),
      };
      task.updatedAt = nowIso(this.clock);
      this.#emit('task.progress', { taskId: id, workerId: workerId || null, action: task.progress.lastAction, toolCalls: task.progress.toolCalls });
      return publicTask(task);
    });
  }

  #finish(state, task, nextState, { by = 'v6-supervisor', summary = null, receipt = null, evidence = null, error = null, blocked = null, progress = null } = {}) {
    task.state = nextState;
    task.lease = null;
    task.updatedAt = nowIso(this.clock);
    if (progress) task.progress = { ...(task.progress || {}), ...progress };
    if (summary != null) task.result = { ...(task.result || {}), summary, ...(receipt ? { receipt } : {}), ...(evidence ? { evidence } : {}) };
    if (error) task.lastError = error;
    task.blocked = blocked || null;
    task.history.push({ at: task.updatedAt, state: nextState, by });
    if (task.effectKey) {
      if (nextState === 'COMPLETED') {
        state.effects[task.effectKey] = { state: 'completed', taskId: task.id, at: task.updatedAt, receipt: receipt || null };
      } else if (nextState === 'UNCERTAIN') {
        state.effects[task.effectKey] = { state: 'uncertain', taskId: task.id, at: task.updatedAt, code: error?.code || 'UNCERTAIN' };
      }
    }
    state.seq += 1;
    return publicTask(task);
  }

  async complete(id, details = {}) {
    return this.#withLock((state) => {
      const task = this.#find(state, id);
      if (task.state !== 'RUNNING') throw Object.assign(new Error(`Task ${id} is ${task.state}, not RUNNING`), { code: 'TASK_NOT_RUNNING' });
      const done = this.#finish(state, task, 'COMPLETED', details);
      this.#emit('task.completed', { taskId: id, workerId: details.workerId || null, summary: details.summary || null });
      if (details.receipt) this.#emit('receipt.observed', { taskId: id, receiptRef: details.receipt.reference || null });
      return done;
    });
  }

  async fail(id, { code = 'TASK_FAILED', messageClass = 'handler-error', retryable = true, workerId = null, summary = null } = {}) {
    return this.#withLock((state) => {
      const task = this.#find(state, id);
      if (task.state !== 'RUNNING') throw Object.assign(new Error(`Task ${id} is ${task.state}, not RUNNING`), { code: 'TASK_NOT_RUNNING' });
      const exhausted = !retryable || task.attempts >= task.maxAttempts;
      const next = exhausted ? 'FAILED_FINAL' : 'FAILED_RETRYABLE';
      if (!exhausted) {
        const backoff = Math.min(15 * 60 * 1000, (state.budget.backoffMs || 5000) * (2 ** Math.max(0, task.attempts - 1)));
        task.notBefore = new Date(this.clock() + backoff).toISOString();
      }
      const done = this.#finish(state, task, next, { by: workerId || 'v6-supervisor', error: { code, messageClass }, summary });
      this.#emit('task.failed', { taskId: id, workerId, code, messageClass, final: exhausted, attempt: task.attempts });
      return done;
    });
  }

  async block(id, { code = 'BLOCKED', reason = 'Blocked', requiresOwner = false, workerId = null } = {}) {
    return this.#withLock((state) => {
      const task = this.#find(state, id);
      if (!['RUNNING', 'QUEUED', 'FAILED_RETRYABLE'].includes(task.state)) {
        throw Object.assign(new Error(`Task ${id} is ${task.state} and cannot be blocked`), { code: 'TASK_STATE_INVALID' });
      }
      const done = this.#finish(state, task, 'BLOCKED', { by: workerId || 'v6-supervisor', blocked: { code, reason, requiresOwner: requiresOwner === true } });
      this.#emit('task.blocked', { taskId: id, workerId, code, requiresOwner: requiresOwner === true });
      if (requiresOwner) this.#emit('permission.blocked', { taskId: id, code });
      return done;
    });
  }

  async uncertain(id, { code = 'UNCERTAIN', reason = 'External outcome unknown', workerId = null } = {}) {
    return this.#withLock((state) => {
      const task = this.#find(state, id);
      if (task.state !== 'RUNNING') throw Object.assign(new Error(`Task ${id} is ${task.state}, not RUNNING`), { code: 'TASK_NOT_RUNNING' });
      const done = this.#finish(state, task, 'UNCERTAIN', {
        by: workerId || 'v6-supervisor',
        blocked: { code, reason, requiresOwner: true },
        error: { code, messageClass: 'uncertain-outcome' },
      });
      this.#emit('task.uncertain', { taskId: id, workerId, code, requiresOwner: true });
      return done;
    });
  }

  async cancel(id, { by = 'owner' } = {}) {
    return this.#withLock((state) => {
      const task = this.#find(state, id);
      if (TERMINAL_STATES.includes(task.state)) throw Object.assign(new Error(`Task ${id} is already ${task.state}`), { code: 'TASK_STATE_INVALID' });
      const done = this.#finish(state, task, 'CANCELLED', { by });
      this.#emit('task.cancelled', { taskId: id, by });
      return done;
    });
  }

  /** Owner-only requeue. UNCERTAIN requires an explicit reconciled outcome first. */
  async requeue(id, { by = 'owner' } = {}) {
    return this.#withLock((state) => {
      const task = this.#find(state, id);
      // There is deliberately no bypass: an uncertain external effect must be
      // reconciled through resolveUncertain() with evidence.
      if (task.state === 'UNCERTAIN') {
        throw Object.assign(new Error('Uncertain tasks cannot be requeued; reconcile the external outcome first'), { code: 'TASK_UNCERTAIN_RETRY_REFUSED' });
      }
      if (!['FAILED_RETRYABLE', 'FAILED_FINAL', 'BLOCKED'].includes(task.state)) {
        throw Object.assign(new Error(`Task ${id} is ${task.state} and cannot be requeued`), { code: 'TASK_STATE_INVALID' });
      }
      task.state = 'QUEUED';
      task.notBefore = nowIso(this.clock());
      task.attempts = 0;
      task.blocked = null;
      task.lastError = null;
      task.updatedAt = nowIso(this.clock());
      task.history.push({ at: task.updatedAt, state: 'QUEUED', by, note: 'owner requeue' });
      this.#emit('task.queued', { taskId: id, by, requeued: true });
      return publicTask(task);
    });
  }

  async resolveUncertain(id, { outcome, evidence = null, by = 'owner' } = {}) {
    if (!['confirmed', 'failed_final'].includes(outcome)) {
      throw Object.assign(new Error('outcome must be confirmed or failed_final'), { code: 'RECONCILE_OUTCOME_INVALID' });
    }
    if (outcome === 'confirmed' && !evidence) {
      throw Object.assign(new Error('Confirming an uncertain outcome requires evidence'), { code: 'RECONCILE_EVIDENCE_REQUIRED' });
    }
    return this.#withLock((state) => {
      const task = this.#find(state, id);
      if (task.state !== 'UNCERTAIN') throw Object.assign(new Error(`Task ${id} is ${task.state}, not UNCERTAIN`), { code: 'TASK_STATE_INVALID' });
      const next = outcome === 'confirmed' ? 'COMPLETED' : 'FAILED_FINAL';
      const done = this.#finish(state, task, next, { by, summary: `Reconciled by owner as ${outcome}`, evidence });
      this.#emit(next === 'COMPLETED' ? 'task.completed' : 'task.failed', { taskId: id, by, reconciled: true, outcome });
      return done;
    });
  }

  async effect(key) {
    return this.#withLock((state) => state.effects[String(key)] || null);
  }

  async size() {
    return this.#withLock((state) => state.tasks.length);
  }

  /** Deterministic operation id for a task's effect; stable across restarts. */
  static operationId(task, suffix = '') {
    return `v6-${sha256({ taskId: task.id, effectKey: task.effectKey || null, suffix }).slice(0, 40)}`;
  }
}
