/**
 * MAJIN W13 NEVER-STUCK — bounded loops, per-tool timeouts, repeat detection,
 * turn time-boxes, stall tracking. Everything measured, nothing silent.
 *
 * Design: small injectable pieces (never fake timeouts; real timers with
 * unref; manual-tick hooks for tests). The loop consumes these — the same
 * modules enforce flow/mission paths.
 */
export const VERSION = 'majin-watchdog/1';

/* Race a promise against a hard timeout. The timeout error is explicit and
   tagged — callers must not confuse it with a tool-produced failure. */
export function withTimeout(promise, { ms, code = 'tool_timeout', label = 'tool' } = {}) {
  const limit = Math.max(250, Number(ms) || 300_000);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const err = new Error(`${label} exceeded the hard timeout of ${Math.round(limit / 1000)}s — killed, no silent wait beyond the bound`);
      err.code = code;
      err.timeoutMs = limit;
      reject(err);
    }, limit);
    /* deliberately ref'd: withTimeout self-clears on settle/timeout, and an
       unref'd sole-timer lets node:test's runner think the loop is idle
       (cancelledByParent trap) — plus never lets a real process live forever. */
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * Enforces an absolute remaining TURN budget around one model call, including
 * implementations which ignore AbortSignal. A real request also receives the
 * cancellation signal, so the transport closes instead of burning CPU.
 *
 * This is a deadline on an individual awaited step, NOT a new per-step budget:
 * callers pass the time remaining from the original turn clock.
 */
export async function withAbortDeadline(work, { ms, parentSignal, label = 'model' } = {}) {
  if (typeof work !== 'function') throw new TypeError('work must be a function');
  const limit = Math.max(25, Number(ms) || 1800000);
  const ctrl = new AbortController();
  if (parentSignal?.aborted) {
    const err = new Error(label + ' cancelled by user');
    err.code = 'aborted';
    throw err;
  }
  let timer;
  let cancelParent = null;
  const deadline = new Promise((_, reject) => {
    cancelParent = () => {
      const err = new Error(label + ' cancelled by user');
      err.code = 'aborted';
      ctrl.abort(parentSignal?.reason || err);
      reject(err);
    };
    parentSignal?.addEventListener?.('abort', cancelParent, { once: true });
    timer = setTimeout(() => {
      const err = new Error(label + ' exceeded the remaining turn deadline of ' + limit + 'ms');
      err.code = 'turn_timeout';
      err.timeoutMs = limit;
      ctrl.abort(err);
      reject(err);
    }, limit);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => work(ctrl.signal)), deadline]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener?.('abort', cancelParent);
  }
}

/* No-progress detector: identical calls (name + args) more than `limit` times
   within one turn = never silently retrying that wall again. */
export class RepeatDetector {
  constructor(limit = 3) { this.limit = limit; this.lastKey = null; this.count = 0; }
  key(name, args) {
    // Normalize object key order so an LLM cannot evade repeat detection by
    // emitting {a:1,b:2}, then {b:2,a:1}. Keep array order (meaningful).
    // Never serialize cyclic values indefinitely; tool args must be JSON-like.
    const seen = new WeakSet();
    const canonical = (v, depth = 0) => {
      if (depth > 20) return '[depth-limit]';
      if (v === null || typeof v !== 'object') return v;
      if (seen.has(v)) return '[circular]';
      seen.add(v);
      const normalized = Array.isArray(v)
        ? v.map(x => canonical(x, depth + 1))
        : Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k], depth + 1)]));
      seen.delete(v);
      return normalized;
    };
    try { return `${name}:${JSON.stringify(canonical(args ?? {}))}`; }
    catch { return `${name}:<unserializable>`; }
  }
  hit(name, args) {
    const k = this.key(name, args);
    // A read of the same file after an intervening write is normal progress.
    // Only consecutive identical actions signal a no-progress loop.
    this.count = k === this.lastKey ? this.count + 1 : 1;
    this.lastKey = k;
    return { count: this.count, repeat: this.count >= this.limit, key: k };
  }
}

/* Stall tracker: progress bumps reset the clock; checkStall() reports the
   honest truth. `checkbox-tick(ms)` lets tests advance time without sleeping. */
export class StallTracker {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.lastProgressAt = now();
    this.bumps = 0;
  }
  bump() { this.lastProgressAt = this.now(); this.bumps += 1; return this.bumps; }
  checkStall(stallMs) {
    const inactivityMs = this.now() - this.lastProgressAt;
    return { stalled: inactivityMs >= stallMs, inactivityMs, bumps: this.bumps };
  }
}

/* Turn time-box: absolute cap across one runnerTurn (not per step). */
export class TurnClock {
  constructor(startedAt = Date.now()) { this.startedAt = startedAt; }
  over(maxMs) { const elapsed = Date.now() - this.startedAt; return { over: elapsed >= maxMs, elapsedMs: elapsed }; }
}

/* Approval stall: pending approvals must change state, not sit silently.
   watch(id) + tick(now) -> explicit transitions: active -> stalled -> timed_out. */
export class ApprovalWatch {
  constructor({ stallMs = 180_000, timeoutMs = 600_000, onStall = null, onTimeout = null } = {}) {
    this.stallMs = stallMs; this.timeoutMs = timeoutMs;
    this.onStall = onStall; this.onTimeout = onTimeout;
    this.pending = new Map();
  }
  watch(id, { at = Date.now(), meta = {} } = {}) { this.pending.set(id, { at, state: 'active', meta }); return id; }
  resolve(id) { return this.pending.delete(id); }
  tick(now = Date.now()) {
    for (const [id, p] of [...this.pending.entries()]) {
      const age = now - p.at;
      if (age >= this.timeoutMs) {
        p.state = 'timed_out';
        this.pending.delete(id);
        this.onTimeout?.({ id, ageMs: age, meta: p.meta });
      } else if (age >= this.stallMs && p.state === 'active') {
        p.state = 'stalled';
        this.onStall?.({ id, ageMs: age, meta: p.meta });
      }
    }
  }
  states() { return [...this.pending.entries()].map(([id, p]) => ({ id, state: p.state, ageMs: Date.now() - p.at })); }
}
