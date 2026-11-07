/**
 * MAJIN — log + event bus.
 * Everything the agent does is a named event: the UI, the CLI, the log file and
 * every channel are just four different readers of the same stream.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dirs } from './paths.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const CAP = 2000;

class Bus {
  constructor() {
    this.events = [];
    this.subs = new Set();
    this.seq = 0;
    this.file = null;
  }

  openFile(dir = dirs.logs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 10);
      this.file = fs.createWriteStream(path.join(dir, `majin-${stamp}.jsonl`), { flags: 'a' });
    } catch {
      this.file = null;
    }
    return this;
  }

  emit(type, data = {}, level = 'info') {
    const seq = ++this.seq;
    // Domain IDs (for example approval IDs) are used by action buttons.
    // Keep them separate from the monotonic event-stream cursor.
    const ev = { id: seq, ...data, seq, ts: new Date().toISOString(), type, level };
    this.events.push(ev);
    if (this.events.length > CAP) this.events.splice(0, this.events.length - CAP);
    if (this.file) {
      try {
        this.file.write(JSON.stringify(ev) + '\n');
      } catch {
        /* never let logging kill the agent */
      }
    }
    for (const fn of this.subs) {
      try {
        fn(ev);
      } catch (err) {
        void err;
      }
    }
    return ev;
  }

  sub(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  /** Prenumerera på en händelsetyp. Returnerar avprenumerering. */
  on(type, fn) {
    const off = this.sub((ev) => {
      if (ev.type === type) fn(ev);
    });
    return off;
  }

  tail(n = 200, afterSeq = 0) {
    return this.events.filter((e) => e.seq > afterSeq).slice(-n);
  }

  log(level, msg, extra = {}) {
    return this.emit('log', { msg, ...extra }, level);
  }

  debug(msg, extra) {
    return this.log('debug', msg, extra);
  }

  info(msg, extra) {
    return this.log('info', msg, extra);
  }

  warn(msg, extra) {
    return this.log('warn', msg, extra);
  }

  error(msg, extra) {
    return this.log('error', msg, extra);
  }

  async *stream({ fromSeq = this.seq, signal } = {}) {
    let cursor = fromSeq;
    const queue = [];
    let wake = null;
    const off = this.sub((ev) => {
      queue.push(ev);
      wake?.();
    });
    try {
      for (const ev of this.tail(CAP, cursor)) {
        cursor = ev.seq;
        yield ev;
      }
      while (!signal?.aborted) {
        if (!queue.length) {
          await new Promise((res) => {
            wake = res;
            const t = setTimeout(res, 15000);
            t.unref?.();
          });
          wake = null;
          if (!queue.length) {
            yield { type: 'ping', ts: new Date().toISOString() };
            continue;
          }
        }
        while (queue.length) {
          const ev = queue.shift();
          cursor = ev.seq;
          yield ev;
        }
      }
    } finally {
      off();
    }
  }
}

export const bus = new Bus();
export const LEVELS_ = LEVELS;

export function pretty(ev) {
  const t = ev.ts?.slice(11, 19) ?? '';
  if (ev.type === 'log') return `${t} ${ev.level.toUpperCase().padEnd(5)} ${ev.msg}`;
  return `${t} ${ev.type} ${JSON.stringify(omit(ev))}`;
}

function omit(ev) {
  const { id, ts, type, level, ...rest } = ev;
  void id;
  void ts;
  void type;
  void level;
  return rest;
}
