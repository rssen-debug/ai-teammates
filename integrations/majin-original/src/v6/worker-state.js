/**
 * MAJIN V6 — worker heartbeat file.
 *
 * A separate process (the worker) proves liveness here. OpenCode can read it
 * without owning the terminal, and `majin-v6 status` uses it for health.
 */
import path from 'node:path';
import { atomicWriteJson, ensureDir, nowIso, readJson } from './util.js';

export class WorkerHeartbeat {
  constructor({ file, workerId, pid = process.pid, clock = Date.now }) {
    this.file = path.resolve(file);
    this.workerId = workerId;
    this.pid = pid;
    this.clock = clock;
    this.state = 'STARTING';
    this.currentTaskId = null;
    this.lastAction = 'starting';
    this.lastActionAt = nowIso(clock);
    this.startedAt = nowIso(clock);
    this.tasksCompleted = 0;
    this.tasksFailed = 0;
    this.tasksBlocked = 0;
    this.toolCalls = 0;
    ensureDir(path.dirname(this.file));
  }

  beat(patch = {}) {
    Object.assign(this, patch);
    this.lastActionAt = nowIso(this.clock);
    const payload = {
      schema: 'majin.v6.worker-heartbeat/v1',
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

  read() {
    return readJson(this.file, null);
  }

  /** Healthy only if a real recent write exists; a dead PID is never healthy. */
  static health(snapshot, { now = Date.now(), staleMs = 45000 } = {}) {
    if (!snapshot) return { state: 'NO_HEARTBEAT', ageMs: null, pidAlive: null };
    const ageMs = now - new Date(snapshot.updatedAt).getTime();
    let pidAlive = null;
    if (Number.isInteger(snapshot.pid)) {
      try { process.kill(snapshot.pid, 0); pidAlive = true; } catch (error) { pidAlive = error.code === 'EPERM'; }
    }
    const stale = ageMs > staleMs;
    return {
      state: stale || pidAlive === false ? 'STALLED' : (snapshot.state || 'UNKNOWN'),
      ageMs,
      pidAlive,
    };
  }
}
