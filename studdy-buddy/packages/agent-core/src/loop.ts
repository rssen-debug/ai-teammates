import type { Database } from '@studdy/database';
import { createId, nowIso, stableKey } from '@studdy/shared';
import type { AiRouter } from '@studdy/ai-router';
import type { ExplanationEngine } from '@studdy/ai-router';
import { conceptById, type LearningService } from '@studdy/learning-engine';
import { PermissionGate } from './permissions.js';

/**
 * The autonomous agent runtime.
 *
 * DISCOVER -> OBSERVE -> INTERPRET -> UPDATE CONTEXT -> UPDATE MEMORY -> REASON
 * -> PLAN -> ACT WITHIN PERMISSIONS -> VERIFY -> PERSIST
 *
 * Deliberately boring technology: a durable SQLite task queue plus a bounded
 * tick loop. No endless LLM loop is possible because:
 *   - every tick claims a finite batch of tasks
 *   - each task has a max attempt count and exponential backoff
 *   - model calls only happen in `reason` handlers that the caller registers
 *   - deterministic state updates never go through the model
 */

export type TaskKind = 'OBSERVE_WINDOWS' | 'INDEX_PAGE' | 'CAPTURE_SCREEN' | 'EXPLAIN_SELECTION' | 'SUMMARISE_SESSION' | 'SCHEDULE_REVIEW';

export interface AgentTaskHandler {
  kind: TaskKind;
  /** Returns a short verification message on success. */
  run(payload: Record<string, unknown>): Promise<string>;
}

export interface AgentLoopOptions {
  db: Database;
  handlers: AgentTaskHandler[];
  clock?: () => number;
  /** Max tasks handled per tick. Hard-capped to keep the loop bounded. */
  batchSize?: number;
  maxAttempts?: number;
}

export interface TickReport {
  claimed: number;
  succeeded: number;
  failed: number;
  skipped: string[];
  durationMs: number;
}

export class AgentLoop {
  private readonly clock: () => number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private running = false;
  private handlers = new Map<TaskKind, AgentTaskHandler>();

  constructor(private readonly options: AgentLoopOptions) {
    this.clock = options.clock ?? Date.now;
    this.batchSize = Math.min(options.batchSize ?? 5, 20);
    this.maxAttempts = options.maxAttempts ?? 3;
    for (const handler of options.handlers) this.handlers.set(handler.kind, handler);
  }

  /** Registers or replaces a handler (used when a permission is granted at runtime). */
  register(handler: AgentTaskHandler): void {
    this.handlers.set(handler.kind, handler);
  }

  enqueue(kind: TaskKind, payload: Record<string, unknown>, delayMs = 0): string {
    return this.options.db.tasks.enqueue(kind, payload, new Date(this.clock() + delayMs).toISOString());
  }

  status(): { running: boolean; counts: Record<string, number>; handlers: string[] } {
    return {
      running: this.running,
      counts: this.options.db.tasks.counts(),
      handlers: [...this.handlers.keys()],
    };
  }

  /** One bounded pass over the queue. Safe to call from a timer. */
  async tick(): Promise<TickReport> {
    const started = this.clock();
    const skipped: string[] = [];
    const tasks = this.options.db.tasks.claim(this.batchSize);
    let succeeded = 0;
    let failed = 0;

    for (const task of tasks) {
      const handler = this.handlers.get(task.kind as TaskKind);
      if (!handler) {
        skipped.push(`${task.kind}: ingen hanterare registrerad`);
        // Do not burn attempts on a task nobody can run; park it as failed so
        // the queue cannot grow silently forever.
        this.options.db.tasks.fail(task.id, `no handler for ${task.kind}`, new Date(this.clock() + 60_000).toISOString());
        failed += 1;
        continue;
      }
      try {
        const result = await handler.run((task.payload ?? {}) as Record<string, unknown>);
        this.options.db.tasks.complete(task.id);
        this.options.db.observations.record('agent.task.done', { kind: task.kind, result });
        succeeded += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const attempts = task.attempts + 1;
        const delay = Math.min(60_000, 1000 * 2 ** attempts);
        this.options.db.tasks.fail(task.id, message, new Date(this.clock() + delay).toISOString());
        this.options.db.observations.record('agent.task.failed', { kind: task.kind, message, attempts });
        failed += 1;
      }
    }

    return {
      claimed: tasks.length,
      succeeded,
      failed,
      skipped,
      durationMs: this.clock() - started,
    };
  }

  /** Recovers from a crash: requeue anything left RUNNING by a dead process. */
  recover(): number {
    return this.options.db.tasks.recoverOrphans();
  }
}

// ---------------------------------------------------------------------------
// Session continuity
// ---------------------------------------------------------------------------

export interface ResumeSummary {
  sessionId: string;
  /** Honest, evidence-based greeting. Null when there is nothing to resume. */
  greeting: string | null;
  lastNodeTitle: string | null;
  lastCourseId: string | null;
  dueReviews: string[];
  recentTopics: string[];
}

/**
 * Produces the "welcome back" message. Every sentence must be traceable to a
 * stored record; if there is no history we say nothing rather than inventing a
 * friendly fiction about what the student did yesterday.
 */
function conceptLabel(id: string): string {
  return conceptById(id)?.label ?? id;
}

export function buildResumeSummary(db: Database, learning: LearningService, clock: () => number = Date.now): ResumeSummary {
  const session = db.sessions.latestOpen() ?? db.sessions.recent(1)[0] ?? null;
  const due = learning.dueReviews(5).map((r) => r.conceptId);
  const snap = learning.snapshot();
  const recentTopics = snap.strongest.slice(0, 2);

  if (!session) {
    // No session history, but reviews may still be due from an earlier install
    // of the learning record. Say only what the evidence supports.
    const greeting =
      due.length > 0
        ? `Det är dags att repetera: ${due.map((id) => conceptLabel(id)).join(', ')}.`
        : null;
    return {
      sessionId: '',
      greeting,
      lastNodeTitle: null,
      lastCourseId: null,
      dueReviews: due,
      recentTopics,
    };
  }

  const parts: string[] = [];
  if (session.lastNodeTitle) {
    parts.push(`Förra gången var du på "${session.lastNodeTitle}".`);
  }
  if (due.length) {
    parts.push(`Det är dags att repetera: ${due.map((id) => conceptLabel(id)).join(', ')}.`);
  }
  if (!session.lastNodeTitle && due.length === 0) {
    const practiced = snap.concepts.filter((c) => c.state !== 'NOT_SEEN');
    if (practiced.length) {
      parts.push(`Du har övat på ${practiced.slice(0, 3).map((c) => c.label).join(', ')}.`);
    }
  }

  void clock;
  return {
    sessionId: session.id,
    greeting: parts.length ? parts.join(' ') : null,
    lastNodeTitle: session.lastNodeTitle,
    lastCourseId: session.courseId,
    dueReviews: due,
    recentTopics,
  };
}

// ---------------------------------------------------------------------------
// Perception scheduler (cost control)
// ---------------------------------------------------------------------------

/**
 * Decides whether a change in observed state is worth an AI call.
 *
 * Requirement 27: EVENT -> inspect -> state diff -> classify -> extract ->
 * AI ONLY IF NEEDED -> memory. This class is the "if needed" gate, with
 * deduplication by content hash so the same page/topology never costs twice.
 */
export class PerceptionScheduler {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly clock: () => number = Date.now,
    /** How long a repeated observation is considered the same event. */
    private readonly dedupeWindowMs = 5 * 60_000,
  ) {}

  /** Returns true when the event is new enough to act on. */
  shouldProcess(kind: string, contentParts: (string | null | undefined)[]): boolean {
    const key = `${kind}:${stableKey(...contentParts)}`;
    const last = this.seen.get(key);
    const now = this.clock();
    if (last !== undefined && now - last < this.dedupeWindowMs) return false;
    this.seen.set(key, now);
    // Bound the map so a long session cannot grow it without limit.
    if (this.seen.size > 500) {
      const oldest = [...this.seen.entries()].sort((a, b) => a[1] - b[1]).slice(0, 100);
      for (const [k] of oldest) this.seen.delete(k);
    }
    return true;
  }

  /** Screenshot dedupe by perceptual-ish hash of the (already downscaled) image bytes. */
  static imageFingerprint(bytesBase64: string): string {
    // Cheap and stable: sample the string rather than decoding the image.
    const step = Math.max(1, Math.floor(bytesBase64.length / 256));
    let sample = '';
    for (let i = 0; i < bytesBase64.length; i += step) sample += bytesBase64[i];
    return stableKey(sample, String(bytesBase64.length));
  }

  reset(): void {
    this.seen.clear();
  }
}

export interface AgentServices {
  db: Database;
  router: AiRouter;
  explainer: ExplanationEngine;
  learning: LearningService;
  permissions: PermissionGate;
  clock?: () => number;
}

/** Convenience factory wiring the pieces the IPC layer needs. */
export function createAgentRuntime(services: AgentServices): { loop: AgentLoop; scheduler: PerceptionScheduler } {
  const loop = new AgentLoop({
    db: services.db,
    handlers: [],
    clock: services.clock,
  });
  return { loop, scheduler: new PerceptionScheduler(services.clock) };
}

export function newObservationId(): string {
  return createId('obs');
}

export function timestamp(): string {
  return nowIso();
}
