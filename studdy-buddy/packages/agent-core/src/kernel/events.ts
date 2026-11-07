/**
 * Unified kernel — append-only structured JSONL event log.
 *
 * Ported from MAJIN V6 (`src/v6/events.js`). This is the only source for the
 * status report. Nothing in the report is invented; if an event was never
 * written, the report says so.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, nowIso, type Clock } from './util.js';
import { scrub } from './redact.js';

export const EVENT_SCHEMA = 'studdy.kernel.event/v1';

export const EVENT_TYPES = Object.freeze([
  'engine.started', 'engine.stopped', 'engine.budget_reached', 'engine.idle', 'engine.error',
  'heartbeat', 'task.queued', 'task.claimed', 'task.progress', 'task.completed', 'task.blocked',
  'task.failed', 'task.uncertain', 'task.cancelled', 'task.deduplicated', 'task.recovered',
  'tool.started', 'tool.completed', 'tool.failed', 'tool.cancelled',
  'worker.assigned', 'worker.stalled', 'worker.recovered', 'watchdog.healthy', 'watchdog.stalled',
  'permission.blocked', 'browser.blocker', 'checkpoint.written', 'receipt.observed',
  'job.discovered', 'job.matched', 'job.state', 'job.submitted', 'job.confirmed', 'gmail.checked',
  'sync.skipped', 'sync.completed', 'sync.refused', 'mcp.started', 'mcp.stopped', 'mcp.call',
  // Legacy Buddy / Omega bridge events (single-agent surface over the same core).
  'buddy.probe', 'buddy.blocked', 'buddy.verified', 'buddy.planned', 'buddy.refused',
] as const);

export type EventType = (typeof EVENT_TYPES)[number];

export interface KernelEvent {
  schema: string;
  seq: number;
  at: string;
  type: string;
  taskId?: string;
  workerId?: string;
  data: Record<string, unknown>;
}

export interface EventLogOptions {
  maxBytes?: number;
  keepArchives?: number;
  clock?: Clock;
}

export class EventLog {
  readonly dir: string;
  readonly file: string;
  readonly maxBytes: number;
  readonly keepArchives: number;
  readonly clock: Clock;
  private seq: number;

  constructor(dir: string, { maxBytes = 8 * 1024 * 1024, keepArchives = 5, clock = Date.now }: EventLogOptions = {}) {
    this.dir = ensureDir(dir);
    this.file = path.join(this.dir, 'events.jsonl');
    this.maxBytes = maxBytes;
    this.keepArchives = keepArchives;
    this.clock = clock;
    this.seq = this.lastSeq();
  }

  private lastSeq(): number {
    try {
      const stat = fs.statSync(this.file);
      if (!stat.size) return 0;
      const fd = fs.openSync(this.file, 'r');
      try {
        const size = 64 * 1024;
        const start = Math.max(0, stat.size - size);
        const buffer = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buffer, 0, buffer.length, start);
        const lines = buffer.toString('utf8').trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const line = lines[i];
          if (!line) continue;
          try {
            const parsed = JSON.parse(line) as { seq?: unknown };
            if (Number.isInteger(parsed.seq)) return Number(parsed.seq);
          } catch {
            /* skip a torn trailing line */
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* a missing log starts at zero */
    }
    return 0;
  }

  private rotateIfNeeded(): void {
    try {
      if (fs.statSync(this.file).size < this.maxBytes) return;
    } catch {
      return;
    }
    const archive = path.join(this.dir, `events-${nowIso(this.clock).replaceAll(':', '-')}.jsonl`);
    fs.renameSync(this.file, archive);
    const archives = fs.readdirSync(this.dir).filter((f) => /^events-.*\.jsonl$/.test(f)).sort();
    for (const old of archives.slice(0, Math.max(0, archives.length - this.keepArchives))) {
      fs.rmSync(path.join(this.dir, old), { force: true });
    }
  }

  append(type: string, data: Record<string, unknown> = {}): KernelEvent {
    if (!(EVENT_TYPES as readonly string[]).includes(type) && !type.startsWith('kernel.')) {
      throw Object.assign(new Error(`Unknown kernel event type: ${type}`), { code: 'EVENT_TYPE_UNKNOWN' });
    }
    this.rotateIfNeeded();
    this.seq += 1;
    const head: KernelEvent = {
      schema: EVENT_SCHEMA,
      seq: this.seq,
      at: nowIso(this.clock),
      type,
      data: scrub(data) as Record<string, unknown>,
    };
    if (data.taskId) head.taskId = String(data.taskId).slice(0, 160);
    if (data.workerId) head.workerId = String(data.workerId).slice(0, 80);
    fs.appendFileSync(this.file, `${JSON.stringify(head)}\n`, { mode: 0o600 });
    return head;
  }

  read({ since = null, types = null, taskId = null, limit = 500 }: {
    since?: string | null;
    types?: string[] | null;
    taskId?: string | null;
    limit?: number;
  } = {}): KernelEvent[] {
    const files = fs.existsSync(this.dir)
      ? fs.readdirSync(this.dir).filter((f) => /^events(-.*)?\.jsonl$/.test(f)).sort()
      : [];
    const wanted = Array.isArray(types) && types.length ? new Set(types) : null;
    const events: KernelEvent[] = [];
    for (const name of files) {
      let text = '';
      try {
        text = fs.readFileSync(path.join(this.dir, name), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let event: KernelEvent;
        try {
          event = JSON.parse(line) as KernelEvent;
        } catch {
          continue;
        }
        if (!event || typeof event.type !== 'string') continue;
        if (since && event.at < since) continue;
        if (wanted && !wanted.has(event.type)) continue;
        if (taskId && event.taskId !== taskId) continue;
        events.push(event);
      }
    }
    events.sort((a, b) => (a.seq === b.seq ? String(a.at).localeCompare(String(b.at)) : a.seq - b.seq));
    return events.slice(Math.max(0, events.length - Math.max(1, limit)));
  }

  tail(count = 20): KernelEvent[] {
    return this.read({ limit: count });
  }

  /** Real counts for the status report. */
  summarize({ windowMs = 60 * 60 * 1000, clock = this.clock }: { windowMs?: number; clock?: Clock } = {}): {
    windowMs: number;
    since: string;
    counts: Record<string, number>;
    lastAt: string | null;
    lastType: string | null;
    total: number;
  } {
    const since = new Date(clock() - windowMs).toISOString();
    const events = this.read({ since, limit: 5000 });
    const counts: Record<string, number> = {};
    for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
    const last = events.length ? events[events.length - 1] : null;
    return {
      windowMs,
      since,
      counts,
      lastAt: last?.at ?? null,
      lastType: last?.type ?? null,
      total: events.length,
    };
  }
}
