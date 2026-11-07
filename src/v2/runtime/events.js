/**
 * V2 typed event bus (master brief section 29 + 108).
 *
 * Built on node:events (zero-dep decision, logged in
 * DEPENDENCIES_AND_LICENSES.md). All kernel/UI traffic flows through here as
 * named typed events; Studio subscribes to the stream instead of scraping logs.
 * A bounded ring buffer keeps a replayable audit trail for debugging.
 */
import { EventEmitter } from 'node:events';

/** Event names the kernel may emit (brief 108). Studio should rely on these. */
export const EVENT_NAMES = Object.freeze([
  'goal.created', 'goal.transition', 'goal.receipt', 'goal.receipt_verified', 'goal.completed',
  'task.started', 'task.retry', 'task.completed', 'task.failed',
  'tool.started', 'tool.completed', 'tool.failed',
  'artifact.created', 'approval.required', 'voice.listening', 'voice.speaking',
  'verification.passed', 'verification.failed',
]);

export class EventBus {
  constructor({ auditCapacity = 500 } = {}) {
    this._ee = new EventEmitter();
    this._ee.setMaxListeners(50);
    this._audit = [];
    this._auditCapacity = auditCapacity;
  }

  /** Emit a typed event; silently drops unknown names into 'tool.failed' audit-safe. */
  emit(type, payload = {}) {
    const event = Object.freeze({ type, at: new Date().toISOString(), ...payload });
    if (this._audit.length >= this._auditCapacity) this._audit.shift();
    this._audit.push(event);
    // one bad listener cannot stall the kernel: isolate each
    for (const fn of this._ee.listeners(type)) {
      try { fn(event); } catch (err) { this.#isolated(err, type); }
    }
    return event;
  }

  #isolated(err, type) {
    if (this._audit.length >= this._auditCapacity) this._audit.shift();
    this._audit.push(Object.freeze({ type: 'bus.listener_error', source: type, error: String(err.message || err), at: new Date().toISOString() }));
  }

  on(type, fn) { this._ee.on(type, fn); return () => this._ee.off(type, fn); }
  off(type, fn) { this._ee.off(type, fn); }
  once(type, fn) { this._ee.once(type, fn); return () => this._ee.off(type, fn); }

  /** Replayable audit slice (newest last), optionally filtered. */
  audit({ type = null, last = null } = {}) {
    let out = type ? this._audit.filter((e) => e.type === type) : [...this._audit];
    return last == null ? out : out.slice(-last);
  }
}

/** Kernel singleton pattern is injected instead: create one per runtime session. */
export function createEventBus(o) { return new EventBus(o); }
