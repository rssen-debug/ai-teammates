/**
 * MAJIN V6 — append-only structured JSONL event log.
 *
 * This is the only source for the status report. Nothing in the report is
 * invented; if an event was never written, the report says so.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, nowIso } from './util.js';
import { scrub } from './redact.js';

export const EVENT_SCHEMA = 'majin.v6.event/v1';

export const EVENT_TYPES = Object.freeze([
  'engine.started', 'engine.stopped', 'engine.budget_reached', 'engine.idle', 'engine.error',
  'heartbeat', 'task.queued', 'task.claimed', 'task.progress', 'task.completed', 'task.blocked',
  'task.failed', 'task.uncertain', 'task.cancelled', 'task.deduplicated', 'task.recovered',
  'tool.started', 'tool.completed', 'tool.failed', 'tool.cancelled',
  'worker.assigned', 'worker.stalled', 'worker.recovered', 'watchdog.healthy', 'watchdog.stalled',
  'permission.blocked', 'browser.blocker', 'checkpoint.written', 'receipt.observed',
  'job.discovered', 'job.matched', 'job.state', 'job.submitted', 'job.confirmed', 'gmail.checked',
  'sync.skipped', 'sync.completed', 'sync.refused', 'mcp.started', 'mcp.stopped', 'mcp.call',
]);

export class EventLog {
  constructor(dir, { maxBytes = 8 * 1024 * 1024, keepArchives = 5, clock = Date.now } = {}) {
    this.dir = ensureDir(dir);
    this.file = path.join(this.dir, 'events.jsonl');
    this.maxBytes = maxBytes;
    this.keepArchives = keepArchives;
    this.clock = clock;
    this.seq = this.#lastSeq();
  }

  #lastSeq() {
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
          try {
            const parsed = JSON.parse(lines[i]);
            if (Number.isInteger(parsed.seq)) return parsed.seq;
          } catch { /* skip a torn trailing line */ }
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch { /* a missing log starts at zero */ }
    return 0;
  }

  #rotateIfNeeded() {
    try {
      if (fs.statSync(this.file).size < this.maxBytes) return;
    } catch { return; }
    const archive = path.join(this.dir, `events-${nowIso(this.clock).replaceAll(':', '-')}.jsonl`);
    fs.renameSync(this.file, archive);
    const archives = fs.readdirSync(this.dir).filter((f) => /^events-.*\.jsonl$/.test(f)).sort();
    for (const old of archives.slice(0, Math.max(0, archives.length - this.keepArchives))) {
      fs.rmSync(path.join(this.dir, old), { force: true });
    }
  }

  append(type, data = {}) {
    if (!EVENT_TYPES.includes(type) && !type.startsWith('v6.')) {
      throw Object.assign(new Error(`Unknown V6 event type: ${type}`), { code: 'EVENT_TYPE_UNKNOWN' });
    }
    this.#rotateIfNeeded();
    const event = {
      schema: EVENT_SCHEMA,
      seq: ++this.seq,
      at: nowIso(this.clock),
      type,
      ...(data && data.taskId ? { taskId: String(data.taskId).slice(0, 160) } : {}),
      ...(data && data.workerId ? { workerId: String(data.workerId).slice(0, 80) } : {}),
      data: scrub(data || {}),
    };
    fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    return event;
  }

  read({ since = null, types = null, taskId = null, limit = 500 } = {}) {
    const files = fs.existsSync(this.dir)
      ? fs.readdirSync(this.dir).filter((f) => /^events(-.*)?\.jsonl$/.test(f)).sort()
      : [];
    const wanted = Array.isArray(types) && types.length ? new Set(types) : null;
    const events = [];
    for (const name of files) {
      const full = path.join(this.dir, name);
      let text = '';
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (since && event.at < since) continue;
        if (wanted && !wanted.has(event.type)) continue;
        if (taskId && event.taskId !== taskId) continue;
        events.push(event);
      }
    }
    events.sort((a, b) => (a.seq === b.seq ? String(a.at).localeCompare(String(b.at)) : a.seq - b.seq));
    return events.slice(Math.max(0, events.length - Math.max(1, limit)));
  }

  tail(count = 20) {
    return this.read({ limit: count });
  }

  /** Real counts for the status report. */
  summarize({ windowMs = 60 * 60 * 1000, clock = this.clock } = {}) {
    const since = new Date(clock() - windowMs).toISOString();
    const events = this.read({ since, limit: 5000 });
    const counts = {};
    for (const event of events) counts[event.type] = (counts[event.type] || 0) + 1;
    const last = events.at(-1) || null;
    return { windowMs, since, counts, lastAt: last?.at || null, lastType: last?.type || null, total: events.length };
  }
}
