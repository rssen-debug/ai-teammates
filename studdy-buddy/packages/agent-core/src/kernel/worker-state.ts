/**
 * Unified kernel — worker heartbeat file.
 *
 * Ported from MAJIN V6 (`src/v6/worker-state.js`). A separate process (the
 * worker) proves liveness here. The CLI can read it without owning the
 * terminal, and `studdy status` uses it for real health instead of guessing.
 */
import path from 'node:path';
import { atomicWriteJson, ensureDir, errorCode, nowIso, readJson, type Clock } from './util.js';

export const HEARTBEAT_SCHEMA = 'studdy.kernel.worker-heartbeat/v1';

export interface WorkerSnapshot {
  schema: string;
  workerId: string;
  pid: number;
  state: string;
  startedAt: string;
  updatedAt: string;
  currentTaskId: string | null;
  lastAction: string;
  lastActionAt: string;
  tasksCompleted: number;
  tasksFailed: number;
  tasksBlocked: number;
  toolCalls: number;
}

export interface WorkerHealth {
  state: string;
  ageMs: number | null;
  pidAlive: boolean | null;
}

export class WorkerHeartbeat {
  readonly file: string;
  readonly workerId: string;
  readonly pid: number;
  readonly clock: Clock;
  state = 'STARTING';
  currentTaskId: string | null = null;
  lastAction = 'starting';
  lastActionAt: string;
  readonly startedAt: string;
  tasksCompleted = 0;
  tasksFailed = 0;
  tasksBlocked = 0;
  toolCalls = 0;

  constructor({ file, workerId, pid = process.pid, clock = Date.now }: {
    file: string;
    workerId: string;
    pid?: number;
    clock?: Clock;
  }) {
    this.file = path.resolve(file);
    this.workerId = workerId;
    this.pid = pid;
    this.clock = clock;
    this.lastActionAt = nowIso(clock);
    this.startedAt = nowIso(clock);
    ensureDir(path.dirname(this.file));
  }

  beat(patch: Partial<WorkerSnapshot> = {}): WorkerSnapshot {
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (this as unknown as Record<string, unknown>)[key] = value;
    }
    this.lastActionAt = nowIso(this.clock);
    const payload: WorkerSnapshot = {
      schema: HEARTBEAT_SCHEMA,
      workerId: this.workerId,
      pid: this.pid,
      state: this.state,
      startedAt: this.startedAt,
      updatedAt: nowIso(this.clock),
      currentTaskId: this.currentTaskId,
      lastAction: this.lastAction,
      lastActionAt: this.lastActionAt,
      tasksCompleted: this.tasksCompleted,
      tasksFailed: this.tasksFailed,
      tasksBlocked: this.tasksBlocked,
      toolCalls: this.toolCalls,
    };
    atomicWriteJson(this.file, payload);
    return payload;
  }

  read(): WorkerSnapshot | null {
    return readJson<WorkerSnapshot>(this.file, null);
  }

  /** Healthy only if a real recent write exists; a dead PID is never healthy. */
  static health(snapshot: WorkerSnapshot | null, { now = Date.now(), staleMs = 45_000 }: { now?: number; staleMs?: number } = {}): WorkerHealth {
    if (!snapshot || !snapshot.updatedAt) return { state: 'NO_HEARTBEAT', ageMs: null, pidAlive: null };
    const ageMs = now - new Date(snapshot.updatedAt).getTime();
    let pidAlive: boolean | null = null;
    if (Number.isInteger(snapshot.pid)) {
      try {
        process.kill(snapshot.pid, 0);
        pidAlive = true;
      } catch (error) {
        pidAlive = errorCode(error) === 'EPERM';
      }
    }
    const stale = ageMs > staleMs;
    return {
      state: stale || pidAlive === false ? 'STALLED' : (snapshot.state || 'UNKNOWN'),
      ageMs,
      pidAlive,
    };
  }
}
