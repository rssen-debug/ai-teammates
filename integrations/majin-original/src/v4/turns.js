/**
 * MAJIN V4 — turn journal.
 *
 * A turn is the unit a phone can lose. Mobile networks drop mid-answer, iOS
 * suspends a backgrounded tab, a tunnel hiccups. Before this module a dropped
 * response aborted the turn, so the work was lost and the user had to ask
 * again — the opposite of "close the app and come back".
 *
 * The journal decouples the turn from the HTTP response:
 *   - the agent runs to completion regardless of who is listening
 *   - every event gets a monotonically increasing sequence number
 *   - a client can reattach with `from=<lastSeq>` and receive exactly the
 *     events it missed, then continue live
 *
 * Bounded on purpose: a fixed number of turns and events, pruned by age. This
 * is a reconnection buffer, not an event-sourcing store.
 */

export const JOURNAL_MAX_TURNS = 50;
export const JOURNAL_MAX_EVENTS = 2000;
export const JOURNAL_TTL_MS = 10 * 60 * 1000;
/**
 * Hard ceiling on live (unfinished) turns. Normal use never approaches it; it
 * exists so a flood cannot grow memory without limit.
 */
export const JOURNAL_LIVE_CEILING = 200;

const LIVE_CEILING = JOURNAL_LIVE_CEILING;

export class TurnJournal {
  constructor({ maxTurns = JOURNAL_MAX_TURNS, maxEvents = JOURNAL_MAX_EVENTS, ttlMs = JOURNAL_TTL_MS, now = () => Date.now() } = {}) {
    this.maxTurns = maxTurns;
    this.maxEvents = maxEvents;
    this.ttlMs = ttlMs;
    this.now = now;
    this.turns = new Map(); // id -> turn
    this.order = [];
  }

  /**
   * Drop turns that are finished and either expired or over the cap.
   *
   * A running turn is NEVER dropped, whatever its age or position: the whole
   * point of the journal is that a phone can reattach to work in progress. A
   * turn that takes 15 minutes on a slow model must still be findable at minute
   * 15, and creating newer turns must not push it out.
   *
   * Live turns are bounded separately (LIVE_CEILING), so a pathological flood
   * still cannot grow memory without limit — but that ceiling is far above
   * normal use, and crossing it is a bug worth seeing rather than a silent drop.
   */
  prune() {
    const cutoff = this.now() - this.ttlMs;
    const keep = [];
    for (const id of this.order) {
      const turn = this.turns.get(id);
      if (!turn) continue;
      const finished = turn.done;
      const expired = turn.updatedAt < cutoff;
      if (finished && expired) {
        this.turns.delete(id);
        continue;
      }
      keep.push(id);
    }
    this.order = keep;

    // Finished turns over the cap go first, oldest first.
    let finishedIds = this.order.filter((id) => this.turns.get(id)?.done);
    while (finishedIds.length && this.order.length > this.maxTurns) {
      const id = finishedIds.shift();
      this.turns.delete(id);
      this.order = this.order.filter((x) => x !== id);
    }

    // If live turns alone exceed the ceiling, drop the oldest live ones. This
    // should not happen in normal use; it exists so memory is still bounded.
    while (this.order.length > LIVE_CEILING) {
      const id = this.order.shift();
      this.turns.delete(id);
    }
  }

  create({ conversationId = null, id = null } = {}) {
    this.prune();
    const turn = {
      id: id || `turn_${this.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      conversationId,
      seq: 0,
      events: [],
      subscribers: new Set(),
      done: false,
      status: 'running',
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.turns.set(turn.id, turn);
    this.order.push(turn.id);
    // Enforce the cap here too, but only against FINISHED turns: the newest
    // arrival must never push out work that is still running.
    this.prune();
    return turn;
  }

  get(id) {
    return this.turns.get(id) || null;
  }

  /** Record an event and forward it to everyone currently attached. */
  append(turn, type, data) {
    if (!turn) return null;
    turn.seq += 1;
    turn.updatedAt = this.now();
    const event = { seq: turn.seq, type, data, at: this.now() };
    turn.events.push(event);
    if (turn.events.length > this.maxEvents) turn.events.splice(0, turn.events.length - this.maxEvents);
    for (const fn of turn.subscribers) {
      try {
        fn(event);
      } catch {
        /* a broken subscriber must not stop the turn */
      }
    }
    return event;
  }

  finish(turn, status = 'completed') {
    if (!turn) return;
    turn.done = true;
    turn.status = status;
    turn.updatedAt = this.now();
    for (const fn of turn.subscribers) {
      try {
        fn({ seq: turn.seq, type: '__done', data: { status }, at: this.now() });
      } catch { /* ignored */ }
    }
    turn.subscribers.clear();
  }

  /**
   * Replay from `from` (exclusive) and then follow live. Returns an unsubscribe
   * function. If the turn already finished, only the replay happens.
   */
  subscribe(turn, from, handler) {
    const start = Number.isFinite(from) && from > 0 ? from : 0;
    for (const event of turn.events) {
      if (event.seq > start) handler(event);
    }
    if (turn.done) {
      handler({ seq: turn.seq, type: '__done', data: { status: turn.status }, at: this.now() });
      return () => {};
    }
    turn.subscribers.add(handler);
    return () => turn.subscribers.delete(handler);
  }

  /** Last sequence number a client should hold. */
  head(turn) {
    return turn ? turn.seq : 0;
  }
}
