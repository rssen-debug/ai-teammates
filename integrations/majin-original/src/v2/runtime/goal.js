/**
 * V2 durable goal (master brief sections 3.1 + 3.4 + 3.5).
 *
 * A goal is the unit of honest completion: it owns its acceptance list, its
 * receipts, and its state machine. COMPLETED is only reachable through
 * VERIFYING, and only when every acceptance item is covered by at least one
 * VERIFIED receipt. Nothing here talks to a model or to a desktop — the
 * executor/verifier plug in around this object.
 */
import fs from 'node:fs';
import path from 'node:path';
import { STATES, TERMINAL, assertTransition } from './states.js';
import { makeReceipt, verify as verifyReceipt } from './receipts.js';

export const GOAL_SCHEMA = 'majin.v2.goal/v1';

let counter = 0;
/** collision-proof within one process; persistence adds the id. */
export function newGoalId() {
  counter += 1;
  return `goal_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export class EvidenceRequired extends Error {}
export class IllegalTransitionSatisfied extends Error {}

export class Goal {
  /**
   * @param {object} o
   * @param {string} o.objective        user objective, in the owner's words
   * @param {Array<{id:string, description:string}>} o.acceptance
   * @param {string} [o.risk]           'low' | 'medium' | 'high'
   * @param {string[]} [o.permissions]  scopes granted for this goal
   * @param {object} [o.budgets]        { timeMs, toolCalls, usd } ceilings
   */
  constructor({ objective, acceptance = [], risk = 'low', permissions = [], budgets = null, id = null, events = null } = {}) {
    if (!objective) throw new Error('goal requires an objective');
    this.id = id || newGoalId();
    this.schema = GOAL_SCHEMA;
    this.objective = objective;
    this.acceptance = acceptance.map((a) => ({ coveredBy: [], ...a }));
    this.risk = risk;
    this.permissions = [...permissions];
    this.budgets = budgets ? { ...budgets } : null;
    this.state = STATES.CREATED;
    this.receipts = [];
    this.history = [{ at: new Date().toISOString(), to: STATES.CREATED, reason: 'created' }];
    this._events = typeof events === 'function' ? events : () => {};
  }

  /** State hop with legality enforcement; reason is recorded for the timeline. */
  transition(to, reason = '') {
    assertTransition(this.state, to);
    this.state = to;
    const stamp = new Date().toISOString();
    this.history.push({ at: stamp, to, reason });
    this._events({ type: 'goal.transition', goal: this.id, to, reason, at: stamp });
    return this;
  }

  /**
   * Register an action receipt bound to this goal.
   * Only legal states can execute work: RUNNING / RECOVERING / VERIFYING.
   */
  addReceipt({ taskId = null, action, target = null, result, evidence = null, errorClass = null, attempt = 1, durationMs = 0, acceptanceId = null }) {
    const execStates = [STATES.RUNNING, STATES.RECOVERING, STATES.VERIFYING];
    if (!execStates.includes(this.state)) {
      throw new IllegalTransitionSatisfied(`actions require ${execStates.join('/')}; goal is ${this.state}`);
    }
    let receipt = makeReceipt({ goalId: this.id, taskId, action, target, result, evidence, errorClass, attempt, durationMs });
    if (acceptanceId) receipt = Object.freeze({ ...receipt, acceptanceId });
    this.receipts.push(receipt);
    this._events({ type: 'goal.receipt', goal: this.id, receipt });
    return receipt;
  }

  /** Verify a receipt with evidence; return the updated receipt. */
  verifyReceipt(receiptId, evidence) {
    const idx = this.receipts.findIndex((r) => r.id === receiptId);
    if (idx < 0) throw new Error(`no such receipt: ${receiptId}`);
    const verified = verifyReceipt(this.receipts[idx], evidence);
    this.receipts[idx] = verified;
    this._events({ type: 'goal.receipt_verified', goal: this.id, receipt: verified });
    return verified;
  }

  /** Which acceptance items lack a verified receipt? */
  uncoveredAcceptance() {
    return this.acceptance.filter((a) => {
      const k = a.id;
      return !this.receipts.some((r) => r.verified && r.result === 'success' && (r.acceptanceId === k || this.#coversByText(r, a)));
    });
  }

  #coversByText(receipt, acceptanceItem) {
    if (receipt.target && acceptanceItem.description && receipt.target.includes(acceptanceItem.description)) return true;
    return false;
  }

  /**
   * Mark the goal complete. Hard gate: must be in VERIFYING and every
   * acceptance item must carry at least one verified success receipt.
   * A model's completion message is not an acceptance receipt.
   */
  complete() {
    assertTransition(this.state, STATES.COMPLETED);
    if (this.state !== STATES.VERIFYING) {
      throw new IllegalTransitionSatisfied(`complete() requires VERIFYING, goal is ${this.state}`);
    }
    const missing = this.uncoveredAcceptance();
    if (missing.length > 0) {
      throw new EvidenceRequired(`acceptance without verified evidence: ${missing.map((m) => m.id).join(', ')}`);
    }
    this.state = STATES.COMPLETED;
    const stamp = new Date().toISOString();
    this.history.push({ at: stamp, to: STATES.COMPLETED, reason: 'all acceptance items verified' });
    this._events({ type: 'goal.completed', goal: this.id, at: stamp });
    return this;
  }

  /** Plain serializable snapshot. */
  toJSON() {
    return {
      schema: this.schema,
      id: this.id,
      objective: this.objective,
      acceptance: this.acceptance,
      risk: this.risk,
      permissions: this.permissions,
      budgets: this.budgets,
      state: this.state,
      receipts: this.receipts,
      history: this.history,
    };
  }

  /** Persist to <dir>/<id>.json (atomic-ish: tmp + rename). Returns the path. */
  save(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const rel = path.join(dir, `${this.id}.json`);
    const tmp = `${rel}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.toJSON(), null, 2));
    fs.renameSync(tmp, rel);
    return rel;
  }

  /** Resume a saved goal (master brief section 46: crash recovery needs this). */
  static load(file, { events = null } = {}) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.schema !== GOAL_SCHEMA) throw new Error(`unsupported goal schema: ${data.schema}`);
    const g = new Goal({
      objective: data.objective, acceptance: data.acceptance, risk: data.risk,
      permissions: data.permissions, budgets: data.budgets, id: data.id, events,
    });
    g.state = data.state;
    g.receipts = data.receipts || [];
    g.history = data.history || g.history;
    if (TERMINAL.has(g.state)) g.history.push({ at: new Date().toISOString(), to: g.state, reason: 'resumed(terminal)' });
    return g;
  }

  /** List saved goals in a directory (ids + states) for a resume UI. */
  static list(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith('goal_') && f.endsWith('.json'))
      .map((f) => {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return { id: d.id, state: d.state, objective: d.objective };
      });
  }
}
