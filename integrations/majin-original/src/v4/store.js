/**
 * MAJIN V4 — durable conversation + goal storage.
 *
 * One JSON document per conversation, written atomically (tmp + rename).
 * Messages are the source of truth for the transcript; goals live in the V2
 * goal directory so the existing evidence machinery (`Goal.load`, receipts)
 * keeps working unchanged.
 *
 * Idempotency: each client turn carries a requestId. A completed requestId is
 * remembered with its outcome, so a retried request after a dropped connection
 * returns the stored answer instead of executing the tools twice.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Goal } from '../v2/runtime/goal.js';
import { STATES, TERMINAL } from '../v2/runtime/states.js';
import { hasApprovalContinuation } from './approval-continuation.js';

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export const CONVERSATION_CACHE_MAX = 200;
export const CONVERSATION_LIST_MAX = 100;

export class ConversationStore {
  constructor({ dir, maxMessages = 400, cacheMax = CONVERSATION_CACHE_MAX } = {}) {
    this.dir = dir;
    this.maxMessages = maxMessages;
    this.cacheMax = cacheMax;
    fs.mkdirSync(dir, { recursive: true });
    // LRU: insertion order is the recency order because every hit re-inserts.
    // The file on disk is the source of truth, so eviction never loses data.
    this.cache = new Map();
  }

  #remember(conv) {
    this.cache.delete(conv.id);
    this.cache.set(conv.id, conv);
    while (this.cache.size > this.cacheMax) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    return conv;
  }

  #file(id) {
    if (!/^conv_[a-z0-9_]+$/.test(String(id))) throw new Error('invalid conversation id');
    return path.join(this.dir, `${id}.json`);
  }

  create({ title = 'Ny konversation', sourceId = null, titlePolicy = 'fallback' } = {}) {
    const now = new Date().toISOString();
    const conv = {
      schema: 'majin.v4.conversation/v1',
      id: newId('conv'),
      title,
      // Same title policy vocabulary as V1's chats.js: a manual rename wins
      // forever, an auto title is set once from the first user message.
      titlePolicy,
      createdAt: now,
      updatedAt: now,
      version: 1,
      archivedAt: null,
      ...(sourceId ? { sourceId } : {}),
      messages: [],
      goalIds: [],
      pendingApproval: null,
      requests: {},
    };
    this.save(conv);
    return conv;
  }

  /**
   * Tombstones for deleted conversations.
   *
   * Two devices must not resurrect a chat one of them deleted. A tombstone is
   * tiny, bounded and kept next to the conversations; the list endpoint hands
   * them out so a stale client can drop the row instead of showing a chat that
   * no longer exists. Bounded to the newest 500 so the file cannot grow forever.
   */
  #tombstoneFile() {
    return path.join(this.dir, '..', 'conversations-deleted.json');
  }

  tombstones() {
    const data = readJson(this.#tombstoneFile());
    const list = Array.isArray(data?.deleted) ? data.deleted : [];
    return list.filter((t) => t && typeof t.id === 'string');
  }

  #addTombstone(id) {
    const file = this.#tombstoneFile();
    const now = new Date().toISOString();
    const list = this.tombstones().filter((t) => t.id !== id);
    list.push({ id, at: now });
    const bounded = list.slice(-500);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ schema: 'majin.v4.conversation-tombstones/v1', deleted: bounded }, null, 2));
    fs.renameSync(tmp, file);
    return bounded;
  }

  save(conv) {
    conv.updatedAt = new Date().toISOString();
    conv.version = (conv.version || 0) + 1;
    if (conv.messages.length > this.maxMessages) {
      conv.messages = conv.messages.slice(conv.messages.length - this.maxMessages);
    }
    writeAtomic(this.#file(conv.id), conv);
    return this.#remember(conv);
  }

  get(id) {
    if (this.cache.has(id)) {
      const hit = this.cache.get(id);
      this.cache.delete(id); // re-insert = most recently used
      this.cache.set(id, hit);
      return hit;
    }
    const conv = readJson(this.#file(id));
    if (!conv || conv.schema !== 'majin.v4.conversation/v1') return null;
    return this.#remember(conv);
  }

  /**
   * The conversation list, the way every device reads it.
   *
   * `view` selects active (default), archived or all. `q` searches title and
   * message text. `since` returns only what changed after that ISO timestamp,
   * which is what a second device polls: an unchanged list costs nothing.
   */
  list({ view = 'active', q = '', since = null, limit = CONVERSATION_LIST_MAX } = {}) {
    const out = [];
    let files = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.startsWith('conv_') && f.endsWith('.json'));
    } catch {
      return out;
    }
    const query = String(q || '').trim().toLowerCase();
    const after = since ? Date.parse(since) : null;
    for (const f of files) {
      const conv = readJson(path.join(this.dir, f));
      if (!conv) continue;
      const archived = Boolean(conv.archivedAt);
      if (view === 'active' && archived) continue;
      if (view === 'archived' && !archived) continue;
      const lastMessage = conv.messages.filter((m) => m.role !== 'system').slice(-1)[0];
      const summary = {
        id: conv.id,
        title: conv.title,
        titlePolicy: conv.titlePolicy || 'fallback',
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        version: conv.version || 0,
        archivedAt: conv.archivedAt || null,
        messages: conv.messages.length,
        last: lastMessage?.content?.slice(0, 120) || '',
        lastRole: lastMessage?.role || null,
      };
      if (after && Number.isFinite(after) && Date.parse(conv.updatedAt) <= after) continue;
      if (query) {
        // Search the whole transcript, not only the title: "hitta chatten där
        // vi pratade om dokumentet" is the normal way people look.
        const haystack = `${conv.title}\n${conv.messages.map((m) => m.content).join('\n')}`.toLowerCase();
        if (!haystack.includes(query)) continue;
      }
      out.push(summary);
    }
    // Bounded: the phone's drawer never needs every conversation ever written,
    // and an unbounded list turns the menu into a full scan of the data dir.
    const sorted = out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    // Internal boot reconciliation must also see approvals older than the
    // drawer's 100-item cap. HTTP callers never request this uncapped mode.
    return limit === null ? sorted : sorted.slice(0, CONVERSATION_LIST_MAX);
  }

  /** Rename with V1's title policy: a manual title is never overwritten. */
  rename(id, title) {
    const text = String(title ?? '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 80) {
      throw Object.assign(new Error('title must be 1..80 visible characters'), { status: 400, code: 'INVALID_TITLE' });
    }
    const conv = this.get(id);
    if (!conv) throw Object.assign(new Error('conversation not found'), { status: 404, code: 'NOT_FOUND' });
    conv.title = text;
    conv.titlePolicy = 'manual';
    this.save(conv);
    return conv;
  }

  /** Archive is reversible; delete is not. They are different operations. */
  setArchived(id, archived) {
    const conv = this.get(id);
    if (!conv) throw Object.assign(new Error('conversation not found'), { status: 404, code: 'NOT_FOUND' });
    conv.archivedAt = archived ? new Date().toISOString() : null;
    this.save(conv);
    return conv;
  }

  /** Set the automatic title from the first user message, once. */
  #autoTitle(conv, text) {
    const policy = conv.titlePolicy || 'fallback';
    if (policy === 'manual') return;
    const title = String(text).replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!title) return;
    conv.title = title;
    conv.titlePolicy = 'auto';
  }

  remove(id) {
    const file = this.#file(id);
    // Validate before touching the tombstone: an invalid id must not be
    // remembered as deleted, or the list would filter a real id forever.
    if (!/^conv_[a-z0-9_]+$/.test(String(id))) return false;
    let removed = false;
    try {
      fs.unlinkSync(file);
      removed = true;
    } catch {
      removed = false;
    }
    this.cache.delete(id);
    if (removed) this.#addTombstone(id);
    return removed;
  }

  appendMessage(id, message) {
    const conv = this.get(id);
    if (!conv) throw new Error('conversation not found');
    const entry = {
      id: message.id || newId('msg'),
      at: new Date().toISOString(),
      role: message.role,
      content: String(message.content ?? ''),
      ...(message.meta ? { meta: message.meta } : {}),
    };
    conv.messages.push(entry);
    if (entry.role === 'user') this.#autoTitle(conv, entry.content);
    this.save(conv);
    return entry;
  }

  /**
   * Which conversation does this goal belong to?
   *
   * A goal is created inside a turn but does not carry the conversation id (the
   * V2 Goal schema is not ours to change). The mapping lives where it already
   * is: the assistant message's meta.goalId. Bounded by list() (100 most recent)
   * and served from the LRU cache when possible, so this stays cheap.
   */
  findByGoal(goalId) {
    if (!goalId) return null;
    // cache first: the common case is the conversation the user is looking at
    for (const conv of this.cache.values()) {
      if (conv.messages?.some((m) => m.meta?.goalId === goalId)) return conv;
    }
    for (const summary of this.list()) {
      const conv = this.get(summary.id);
      if (conv?.messages?.some((m) => m.meta?.goalId === goalId)) return conv;
    }
    return null;
  }

  /** Remember a completed turn for duplicate-request detection. */
  rememberRequest(id, requestId, outcome) {
    if (!requestId) return;
    const conv = this.get(id);
    if (!conv) return;
    conv.requests = conv.requests || {};
    conv.requests[requestId] = { at: new Date().toISOString(), ...outcome };
    const keys = Object.keys(conv.requests);
    if (keys.length > 50) delete conv.requests[keys[0]];
    this.save(conv);
  }

  getRequest(id, requestId) {
    if (!requestId) return null;
    return this.get(id)?.requests?.[requestId] || null;
  }
}

/**
 * Goals on disk, using the V2 Goal class verbatim. `reconcileOnBoot` is the
 * honest crash story: a goal saved as RUNNING when the process died did not
 * complete, and is marked BLOCKED (not silently resumed and not reported done).
 */
export const GOAL_CACHE_MAX = 200;

/**
 * States where a goal is actively being mutated by a turn. Those objects must
 * stay in memory; everything else is safely reloadable from disk (including
 * BLOCKED, which a resume loads fresh on purpose).
 */
const ACTIVE_STATES = new Set([
  STATES.RUNNING,
  STATES.WAITING_FOR_TOOL,
  STATES.WAITING_FOR_APPROVAL,
  STATES.VERIFYING,
  STATES.RECOVERING,
]);

export class GoalStore {
  constructor({ dir, cacheMax = GOAL_CACHE_MAX, onSave = null }) {
    this.dir = dir;
    this.cacheMax = cacheMax;
    this.onSave = onSave;
    fs.mkdirSync(dir, { recursive: true });
    // Live goal objects are a cache, not a registry: they exist so a turn keeps
    // mutating one instance. Loading is cheap and the file is the truth, so the
    // map is bounded like the conversation cache. Nothing is lost on eviction.
    this.live = new Map();
  }

  #remember(goal) {
    this.live.delete(goal.id);
    this.live.set(goal.id, goal);
    while (this.live.size > this.cacheMax) {
      // Only finished goals are evicted: an in-flight goal is the object an
      // active turn is mutating, and dropping it would orphan running work.
      // Finished goals reload from disk cheaply.
      const evictable = [...this.live.entries()].find(([id, g]) => id !== goal.id && !ACTIVE_STATES.has(g.state));
      if (evictable) {
        this.live.delete(evictable[0]);
        continue;
      }
      // Everything is actively executing. That is a burst, not normal operation:
      // allow a bounded overshoot rather than losing live work.
      if (this.live.size <= this.cacheMax * 4) break;
      const oldest = this.live.keys().next().value;
      if (oldest === goal.id) break;
      this.live.delete(oldest);
    }
    return goal;
  }

  track(goal) {
    return this.#remember(goal);
  }

  save(goal) {
    this.onSave?.(goal);
    goal.save(this.dir);
    return this.#remember(goal);
  }

  get(id) {
    if (!/^goal_[a-z0-9_]+$/.test(String(id))) return null;
    if (this.live.has(id)) {
      const hit = this.live.get(id);
      this.live.delete(id);
      this.live.set(id, hit);
      return hit;
    }
    const file = path.join(this.dir, `${id}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      const goal = Goal.load(file);
      return this.#remember(goal);
    } catch {
      return null;
    }
  }

  list() {
    return Goal.list(this.dir);
  }

  /**
   * Mark goals that were mid-flight when the host stopped. Returns the ids.
   *
   * The old version only looked at RUNNING and VERIFYING, and attempted
   * VERIFYING -> BLOCKED directly. That hop is not legal in V2
   * (VERIFYING exits to COMPLETED/RECOVERING/FAILED) and the throw was caught
   * and discarded — so VERIFYING goals were never reconciled at all while the
   * code claimed they were. WAITING_FOR_TOOL had the same shape and was not
   * even considered.
   *
   * Each interrupted state is now routed through hops the state machine allows.
   * A state with no honest path is left alone and reported, not silently
   * swallowed.
   */
  reconcileOnBoot({ conversations = null } = {}) {
    const moved = [];
    const stuck = [];
    const durableApprovals = new Set();
    if (conversations) for (const summary of conversations.list({ view: 'all', limit: null })) {
      const pending = conversations.get(summary.id)?.pendingApproval;
      if (hasApprovalContinuation(pending)) durableApprovals.add(pending.goalId);
    }

    for (const summary of this.list()) {
      if (summary.state === STATES.WAITING_FOR_APPROVAL && durableApprovals.has(summary.id)) continue;
      const path = interruptPath(summary.state);
      if (!path) continue; // already terminal or untouched
      const goal = this.get(summary.id);
      if (!goal) continue;
      try {
        for (const step of path) {
          goal.transition(step.to, step.reason);
        }
        this.save(goal);
        moved.push(goal.id);
      } catch (err) {
        // Never silent: an unreconciled goal keeps its stored state and is named.
        stuck.push({ id: goal.id, state: summary.state, error: String(err?.message || err) });
      }
    }

    const cleared = conversations ? clearDeadApprovals(conversations, this) : 0;
    return Object.assign(moved, { stuck, clearedApprovals: cleared });
  }
}

/**
 * How to bring an interrupted goal to a state a human can act on.
 *
 *   nothing yet executed  -> CANCELLED (no work was lost, nothing to resume)
 *   work was in flight    -> BLOCKED (resumable, and resume re-verifies)
 *
 * Returns null for states that need no change.
 */
export function interruptPath(state) {
  const reason = 'host restarted mid-task; resume explicitly';
  switch (state) {
    // nothing had run: cancelling is honest and cannot lose an effect
    case STATES.CREATED:
    case STATES.READY:
      return [{ to: STATES.CANCELLED, reason: 'host restarted before any work started' }];
    // exits straight to BLOCKED
    case STATES.RUNNING:
    case STATES.WAITING_FOR_APPROVAL:
    case STATES.RECOVERING:
    case STATES.PLANNING:
      return [{ to: STATES.BLOCKED, reason }];
    // no direct BLOCKED exit: go through RECOVERING
    case STATES.VERIFYING:
    case STATES.WAITING_FOR_TOOL:
      return [
        { to: STATES.RECOVERING, reason: 'host restarted mid-task' },
        { to: STATES.BLOCKED, reason },
      ];
    default:
      return null; // terminal, or BLOCKED already
  }
}

/**
 * A pending approval belongs to a turn that no longer exists after a restart.
 * Leaving it in place makes the UI ask the owner to approve work that was
 * already abandoned.
 */
function clearDeadApprovals(conversations, goals) {
  let cleared = 0;
  let listed = [];
  try {
    listed = conversations.list({ view: 'all', limit: null });
  } catch {
    return 0;
  }
  for (const summary of listed) {
    const conv = conversations.get(summary.id);
    if (!conv?.pendingApproval) continue;
    const goal = goals.get(conv.pendingApproval.goalId);
    if (goal && goal.state === STATES.WAITING_FOR_APPROVAL) continue; // still real
    conv.pendingApproval = null;
    try {
      conversations.save(conv);
      cleared += 1;
    } catch {
      /* an unwritable conversation is reported by its absence, not crash-looping */
    }
  }
  return cleared;
}

export function publicGoal(goal) {
  if (!goal) return null;
  const json = goal.toJSON();
  return {
    id: json.id,
    objective: json.objective,
    state: json.state,
    risk: json.risk,
    acceptance: json.acceptance,
    receipts: json.receipts.map((r) => ({
      id: r.id,
      action: r.action,
      target: r.target,
      result: r.result,
      verified: r.verified,
      acceptanceId: r.acceptanceId || null,
      evidence: r.evidence || null,
      errorClass: r.errorClass || null,
      at: r.at,
    })),
    history: json.history,
    ...(goal.revisionOf ? { revisionOf: goal.revisionOf, revision: goal.revision || 0 } : {}),
  };
}
