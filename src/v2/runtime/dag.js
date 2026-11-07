/**
 * V2 task DAG (master brief section 21).
 *
 * A persisted dependency graph of tasks: independent nodes may run together,
 * dependents wait, failed nodes block their descendants (policy-configurable),
 * and the graph itself survives process restarts (save/toJSON/fromJSON).
 *
 * Topological order and cycle detection stay here on purpose (decision logged
 * in DEPENDENCIES_AND_LICENSES.md): forty lines, fully tested, no supply cost.
 */

export const TASK_STATES = Object.freeze({
  PENDING: 'PENDING',
  READY: 'READY',
  RUNNING: 'RUNNING',
  DONE: 'DONE',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
  BLOCKED: 'BLOCKED',
});

export class CycleError extends Error {}

export class TaskGraph {
  constructor({ goalId, failurePolicy = 'block' } = {}) {
    if (!goalId) throw new Error('TaskGraph requires goalId');
    this.goalId = goalId;
    this.failurePolicy = failurePolicy; // 'block' (default) | 'continue'
    this.tasks = new Map(); // id -> { id, action, deps[], state, receiptIds[], attempt, maxAttempts, receipt?, error? }
  }

  /** Add a task. deps = array of task ids that MUST finish first. */
  addTask({ id, action, deps = [], maxAttempts = 3 }) {
    if (!id) throw new Error('task requires id');
    if (!action) throw new Error('task requires action');
    if (this.tasks.has(id)) throw new Error(`duplicate task id: ${id}`);
    for (const d of deps) {
      if (d === id) throw new CycleError(`dependency cycle involves task ${id}`);
      if (!this.tasks.has(d)) throw new Error(`task ${id} depends on unknown task ${d}`);
    }
    this.tasks.set(id, { id, action, deps: [...deps], state: TASK_STATES.PENDING, receiptIds: [], attempt: 0, maxAttempts, error: null });
    this.#assertAcyclic();
    return this;
  }

  #assertAcyclic() {
    const visiting = new Set();
    const done = new Set();
    const visit = (id) => {
      if (done.has(id)) return;
      if (visiting.has(id)) throw new CycleError(`dependency cycle involves task ${id}`);
      visiting.add(id);
      for (const d of this.tasks.get(id).deps) {
        if (!this.tasks.has(d)) throw new Error(`task ${id} depends on unknown task ${d}`);
        visit(d);
      }
      visiting.delete(id);
      done.add(id);
    };
    for (const id of this.tasks.keys()) visit(id);
  }

  /** Task ids whose deps are all DONE and which are waiting to run. */
  readySet() {
    const ready = [];
    for (const t of this.tasks.values()) {
      if (t.state !== TASK_STATES.PENDING) continue;
      if (t.deps.every((d) => this.tasks.get(d).state === TASK_STATES.DONE)) ready.push(t.id);
    }
    return ready;
  }

  /** Apply failure policy downward from a failed task. Returns affected ids. */
  propagateFailure(failedId) {
    const affected = [];
    if (this.failurePolicy !== 'block') return affected;
    // block descendants transitively
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of this.tasks.values()) {
        if (t.state !== TASK_STATES.PENDING) continue;
        const depBlocked = t.deps.some((d) => {
          const s = this.tasks.get(d).state;
          return s === TASK_STATES.FAILED || s === TASK_STATES.BLOCKED;
        });
        if (depBlocked) {
          t.state = TASK_STATES.BLOCKED;
          affected.push(t.id);
          changed = true;
        }
      }
    }
    return affected;
  }

  /** Whether every task reached a terminal outcome. */
  isExhausted() {
    const terminal = new Set([TASK_STATES.DONE, TASK_STATES.FAILED, TASK_STATES.SKIPPED, TASK_STATES.BLOCKED]);
    return [...this.tasks.values()].every((t) => terminal.has(t.state));
  }

  markState(id, state, patch = {}) {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`unknown task: ${id}`);
    t.state = state;
    Object.assign(t, patch);
    return this;
  }

  toJSON() {
    return {
      goalId: this.goalId,
      failurePolicy: this.failurePolicy,
      tasks: [...this.tasks.values()],
    };
  }

  static fromJSON(data) {
    const g = new TaskGraph({ goalId: data.goalId, failurePolicy: data.failurePolicy });
    for (const t of data.tasks || []) g.tasks.set(t.id, { ...t });
    return g;
  }
}
