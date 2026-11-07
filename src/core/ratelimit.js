/**
 * MAJIN rate-limit orchestrator — GODLIKE V4 §7.
 * One admission-control layer for ALL model calls: provider-quota buckets
 * (rpm + tokens/min + concurrent), token reservations, Retry-After honoring,
 * bounded backoff with jitter, prioritized queue (interactive beats
 * background), AIMD concurrency, honest classification.
 * Pass-through when no quota is configured — never invents limits.
 */
import { bus } from './log.js';

const MIN = 60000;

/** Rolling window counters per bucket. windowMs defaults to 60 s; the
    simulator shortens it deterministically (quota.windowMs). */
class Window {
  constructor(windowMs = MIN) { this.points = []; this.ms = windowMs; }
  #now() { return Date.now(); }
  push(tokensIn, tokensOut) { this.points.push({ t: this.#now(), in: tokensIn, out: tokensOut, req: 1 }); }
  sum() {
    const cutoff = this.#now() - this.ms;
    while (this.points.length && this.points[0].t < cutoff) this.points.shift();
    return this.points.reduce((a, p) => ({ req: a.req + p.req, in: a.in + p.in, out: a.out + p.out }), { req: 0, in: 0, out: 0 });
  }
}

const limiters = new Map(); // key = provider::model
let overrides = null; // test hook

export function _resetForTests() { limiters.clear(); overrides = null; }
export function _setClockForTests(f) { overrides = f; }
const now = () => (overrides ? overrides() : Date.now());

/** Estimate input tokens honestly (chars/4) — underestimate risk noted publicly. */
export function estimateInputTokens(messages = []) {
  const json = JSON.stringify(messages);
  return Math.max(1, Math.ceil(json.length / 4));
}

/** Parse Retry-After from an upstream error (header seconds, ms, or HTTP-date). */
export function retryAfterMs(err) {
  const h = err?.headers?.['retry-after'] ?? err?.headers?.['Retry-After'] ?? err?.retryAfter ?? err?.retry_after;
  if (h == null) return 0;
  if (typeof h === 'number' && Number.isFinite(h)) return Math.max(0, h * 1000);
  const s = String(h).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.max(0, Number(s) * 1000);
  const d = Date.parse(s);
  if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
  return 0;
}

/** GODLIKE §7 classes — retryable and stop semantics per class. */
export function classify(err) {
  const msg = String(err?.message || '');
  if (err?.status === 429 || /rate ?limit|too many requests|quota exceeded/i.test(msg)) return { cls: 'rate_limit', retryable: true, respectRetryAfter: true };
  if (/insufficient.? (credit|balance|quota)|billing|payment|spend/i.test(msg)) return { cls: 'budget', retryable: false };
  if (err?.status === 401 || err?.status === 403 || /invalid api.?key|unauthorized|forbidden|bad credentials/i.test(msg)) return { cls: 'auth', retryable: false };
  if (err?.status === 404 || /unknown model|model .*(not found|does not exist)|no such model/i.test(msg)) return { cls: 'model', retryable: false };
  if (/context length|maximum context|too (many|long) tokens|context window/i.test(msg)) return { cls: 'context', retryable: false };
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed/i.test(msg)) return { cls: 'network', retryable: true };
  return { cls: 'provider', retryable: Boolean(err?.retryable ?? (err?.status >= 500)) };
}

class Limiter {
  constructor(key, quota) {
    this.key = key;
    this.quota = quota; // {rpm, tpmIn, tpmOut, concurrent}
    this.win = new Window(quota.windowMs || MIN);
    this.inFlight = 0;          // live admissions
    this.reqReserved = 0;       // requests reserved but not yet reconciled
    this.reservedIn = 0;        // token reservations not yet reconciled
    this.reservedOut = 0;
    this.aimd = { level: quota.concurrent || 4, min: 1 }; // adaptive concurrency
    this.stats = { admitted: 0, waitedMs: 0, queued: 0, violations: 0, reconciledTokens: 0, canceledQueued: 0 };
  }
  capacity() {
    const s = this.win.sum();
    const q = this.quota;
    return {
      reqLeft: q.rpm ? q.rpm - (s.req + this.reqReserved) : Infinity,
      inLeft: q.tpmIn ? q.tpmIn - (s.in + this.reservedIn) : Infinity,
      outLeft: q.tpmOut ? q.tpmOut - (s.out + this.reservedOut) : Infinity,
      concLeft: (Math.min(q.concurrent ?? Infinity, this.aimd.level)) - this.inFlight,
    };
  }
  wouldPass(estIn, estOut) {
    const c = this.capacity();
    return c.reqLeft > 0 && c.inLeft >= estIn && c.outLeft >= estOut && c.concLeft > 0;
  }
  admit(estIn, estOut) {
    this.inFlight += 1;
    this.reqReserved += 1;
    this.reservedIn += estIn;
    this.reservedOut += estOut;
    this.stats.admitted += 1;
    return () => { // reservation release, reconcile actuals
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.reqReserved = Math.max(0, this.reqReserved - 1);
      this.reservedIn = Math.max(0, this.reservedIn - estIn);
      this.reservedOut = Math.max(0, this.reservedOut - estOut);
    };
  }
  reconcile(actualIn, actualOut) {
    this.win.push(actualIn, actualOut);
    this.stats.reconciledTokens += actualIn + actualOut;
  }
  /** AIMD notes from the outside world. */
  success(latencyMs) { void latencyMs; /* additive: keep level; provider-side headers could refine later */ }
  violation() {
    this.stats.violations += 1;
    this.aimd.level = Math.max(this.aimd.min, Math.floor(this.aimd.level / 2)); // multiplicative decrease
  }
  calm() { if (this.stats.violations === 0) this.aimd.level = Math.min(this.quota.concurrent || 4, this.aimd.level + 1); }
}

export function limiterFor(route, quotaGet = null) {
  const key = `${route?.providerName || 'unknown'}::${route?.model || 'unknown'}`;
  let l = limiters.get(key);
  if (!l) {
    const quota = quotaGet ? quotaGet(route) : null;
    l = new Limiter(key, quota || {});
    limiters.set(key, l);
  }
  return l;
}

/** Sleep that respects AbortSignal — queue-cancellable. */
function sleep(ms, signal) {
  return new Promise((res, rej) => {
    if (signal?.aborted) return rej(Object.assign(new Error('canceled'), { name: 'AbortError' }));
    const t = setTimeout(() => res(), ms);
    signal?.addEventListener?.('abort', () => { clearTimeout(t); rej(Object.assign(new Error('canceled'), { name: 'AbortError' })); }, { once: true });
  });
}

const queue = []; // FIFO with priority partition
let active = 0;
const PRIO = { interactive: 0, tasks: 1, background: 2 };

/**
 * Global orchestrator admission: enqueues (priority), waits for capacity,
 * returns a reservation-release function. No quota configured → instant pass.
 */
export async function admit({ route, quotaGet = null, estIn = 0, estOut = 0, job = 'tasks', signal = null, clock = now }) {
  void clock;
  const l = limiterFor(route, quotaGet);
  const q = l.quota;
  const limited = q.rpm || q.tpmIn || q.tpmOut || q.concurrent;
  if (!limited) return () => {}; // pass-through: honest default without any quota config

  const prio = PRIO[job] ?? PRIO.tasks;
  const entry = { route, estIn, estOut, prio, rejected: false };
  if (signal) {
    const onAbort = () => {
      /* V4: never reject a floating promise from a listener — the queue loop
         throws on the NEXT pass and the rejection lands on the call's own
         promise, which the caller already holds. This kills the
         unhandledRejection class outright (sim S4). */
      entry.rejected = true;
      const i = queue.indexOf(entry);
      if (i >= 0) queue.splice(i, 1);
    };
    if (signal.aborted) {
      entry.rejected = true;
      const err = Object.assign(new Error('canceled while queued'), { name: 'AbortError' });
      return Promise.reject(err);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  queue.push(entry);
  queue.sort((a, b) => a.prio - b.prio);
  bus.info('ratelimit.queued', { key: l.key, job, depth: queue.length });
  /* V4 §7 fairness (sim S5): a caller admitted on its FIRST check would get
     a self-inflicted microtask jump over same-tick arrivals of higher
     priority. One microtask yield before the FIRST capacity decision lets
     the whole call-group coalesce in the queue — background-typed callers
     stop leaping interactive ones purely by being the first line. */
  await Promise.resolve();
  queue.sort((a, b) => a.prio - b.prio);

  let safety = 0;
  for (;;) {
    safety += 1;
    if (safety > 4000) { const i = queue.indexOf(entry); if (i >= 0) queue.splice(i, 1); throw new Error('ratelimit: internal starvation guard tripped'); }
    if (entry.rejected) { l.stats.canceledQueued += 1; throw Object.assign(new Error('canceled while queued'), { name: 'AbortError' }); }
    if (queue[0] === entry && l.wouldPass(estIn, estOut)) {
      queue.shift();
      const release = l.admit(estIn, estOut);
      l.stats.queued += 1;
      return release;
    }
    const t0 = now();
    await sleep(120, null).catch(() => {});
    l.stats.waitedMs += Math.max(0, now() - t0);
  }
}

/** Record a completed call's ACTUAL usage against the window. */
export function record(route, usage, quotaGet = null) {
  const l = limiterFor(route, quotaGet);
  l.reconcile(Number(usage?.input || 0), Number(usage?.output || 0));
}

/** Record a violation (429) so AIMD multiplies down. */
export function noteViolation(route, quotaGet = null) { limiterFor(route, quotaGet).violation(); }

/** The exact retry delay: provider Retry-After is a FLOOR, our bounded
     exponential+jitter otherwise. Exported so the choice is testable. */
export function backoffFor({ raMs = 0, attempt = 1, jitter = 0 } = {}) {
  const exp = Math.min(15000, 800 * 2 ** (attempt - 1)) + jitter;
  return Math.max(raMs, exp);
}

/** Expose stats for SWARM_PERFORMANCE + tests. */
export function stats(route = null, quotaGet = null) {
  if (route) return limiterFor(route, quotaGet).stats;
  const all = {};
  for (const [k, l] of limiters) all[k] = l.stats;
  return all;
}
