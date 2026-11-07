/**
 * Unified kernel — durable task queue.
 *
 * Ported from MAJIN V6 (`src/v6/queue.js`). One JSON state file, one writer at
 * a time, atomic replacement. None of the orchestration state lives in a
 * terminal window or in model context.
 *
 * Invariants:
 *  - a RUNNING task always has a lease; an expired lease is recoverable;
 *  - an irreversible task is never replayed after an uncertain outcome;
 *  - an effect key can only be claimed by one live task at a time;
 *  - a completed effect is never executed twice.
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, ensureDir, errorCode, nowIso, readJson, sha256, sleep, type Clock } from './util.js';
import type { EventLog } from './events.js';

export const QUEUE_SCHEMA = 'studdy.kernel.queue/v1';

export const TASK_STATES = Object.freeze([
  'QUEUED', 'RUNNING', 'COMPLETED', 'BLOCKED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'UNCERTAIN', 'CANCELLED',
] as const);

export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_STATES: readonly TaskState[] = Object.freeze(['COMPLETED', 'FAILED_FINAL', 'CANCELLED']);
export const ACTIVE_STATES: readonly TaskState[] = Object.freeze(['QUEUED', 'RUNNING', 'FAILED_RETRYABLE']);

const KIND_PATTERN = /^[a-z][a-z0-9_.-]{1,60}$/;

export interface TaskLease {
  workerId: string;
  startedAt: string;
  expiresAt: string;
}

export interface TaskProgress {
  lastActionAt: string;
  lastAction: string;
  toolCalls: number;
  lastTool?: string;
}

export interface TaskHistoryEntry {
  at: string;
  state: TaskState;
  by: string;
  attempt?: number;
  note?: string;
}

export interface TaskError {
  code: string;
  messageClass: string;
}

export interface TaskBlocked {
  code: string;
  reason: string;
  requiresOwner: boolean;
}

export interface TaskResult {
  summary?: string;
  receipt?: unknown;
  evidence?: unknown;
  deduplicated?: boolean;
}

export interface KernelTask {
  schema: string;
  id: string;
  kind: string;
  title: string;
  payload: Record<string, unknown>;
  state: TaskState;
  priority: number;
  deps: string[];
  dedupeKey: string | null;
  effectKey: string | null;
  irreversible: boolean;
  attempts: number;
  maxAttempts: number;
  notBefore: string;
  lease: TaskLease | null;
  progress: TaskProgress | null;
  lastError: TaskError | null;
  blocked: TaskBlocked | null;
  result: TaskResult | null;
  history: TaskHistoryEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface EffectsLedgerEntry {
  state: 'claimed' | 'completed' | 'uncertain';
  taskId: string;
  at: string;
  receipt?: unknown;
  code?: string;
}

export interface QueueBudget {
  maxTasks: number;
  maxRuntimeMs: number;
  maxToolCalls: number;
  maxAttempts: number;
  backoffMs: number;
}

export interface QueueState {
  schema: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  seq: number;
  tasks: KernelTask[];
  effects: Record<string, EffectsLedgerEntry>;
  budget: QueueBudget;
}

export interface AddTaskInput {
  kind: string;
  title?: string;
  payload?: Record<string, unknown>;
  priority?: number;
  deps?: string[];
  dedupeKey?: string | null;
  effectKey?: string | null;
  irreversible?: boolean;
  maxAttempts?: number;
  notBefore?: string;
  by?: string;
  workerId?: string;
}

export interface QueueStats {
  total: number;
  byState: Record<TaskState, number>;
  byKind: Record<string, number>;
  effects: number;
  updatedAt: string;
}

export interface TaskQueueOptions {
  file: string;
  log?: EventLog | null;
  clock?: Clock;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
}

function emptyState(clock: Clock): QueueState {
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

function publicTask(task: KernelTask): KernelTask {
  return { ...task, payload: task.payload ? structuredClone(task.payload) : {} };
}

export class TaskQueue {
  readonly file: string;
  readonly log: EventLog | null;
  readonly clock: Clock;
  readonly lockTimeoutMs: number;
  readonly lockStaleMs: number;

  constructor({ file, log = null, clock = Date.now, lockTimeoutMs = 5000, lockStaleMs = 30_000 }: TaskQueueOptions) {
    if (!file) throw new Error('TaskQueue requires a state file');
    this.file = path.resolve(file);
    this.log = log;
    this.clock = clock;
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockStaleMs = lockStaleMs;
    ensureDir(path.dirname(this.file));
  }

  private emit(type: string, data: Record<string, unknown>): void {
    if (!this.log) return;
    try {
      this.log.append(type, data);
    } catch {
      /* observability must not break durable work */
    }
  }

  private async withLock<T>(fn: (state: QueueState) => Promise<T> | T): Promise<T> {
    const lockDir = `${this.file}.lock`;
    const deadline = this.clock() + this.lockTimeoutMs;
    let held = false;
    while (!held) {
      try {
        fs.mkdirSync(lockDir, { mode: 0o700 });
        fs.writeFileSync(
          path.join(lockDir, 'owner'),
          JSON.stringify({ pid: process.pid, at: nowIso(this.clock) }),
          { mode: 0o600 },
        );
        held = true;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        try {
          const stat = fs.statSync(lockDir);
          if (this.clock() - stat.mtimeMs > this.lockStaleMs) {
            // A crashed holder cannot be trusted to release; stale data is
            // still repaired by recoverExpired(), never replayed blindly.
            fs.rmSync(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch {
          /* lock disappeared between attempts */
        }
        if (this.clock() > deadline) {
          throw Object.assign(new Error('Timed out waiting for the kernel queue lock'), { code: 'QUEUE_LOCK_TIMEOUT' });
        }
        await sleep(15);
      }
    }
    try {
      const state = readJson<QueueState>(this.file, emptyState(this.clock));
      if (!state || !Array.isArray(state.tasks)) {
        throw Object.assign(new Error('Queue state is not recognisable'), { code: 'STATE_CORRUPT' });
      }
      if (!state.effects || typeof state.effects !== 'object') state.effects = {};
      const next = await fn(state);
      state.updatedAt = nowIso(this.clock);
      atomicWriteJson(this.file, state);
      return next;
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }

  private find(state: QueueState, id: string): KernelTask {
    const task = state.tasks.find((item) => item.id === id);
    if (!task) throw Object.assign(new Error(`Unknown task ${id}`), { code: 'TASK_NOT_FOUND' });
    return task;
  }

  private depsSatisfied(state: QueueState, task: KernelTask): boolean {
    const deps = (task.deps || []).map((id) => state.tasks.find((item) => item.id === id)).filter(Boolean) as KernelTask[];
    return deps.every((dep) => dep.state === 'COMPLETED');
  }

  private depBlocked(state: QueueState, task: KernelTask): KernelTask[] {
    const blocking: readonly TaskState[] = ['FAILED_FINAL', 'BLOCKED', 'UNCERTAIN', 'CANCELLED'];
    return (task.deps || [])
      .map((id) => state.tasks.find((item) => item.id === id))
      .filter((dep): dep is KernelTask => Boolean(dep && blocking.includes(dep.state)));
  }

  private buildTask(input: AddTaskInput, state: QueueState, kind: string): KernelTask {
    const now = nowIso(this.clock);
    return {
      schema: 'studdy.kernel.task/v1',
      id: `tsk_${this.clock().toString(36).padStart(9, '0')}_${Math.random().toString(36).slice(2, 10)}`,
      kind,
      title: String(input.title || kind).slice(0, 200),
      payload: input.payload && typeof input.payload === 'object' ? structuredClone(input.payload) : {},
      state: 'QUEUED',
      priority: Number.isFinite(Number(input.priority)) ? Math.trunc(Number(input.priority)) : 0,
      deps: Array.isArray(input.deps) ? [...new Set(input.deps.map(String))] : [],
      dedupeKey: input.dedupeKey == null ? null : String(input.dedupeKey).slice(0, 200),
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
  }

  async add(input: AddTaskInput): Promise<{ task: KernelTask; deduplicated: boolean }> {
    const kind = String(input.kind || '').trim();
    if (!KIND_PATTERN.test(kind)) {
      throw Object.assign(new Error('Task kind must be lowercase letters, digits, dot, dash or underscore'), {
        code: 'TASK_KIND_INVALID',
      });
    }
    return this.withLock((state) => {
      const dedupeKey = input.dedupeKey == null ? null : String(input.dedupeKey).slice(0, 200);
      if (dedupeKey) {
        const duplicate = state.tasks.find(
          (task) => task.dedupeKey === dedupeKey && !['COMPLETED', 'CANCELLED', 'FAILED_FINAL'].includes(task.state),
        );
        if (duplicate) {
          this.emit('task.deduplicated', {
            taskId: duplicate.id,
            workerId: input.workerId ?? null,
            kind,
            dedupeKey,
            state: duplicate.state,
          });
          return { task: publicTask(duplicate), deduplicated: true };
        }
      }
      const task = this.buildTask({ ...input, dedupeKey }, state, kind);
      state.tasks.push(task);
      state.seq += 1;
      this.emit('task.queued', {
        taskId: task.id,
        kind: task.kind,
        state: task.state,
        priority: task.priority,
        dedupeKey,
      });
      return { task: publicTask(task), deduplicated: false };
    });
  }

  async addMany(inputs: AddTaskInput[]): Promise<KernelTask[]> {
    return this.withLock((state) => {
      const created: KernelTask[] = [];
      for (const input of inputs) {
        // addMany is used by CLI/worker bootstrap; nested locking is not
        // possible, so this is the only copy of the insert logic that skips it.
        const kind = String(input.kind || '').trim();
        if (!KIND_PATTERN.test(kind)) continue;
        const task = this.buildTask(input, state, kind);
        state.tasks.push(task);
        created.push(publicTask(task));
        this.emit('task.queued', { taskId: task.id, kind, state: task.state });
      }
      return created;
    });
  }

  async get(id: string): Promise<KernelTask | null> {
    return this.withLock((state) => {
      const task = state.tasks.find((item) => item.id === id);
      return task ? publicTask(task) : null;
    });
  }

  async list({ state = null, kind = null, limit = 200 }: { state?: TaskState | null; kind?: string | null; limit?: number } = {}): Promise<KernelTask[]> {
    return this.withLock((current) => current.tasks
      .filter((task) => (!state || task.state === state) && (!kind || task.kind === kind))
      .slice(0, Math.max(1, limit))
      .map(publicTask));
  }

  async stats(): Promise<QueueStats> {
    return this.withLock((state) => {
      const byState = Object.fromEntries(TASK_STATES.map((name) => [name, 0])) as Record<TaskState, number>;
      const byKind: Record<string, number> = {};
      for (const task of state.tasks) {
        byState[task.state] = (byState[task.state] ?? 0) + 1;
        byKind[task.kind] = (byKind[task.kind] ?? 0) + 1;
      }
      return {
        total: state.tasks.length,
        byState,
        byKind,
        effects: Object.keys(state.effects).length,
        updatedAt: state.updatedAt,
      };
    });
  }

  async setBudget(patch: Partial<QueueBudget>): Promise<QueueBudget> {
    return this.withLock((state) => {
      for (const key of ['maxTasks', 'maxRuntimeMs', 'maxToolCalls', 'maxAttempts', 'backoffMs'] as const) {
        const value = patch[key];
        if (Number.isFinite(Number(value))) state.budget[key] = Math.max(1, Math.trunc(Number(value)));
      }
      return { ...state.budget };
    });
  }

  async budget(): Promise<QueueBudget> {
    return this.withLock((state) => ({ ...state.budget }));
  }

  private settleLedger(state: QueueState): string[] {
    const changed: string[] = [];
    for (const task of state.tasks) {
      if (!task.effectKey) continue;
      if (!['QUEUED', 'FAILED_RETRYABLE'].includes(task.state)) continue;
      const effect = state.effects[task.effectKey];
      if (!effect) continue;
      if (effect.state === 'completed') {
        task.state = 'COMPLETED';
        task.updatedAt = nowIso(this.clock);
        task.result = {
          summary: 'Skipped: this external effect was already completed by another task.',
          deduplicated: true,
          receipt: effect.receipt ?? null,
        };
        task.history.push({ at: task.updatedAt, state: 'COMPLETED', by: 'kernel-dedupe' });
        this.emit('task.deduplicated', { taskId: task.id, effectKey: task.effectKey });
        changed.push(task.id);
      } else if (effect.state === 'uncertain' && effect.taskId !== task.id) {
        task.state = 'UNCERTAIN';
        task.updatedAt = nowIso(this.clock);
        task.blocked = {
          code: 'EFFECT_UNCERTAIN',
          reason: 'Another task has an uncertain outcome for the same external effect; reconcile before retrying.',
          requiresOwner: true,
        };
        task.lease = null;
        task.history.push({ at: task.updatedAt, state: 'UNCERTAIN', by: 'kernel-dedupe' });
        this.emit('task.uncertain', { taskId: task.id, effectKey: task.effectKey, code: 'EFFECT_UNCERTAIN' });
        changed.push(task.id);
      }
    }
    return changed;
  }

  /** Recover leases lost to a crash and dependency chains that can never run. */
  async recoverExpired({ now = this.clock() }: { now?: number } = {}): Promise<{ id: string; action: string }[]> {
    const nowTime = now;
    return this.withLock((state) => {
      const recovered: { id: string; action: string }[] = [];
      for (const task of state.tasks) {
        if (task.state === 'QUEUED' || task.state === 'FAILED_RETRYABLE') {
          const blocked = this.depBlocked(state, task);
          const first = blocked[0];
          if (first) {
            task.state = 'BLOCKED';
            task.blocked = {
              code: 'DEPENDENCY_BLOCKED',
              reason: `Dependency ${first.id} is ${first.state}`,
              requiresOwner: false,
            };
            task.updatedAt = nowIso(this.clock);
            task.history.push({ at: task.updatedAt, state: 'BLOCKED', by: 'kernel-recovery' });
            this.emit('task.blocked', { taskId: task.id, code: 'DEPENDENCY_BLOCKED', requiresOwner: false });
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
          if (task.effectKey) {
            state.effects[task.effectKey] = { state: 'uncertain', taskId: task.id, at: task.updatedAt };
          }
          this.emit('task.uncertain', { taskId: task.id, code: 'WORKER_LOST_IRREVERSIBLE', requiresOwner: true });
        } else if (task.attempts >= task.maxAttempts) {
          task.state = 'FAILED_FINAL';
          task.lastError = { code: 'WORKER_LOST', messageClass: 'lease-expired' };
          this.emit('task.failed', { taskId: task.id, code: 'WORKER_LOST', final: true });
        } else {
          task.state = 'FAILED_RETRYABLE';
          task.lastError = { code: 'WORKER_LOST', messageClass: 'lease-expired' };
          task.notBefore = nowIso(this.clock);
          this.emit('task.recovered', { taskId: task.id, code: 'WORKER_LOST', attempts: task.attempts });
        }
        task.history.push({ at: task.updatedAt, state: task.state, by: 'kernel-recovery' });
        recovered.push({ id: task.id, action: task.state });
      }
      if (recovered.length) state.seq += 1;
      return recovered;
    });
  }

  async claim({ workerId, now = this.clock(), leaseMs = 60_000 }: { workerId: string; now?: number; leaseMs?: number }): Promise<KernelTask | null> {
    return this.withLock((state) => {
      this.settleLedger(state);
      const nowTime = now;
      const candidates = state.tasks
        .filter((task) => ['QUEUED', 'FAILED_RETRYABLE'].includes(task.state))
        .filter((task) => new Date(task.notBefore).getTime() <= nowTime)
        .filter((task) => this.depsSatisfied(state, task))
        .sort((a, b) => (b.priority - a.priority) || String(a.createdAt).localeCompare(String(b.createdAt)));
      const task = candidates[0];
      if (!task) return null;
      if (task.effectKey) {
        const effect = state.effects[task.effectKey];
        if (effect && effect.taskId !== task.id && effect.state === 'claimed') {
          task.state = 'BLOCKED';
          task.blocked = {
            code: 'EFFECT_OWNED_ELSEWHERE',
            reason: `Effect is owned by task ${effect.taskId}`,
            requiresOwner: false,
          };
          task.updatedAt = nowIso(this.clock);
          task.history.push({ at: task.updatedAt, state: 'BLOCKED', by: 'kernel-queue' });
          this.emit('task.blocked', { taskId: task.id, code: 'EFFECT_OWNED_ELSEWHERE' });
          return null;
        }
        if (!effect) state.effects[task.effectKey] = { state: 'claimed', taskId: task.id, at: nowIso(this.clock) };
      }
      task.state = 'RUNNING';
      task.attempts += 1;
      task.lease = {
        workerId,
        startedAt: nowIso(this.clock),
        expiresAt: new Date(nowTime + leaseMs).toISOString(),
      };
      task.progress = { lastActionAt: nowIso(this.clock), lastAction: 'claimed', toolCalls: 0 };
      task.updatedAt = nowIso(this.clock);
      task.history.push({ at: task.updatedAt, state: 'RUNNING', by: workerId, attempt: task.attempts });
      state.seq += 1;
      this.emit('task.claimed', { taskId: task.id, workerId, kind: task.kind, attempt: task.attempts });
      return publicTask(task);
    });
  }

  async heartbeat(id: string, { workerId = null, action = 'working', toolCall = null, now = this.clock(), leaseMs = 60_000 }: {
    workerId?: string | null;
    action?: string;
    toolCall?: string | null;
    now?: number;
    leaseMs?: number;
  } = {}): Promise<KernelTask> {
    return this.withLock((state) => {
      const task = this.find(state, id);
      if (task.state !== 'RUNNING') {
        throw Object.assign(new Error(`Task ${id} is ${task.state}, not RUNNING`), { code: 'TASK_NOT_RUNNING' });
      }
      if (workerId && task.lease && task.lease.workerId !== workerId) {
        throw Object.assign(new Error('Task lease belongs to another worker'), { code: 'TASK_LEASE_CONFLICT' });
      }
      task.lease = {
        ...(task.lease ?? { workerId: workerId || 'unknown', startedAt: nowIso(this.clock) }),
        workerId: workerId || task.lease?.workerId || 'unknown',
        expiresAt: new Date(now + leaseMs).toISOString(),
      };
      const previous = task.progress ?? { lastActionAt: nowIso(this.clock), lastAction: 'claimed', toolCalls: 0 };
      task.progress = {
        lastActionAt: nowIso(this.clock),
        lastAction: String(action).slice(0, 120),
        toolCalls: (previous.toolCalls || 0) + (toolCall ? 1 : 0),
        ...(toolCall ? { lastTool: String(toolCall).slice(0, 120) } : {}),
      };
      task.updatedAt = nowIso(this.clock);
      this.emit('task.progress', {
        taskId: id,
        workerId: workerId || null,
        action: task.progress.lastAction,
        toolCalls: task.progress.toolCalls,
      });
      return publicTask(task);
    });
  }

  private finish(state: QueueState, task: KernelTask, nextState: TaskState, {
    by = 'kernel-supervisor',
    summary = null,
    receipt = null,
    evidence = null,
    error = null,
    blocked = null,
    progress = null,
  }: {
    by?: string;
    summary?: string | null;
    receipt?: unknown;
    evidence?: unknown;
    error?: TaskError | null;
    blocked?: TaskBlocked | null;
    progress?: Partial<TaskProgress> | null;
  } = {}): KernelTask {
    task.state = nextState;
    task.lease = null;
    task.updatedAt = nowIso(this.clock);
    if (progress) task.progress = { ...(task.progress ?? { lastActionAt: task.updatedAt, lastAction: 'unknown', toolCalls: 0 }), ...progress };
    if (summary != null) {
      task.result = {
        ...(task.result ?? {}),
        summary,
        ...(receipt ? { receipt } : {}),
        ...(evidence ? { evidence } : {}),
      };
    }
    if (error) task.lastError = error;
    task.blocked = blocked || null;
    task.history.push({ at: task.updatedAt, state: nextState, by });
    if (task.effectKey) {
      if (nextState === 'COMPLETED') {
        state.effects[task.effectKey] = { state: 'completed', taskId: task.id, at: task.updatedAt, receipt: receipt ?? null };
      } else if (nextState === 'UNCERTAIN') {
        state.effects[task.effectKey] = {
          state: 'uncertain',
          taskId: task.id,
          at: task.updatedAt,
          code: error?.code ?? 'UNCERTAIN',
        };
      }
    }
    state.seq += 1;
    return publicTask(task);
  }

  async complete(id: string, details: { workerId?: string | null; summary?: string | null; receipt?: unknown; evidence?: unknown } = {}): Promise<KernelTask> {
    return this.withLock((state) => {
      const task = this.find(state, id);
      if (task.state !== 'RUNNING') {
        throw Object.assign(new Error(`Task ${id} is ${task.state}, not RUNNING`), { code: 'TASK_NOT_RUNNING' });
      }
      const done = this.finish(state, task, 'COMPLETED', details);
      this.emit('task.completed', { taskId: id, workerId: details.workerId ?? null, summary: details.summary ?? null });
      const receipt = details.receipt as { reference?: string } | null | undefined;
      if (receipt) this.emit('receipt.observed', { taskId: id, receiptRef: receipt.reference ?? null });
      return done;
    });
  }

  async fail(id: string, { code = 'TASK_FAILED', messageClass = 'handler-error', retryable = true, workerId = null, summary = null }: {
    code?: string;
    messageClass?: string;
    retryable?: boolean;
    workerId?: string | null;
    summary?: string | null;
  } = {}): Promise<KernelTask> {
    return this.withLock((state) => {
      const task = this.find(state, id);
      if (task.state !== 'RUNNING') {
        throw Object.assign(new Error(`Task ${id} is ${task.state}, not RUNNING`), { code: 'TASK_NOT_RUNNING' });
      }
      const exhausted = !retryable || task.attempts >= task.maxAttempts;
      const next: TaskState = exhausted ? 'FAILED_FINAL' : 'FAILED_RETRYABLE';
      if (!exhausted) {
        const backoff = Math.min(15 * 60 * 1000, (state.budget.backoffMs || 5000) * (2 ** Math.max(0, task.attempts - 1)));
        task.notBefore = new Date(this.clock() + backoff).toISOString();
      }
      const done = this.finish(state, task, next, { by: workerId || 'kernel-supervisor', error: { code, messageClass }, summary });
      this.emit('task.failed', { taskId: id, workerId, code, messageClass, final: exhausted, attempt: task.attempts });
      return done;
    });
  }

  async block(id: string, { code = 'BLOCKED', reason = 'Blocked', requiresOwner = false, workerId = null }: {
    code?: string;
    reason?: string;
    requiresOwner?: boolean;
    workerId?: string | null;
  } = {}): Promise<KernelTask> {
    return this.withLock((state) => {
      const task = this.find(state, id);
      if (!['RUNNING', 'QUEUED', 'FAILED_RETRYABLE'].includes(task.state)) {
        throw Object.assign(new Error(`Task ${id} is ${task.state} and cannot be blocked`), { code: 'TASK_STATE_INVALID' });
      }
      const done = this.finish(state, task, 'BLOCKED', {
        by: workerId || 'kernel-supervisor',
        blocked: { code, reason, requiresOwner: requiresOwner === true },
      });
      this.emit('task.blocked', { taskId: id, workerId, code, requiresOwner: requiresOwner === true });
      if (requiresOwner) this.emit('permission.blocked', { taskId: id, code });
      return done;
    });
  }

  async uncertain(id: string, { code = 'UNCERTAIN', reason = 'External outcome unknown', workerId = null }: {
    code?: string;
    reason?: string;
    workerId?: string | null;
  } = {}): Promise<KernelTask> {
    return this.withLock((state) => {
      const task = this.find(state, id);
      if (task.state !== 'RUNNING') {
        throw Object.assign(new Error(`Task ${id} is ${task.state}, not RUNNING`), { code: 'TASK_NOT_RUNNING' });
      }
      const done = this.finish(state, task, 'UNCERTAIN', {
        by: workerId || 'kernel-supervisor',
        blocked: { code, reason, requiresOwner: true },
        error: { code, messageClass: 'uncertain-outcome' },
      });
      this.emit('task.uncertain', { taskId: id, workerId, code, requiresOwner: true });
      return done;
    });
  }

  async cancel(id: string, { by = 'owner' }: { by?: string } = {}): Promise<KernelTask> {
    return this.withLock((state) => {
      const task = this.find(state, id);
      if (TERMINAL_STATES.includes(task.state)) {
        throw Object.assign(new Error(`Task ${id} is already ${task.state}`), { code: 'TASK_STATE_INVALID' });
      }
      const done = this.finish(state, task, 'CANCELLED', { by });
      this.emit('task.cancelled', { taskId: id, by });
      return done;
    });
  }

  /** Owner-only requeue. UNCERTAIN requires an explicit reconciled outcome first. */
  async requeue(id: string, { by = 'owner' }: { by?: string } = {}): Promise<KernelTask> {
    return this.withLock((state) => {
      const task = this.find(state, id);
      // There is deliberately no bypass: an uncertain external effect must be
      // reconciled through resolveUncertain() with evidence.
      if (task.state === 'UNCERTAIN') {
        throw Object.assign(new Error('Uncertain tasks cannot be requeued; reconcile the external outcome first'), {
          code: 'TASK_UNCERTAIN_RETRY_REFUSED',
        });
      }
      if (!['FAILED_RETRYABLE', 'FAILED_FINAL', 'BLOCKED'].includes(task.state)) {
        throw Object.assign(new Error(`Task ${id} is ${task.state} and cannot be requeued`), { code: 'TASK_STATE_INVALID' });
      }
      task.state = 'QUEUED';
      task.notBefore = nowIso(this.clock);
      task.attempts = 0;
      task.blocked = null;
      task.lastError = null;
      task.updatedAt = nowIso(this.clock);
      task.history.push({ at: task.updatedAt, state: 'QUEUED', by, note: 'owner requeue' });
      this.emit('task.queued', { taskId: id, by, requeued: true });
      return publicTask(task);
    });
  }

  async resolveUncertain(id: string, { outcome, evidence = null, by = 'owner' }: {
    outcome: 'confirmed' | 'failed_final';
    evidence?: unknown;
    by?: string;
  }): Promise<KernelTask> {
    if (!['confirmed', 'failed_final'].includes(outcome)) {
      throw Object.assign(new Error('outcome must be confirmed or failed_final'), { code: 'RECONCILE_OUTCOME_INVALID' });
    }
    if (outcome === 'confirmed' && !evidence) {
      throw Object.assign(new Error('Confirming an uncertain outcome requires evidence'), { code: 'RECONCILE_EVIDENCE_REQUIRED' });
    }
    return this.withLock((state) => {
      const task = this.find(state, id);
      if (task.state !== 'UNCERTAIN') {
        throw Object.assign(new Error(`Task ${id} is ${task.state}, not UNCERTAIN`), { code: 'TASK_STATE_INVALID' });
      }
      const next: TaskState = outcome === 'confirmed' ? 'COMPLETED' : 'FAILED_FINAL';
      const done = this.finish(state, task, next, { by, summary: `Reconciled by owner as ${outcome}`, evidence });
      this.emit(next === 'COMPLETED' ? 'task.completed' : 'task.failed', { taskId: id, by, reconciled: true, outcome });
      return done;
    });
  }

  async effect(key: string): Promise<EffectsLedgerEntry | null> {
    return this.withLock((state) => state.effects[String(key)] || null);
  }

  async size(): Promise<number> {
    return this.withLock((state) => state.tasks.length);
  }

  /** Deterministic operation id for a task's effect; stable across restarts. */
  static operationId(task: KernelTask, suffix = ''): string {
    return `kernel-${sha256({ taskId: task.id, effectKey: task.effectKey || null, suffix }).slice(0, 40)}`;
  }
}
