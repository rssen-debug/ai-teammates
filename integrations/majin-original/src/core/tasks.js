/** MAJIN — the autopilot core: one registry for every running task, plus the
 * resource locks that stop two tasks from mangling one file.
 *
 * Why this module exists, in one paragraph: `agent.turn` already serializes
 * per SESSION (two turns on one session must never split each other's context
 * or half-write the shared history file), so an independent user message wants
 * its own session — then parallel execution, isolated history and per-task
 * stop all come free from the engine we already have. What was missing is the
 * registry that names those sessions ("task t-x9s-3"), tracks what they are
 * doing, and the locks that keep them from colliding on the machine. All of
 * this is deterministic: queues, state and mutexes — zero LLM calls, zero
 * hidden model switching, zero extra cost.
 *
 * The state machine is deliberately boring:
 *
 *      create → running ⇄ paused
 *                     ⇄ waiting      (a resource or a user approval blocks it)
 *                 └──────────────► done | error | stopped   (terminal)
 *
 * Every transition is timestamped. A task is addressable by id for its whole
 * life — a follow-up message to an existing task is routed to the same
 * session (and therefore the same serialized agent), never a duplicate.
 */

const MAX_EVENTS = 200;
const TERMINAL = new Set(['done', 'error', 'stopped']);
const STATUSES = new Set(['running', 'paused', 'waiting', 'done', 'error', 'stopped']);

let seq = 0;

export class TaskRegistry {
  constructor() {
    this.byId = new Map(); // id → task
  }

  /** Start tracking a new independent task. Returns the public record. */
  create({ input = '', source = 'ui', task = null } = {}) {
    const id = task || `t-${Date.now().toString(36)}-${++seq}`;
    if (this.byId.has(id)) throw new Error(`task id already exists: ${id}`);
    const now = Date.now();
    const rec = {
      id,
      session: `task:${id}`, // session id handed to agent.turn — isolation rides on this
      input: String(input).slice(0, 160),
      source,
      status: 'running',
      run: 1,
      created: now,
      updated: now,
      events: [],
      toolsRun: 0,      // REAL tool completions only (tool_result with measured ms)
      toolMs: 0,        // summed ms of those completions
      curTool: null,    // name while a tool is running, null between completions
      lastTool: null,   // last completed tool name
    };
    this.byId.set(id, rec);
    return rec;
  }

  get(id) {
    return this.byId.get(String(id || '')) || null;
  }

  /** The session an existing task belongs to — follow-up routing uses this. */
  sessionOf(id) {
    const t = this.get(id);
    return t ? t.session : null;
  }

  list() {
    return [...this.byId.values()].sort((a, b) => b.created - a.created);
  }

  active() {
    return this.list().filter((t) => !TERMINAL.has(t.status));
  }

  /** agent 1 = the FIRST thing the user asked for — creation order, not recency */
  activeOldestFirst() {
    return this.active().sort((a, b) => a.created - b.created);
  }

  setStatus(id, status, run = null) {
    const t = this.get(id);
    if (!t) throw new Error(`unknown task: ${id}`);
    if (!STATUSES.has(status)) throw new Error(`unknown status: ${status}`); // garbage never survives — even on terminal tasks
    if (run !== null && run !== t.run) return t;
    if (TERMINAL.has(t.status)) return t; // terminal tasks never move again
    t.status = status;
    t.updated = Date.now();
    return t;
  }

  /** Only an explicit follow-up starts a new run; late events cannot reopen a terminal run. */
  beginFollowup(id) {
    const t = this.get(id);
    if (!t) throw new Error(`unknown task: ${id}`);
    if (TERMINAL.has(t.status)) {
      t.run += 1;
      t.events = [];
      t.toolsRun = 0; t.toolMs = 0; t.curTool = null; t.lastTool = null;
    }
    t.status = 'running';
    t.updated = Math.max(Date.now(), t.updated + 1);
    return t;
  }

  stop(id) {
    const t = this.get(id);
    if (!t) throw new Error(`unknown task: ${id}`);
    if (!TERMINAL.has(t.status)) {
      t.status = 'stopped';
      t.updated = Date.now();
    }
    return t;
  }

  /** Keep a capped, timestamped trail of what the task emitted. */
  event(id, type, data = null, run = null) {
    const t = this.get(id);
    if (!t || TERMINAL.has(t.status)) return;
    if (run !== null && run !== t.run) return;
    t.events.push({ type: String(type), data, at: Date.now() });
    if (t.events.length > MAX_EVENTS) t.events.splice(0, t.events.length - MAX_EVENTS);
    /* coarse status from the event stream — approvals make a task WAIT, and
       the next real step puts it back to work. No LLM involved. */
    if (type === 'approval' || type === 'resource:wait') t.status = 'waiting';
    else if (type === 'step' || type === 'tool' || type === 'delta') t.status = 'running';
    /* per-task telemetry from REAL events only — the card numbers must be
       countable from this stream, never estimated from vibes */
    if (type === 'tool' && data && data.tool) t.curTool = String(data.tool);
    if (type === 'tool_result' && data && data.tool && Number.isFinite(data.ms)) {
      t.toolsRun += 1;
      t.toolMs += data.ms;
      t.lastTool = String(data.tool);
      t.curTool = null;
    }
    t.updated = Date.now();
  }

  prune({ olderThanMs = 6 * 3600e3 } = {}) {
    const cut = Date.now() - olderThanMs;
    for (const [id, t] of this.byId) {
      if (TERMINAL.has(t.status) && t.updated < cut) this.byId.delete(id);
    }
  }

  /** What the API and the sibling-awareness prompt show. Files come from the
      locks so an agent sees who holds what right now, not who said they would. */
  snapshot() {
    return this.list().map((t) => ({
      id: t.id,
      status: t.status,
      run: t.run,
      input: t.input,
      source: t.source,
      created: t.created,
      updated: t.updated,
      locks: fileLocks.heldBy(t.session),
      last: t.events.length ? t.events[t.events.length - 1].type : null,
      toolsRun: t.toolsRun,
      avgToolMs: t.toolsRun ? Math.round(t.toolMs / t.toolsRun) : null, // null = honestly unknown
      curTool: t.curTool,
      lastTool: t.lastTool,
    }));
  }

  /** One compact line per active task, for the system prompt. Empty when quiet. */
  awareText({ limit = 8, excludeId = null } = {}) {
    const act = this.active().filter((t) => t.id !== excludeId).slice(0, limit);
    if (!act.length) return '';
    const lines = act.map((t) => {
      const locks = fileLocks.heldBy(t.session);
      const holding = locks.length ? `, holds ${locks.map((l) => base(l)).join('+')}` : '';
      return `${t.id} [${t.status}] ${t.input.slice(0, 60)}${holding}`;
    });
    return lines.join('\n');
  }
}

/** A resource lock per absolute path: FIFO waiters, owner re-entry, and a
 * timeout so a crashed owner cannot park a file forever. Waiting happens per
 * resource ONLY — a task queued on one file never blocks its other work, and
 * never blocks another task that needs a different file. */
export class FileLocks {
  constructor() {
    this.held = new Map();  // abs → { owner, since, count }
    this.queue = new Map(); // abs → [resolve callbacks]
  }

  norm(key) {
    return String(key || '').replace(/\\/g, '/');
  }

  async acquire(key, owner, { timeoutMs = 30000 } = {}) {
    const k = this.norm(key);
    const cur = this.held.get(k);
    if (cur && cur.owner === owner) {
      cur.count += 1; // same owner re-entering its own lock is safe
      return () => this._releaseOne(k, owner);
    }
    if (!cur) {
      this.held.set(k, { owner, since: Date.now(), count: 1 });
      return () => this._releaseOne(k, owner);
    }
    /* someone else holds it: queue. One task waiting on ONE resource, everything
       else keeps moving. */
    return new Promise((resolve, reject) => {
      const q = this.queue.get(k) || [];
      const timer = setTimeout(() => {
        const rest = (this.queue.get(k) || []).filter((w) => w !== waiter);
        if (rest.length) this.queue.set(k, rest);
        else this.queue.delete(k);
        reject(new Error(`file lock timeout after ${timeoutMs}ms: ${k} (held by ${cur.owner})`));
      }, timeoutMs);
      const waiter = () => {
        clearTimeout(timer);
        this.held.set(k, { owner, since: Date.now(), count: 1 });
        resolve(() => this._releaseOne(k, owner));
      };
      waiter.timer = timer;
      q.push(waiter);
      this.queue.set(k, q);
    });
  }

  _releaseOne(k, owner) {
    const cur = this.held.get(k);
    if (!cur || cur.owner !== owner) return;
    cur.count -= 1;
    if (cur.count > 0) return;
    this.held.delete(k);
    const q = this.queue.get(k) || [];
    const next = q.shift(); // FIFO — the one who waited longest gets it
    if (q.length) this.queue.set(k, q);
    else this.queue.delete(k);
    if (next) next();
  }

  heldBy(owner) {
    return [...this.held.entries()].filter(([, v]) => v.owner === owner).map(([k]) => k);
  }

  heldList() {
    return [...this.held.entries()].map(([k, v]) => ({ path: k, owner: v.owner, since: v.since }));
  }
}

const base = (p) => String(p).split('/').pop();

/** Process-wide instances, like serialize.js: there is exactly one machine,
    so there is exactly one registry and one lock table. */
export const tasks = new TaskRegistry();
export const fileLocks = new FileLocks();

/** ETA from REAL telemetry only: per-tool timings observed by this very
    process. Two samples minimum before we say anything at all, intervals
    instead of fake precision, and "hard to estimate" when data is thin —
    the master brief forbids invented percentages. */
export class EtaMetrics {
  constructor({ perTool = 100 } = {}) {
    this.perTool = perTool;
    this.byTool = new Map(); // tool → { n, totalMs, samples[ms] }
  }

  record(tool, ms) {
    if (!tool || !Number.isFinite(ms) || ms < 0 || ms > 3600e3) return; // garbage never enters the model
    const k = String(tool);
    const m = this.byTool.get(k) || { n: 0, totalMs: 0, samples: [] };
    m.n += 1;
    m.totalMs += ms;
    m.samples.push(ms);
    if (m.samples.length > this.perTool) m.samples.shift();
    this.byTool.set(k, m);
  }

  /** null when there is not enough data to be honest; else a min–avg–max
      interval from the last observations. */
  estimate(tool) {
    const m = this.byTool.get(String(tool || ''));
    if (!m || m.n < 2) return null;
    const s = [...m.samples].sort((a, b) => a - b);
    const lo = s[0];
    const hi = s[s.length - 1];
    const avg = Math.round(m.totalMs / m.n);
    return { tool: String(tool), n: m.n, avgMs: avg, loMs: lo, hiMs: hi };
  }

  summary() {
    const out = {};
    for (const [tool, m] of this.byTool) out[tool] = { runs: m.n, avgMs: Math.round(m.totalMs / m.n) };
    return out;
  }
}

export const eta = new EtaMetrics();

/** tests + diagnostics only */
export function _resetAutopilot() {
  tasks.byId.clear();
  fileLocks.held.clear();
  for (const q of fileLocks.queue.values()) for (const w of q) clearTimeout(w.timer);
  fileLocks.queue.clear();
  eta.byTool.clear();
}
