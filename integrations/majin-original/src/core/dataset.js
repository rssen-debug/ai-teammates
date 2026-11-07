// Trajectory capture — the only thing MAJIN keeps that is about *how it worked* rather than
// what it found. Opt-in, local, redacted, and readable by a training pipeline without a parser.
//
// Why this exists: an agent gets better from its own trajectories (plan → tool calls → result →
// correction → final answer, plus a thumbs up/down). Nothing here leaves the machine unless the
// user exports it; upload is hard-blocked so a config typo cannot turn a personal Windows box into
// a data source.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dirs, resolveData } from './paths.js';

const OPT_OUT = /\b(do not|don't|dont|never)\s+(save|store|record|log|keep|capture)\b|hemliga|dokumentera\s+inte/i;

// What a redactor must catch on a real machine: provider keys, MAJIN's own token, JWTs, bearer
// strings, absolute home paths and the username. Deliberately conservative — it replaces with a
// typed placeholder so a reader still knows *something* was there.
export function redact(text, cfg) {
  let s = String(text ?? '');
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const user = process.env.USER || process.env.USERNAME || '';
  // Ordningen spelar roll: "Authorization: Bearer sk-..." maste fa sitt huvud bortklippt innan
  // radnyckelregeln annars bara ser en redan-ersatt plats och Bearer-monstret aldrig matchar.
  if (cfg?.file) s = s.split(path.dirname(cfg.file)).join('<MAJIN_HOME>');
  if (home) s = s.split(home).join('<HOME>');
  if (user && user.length > 2) s = s.split(user).join('<USER>');
  if (cfg?.get?.('server.token')) s = s.split(String(cfg.get('server.token'))).join('<TOKEN>');
  s = s
    .replace(/\b(authorization|proxy-authorization|x-api-key|api[_-]?key|apikey|bottoken|bot_token|password|passwd|secret)\b(\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?(?:"[^"]*"|'[^']*'|[^\s,}]{4,})/gi, '$1$2<REDACTED>')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._\-\/=+]{8,}/gi, '$1 <TOKEN>')
    .replace(/\b(sk|pk|key|ghp|xoxb|nanogpt|AIza)[_-][A-Za-z0-9_.\-]{8,}\b/g, '<API_KEY>')
    .replace(/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{4,}\b/g, '<JWT>')
    .replace(/\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g, '<CARD>')
    .replace(/[\w.+-]+@(gmail|outlook|hotmail|yahoo|icloud|proton(mail)?)\.[\w.]+/gi, '<EMAIL>');
  return s;
}

function short(v, n = 900) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…${s.length - n}b` : s;
}

export class Dataset {
  constructor(cfg, bus) {
    this.cfg = cfg;
    this.bus = bus;
    // Strax intill configen det tillhor: dirs.root ar last vid import och kan skilja sig fran
    // den MAJIN_HOME som faktiskt anvandes for den har configen (test, flera profiler, --home).
    this.dir = resolveData(
      cfg?.get?.('dataset.dir'),
      cfg?.file ? path.join(path.dirname(cfg.file), 'dataset') : path.join(dirs.root, 'dataset'),
    );
  }

  /** Keep it bounded: a year of daily driving should not become a 2 GB folder. */
  trim() {
    const days = Number(this.cfg?.get?.('dataset.keepDays') || 0);
    if (!days || !fs.existsSync(this.file())) return { removed: 0 };
    const cut = Date.now() - days * 86400000;
    const rows = this.read();
    const keep = rows.filter((r) => new Date(r.at).getTime() >= cut);
    if (keep.length === rows.length) return { removed: 0 };
    this.writeAll(keep);
    return { removed: rows.length - keep.length };
  }

  get on() {
    return this.cfg.get('dataset.capture') === true;
  }
  include() {
    const i = this.cfg?.get?.('dataset.include') || {};
    return { answer: i.answer !== false, toolArgs: i.toolArgs !== false, plan: i.plan !== false };
  }

  ensure() {
    fs.mkdirSync(this.dir, { recursive: true });
    const consent = path.join(this.dir, 'CONSENT.json');
    if (!fs.existsSync(consent)) {
      fs.writeFileSync(
        consent,
        `${JSON.stringify(
          {
            captured: false,
            note:
              'MAJIN does not record trajectories until dataset.capture is true in the config. Redaction runs before writing. Export with majin dataset export.',
            at: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
      );
    }
    return consent;
  }

  file() {
    return path.join(this.dir, 'trajectories.jsonl');
  }

  /** One record per turn. Returns the record, or {skipped:'off'|'opt-out'} so the caller can log why. */
  capture(input, meta = {}) {
    if (!this.on) return { skipped: 'off' };
    const text = String(input ?? '');
    if (OPT_OUT.test(text)) {
      this.bus?.info?.('dataset.optout', { at: new Date().toISOString() });
      return { skipped: 'opt-out' };
    }
    this.ensure();
    const want = this.include();
    const d = new Date();
    const day = d.toISOString().slice(0, 10);
    const rec = {
      id: crypto.randomBytes(8).toString('hex'),
      v: 1,
      at: d.toISOString(),
      day,
      session: meta.session || 'desktop',
      // the shape a training run wants: instruction, decisions, tool trace, outcome
      instruction: redact(text, this.cfg),
      instructionChars: text.length,
      plan: want.plan ? (meta.plan || []).slice(0, 24).map((p) => ({ text: redact(p.text || p, this.cfg), status: p.status || 'todo' })) : [],
      job: meta.job || null,
      model: meta.model || null,
      moa: meta.moa || null,
      steps: (meta.tools || []).slice(0, 60).map((t, i) => ({
        i,
        name: t.name || t.tool || null,
        args: want.toolArgs ? redact(short(t.args ?? t.params ?? {}, 400), this.cfg) : undefined,
        ok: t.ok !== false && !t.error,
        chars: typeof t.result === 'string' ? t.result.length : undefined,
        ms: t.ms,
      })),
      answer: want.answer ? redact(short(meta.text || '', 4000), this.cfg) : null,
      usage: meta.usage || null,
      costUsd: meta.costUsd ?? null,
      stopped: Boolean(meta.stopped),
      error: meta.error ? redact(String(meta.error).slice(0, 400), this.cfg) : null,
      rating: null, // filled by rate(); a turn nobody rated is unlabeled, not "good"
    };
    fs.appendFileSync(this.file(), `${JSON.stringify(rec)}\n`);
    this.bus?.info?.('dataset.capture', { id: rec.id, tools: rec.steps.length });
    return { ok: true, record: rec };
  }

  /** Thumbs up/down on the newest matching turn — the label is the valuable part. */
  rate(query, score = 1) {
    const lines = this.read();
    if (!lines.length) return { ok: false, error: 'no records yet' };
    const q = String(query || '').toLowerCase();
    for (let i = lines.length - 1; i >= 0; i--) {
      const r = lines[i];
      if (q && !`${r.instruction} ${r.answer}`.toLowerCase().includes(q)) continue;
      r.rating = Math.max(-1, Math.min(1, Number(score) || 0));
      r.ratedAt = new Date().toISOString();
      this.writeAll(lines);
      return { ok: true, id: r.id, rating: r.rating };
    }
    return { ok: false, error: `no record matching "${query}"` };
  }

  read() {
    const f = this.file();
    if (!fs.existsSync(f)) return [];
    return fs
      .readFileSync(f, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  writeAll(lines) {
    this.ensure();
    fs.writeFileSync(this.file(), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  stats() {
    const rows = this.read();
    const rated = rows.filter((r) => r.rating);
    const withTools = rows.filter((r) => r.steps?.length);
    return {
      records: rows.length,
      bytes: fs.existsSync(this.file()) ? fs.statSync(this.file()).size : 0,
      rated: rated.length,
      avgRating: rated.length ? Number((rated.reduce((a, r) => a + r.rating, 0) / rated.length).toFixed(2)) : null,
      avgToolCalls: withTools.length ? Number((withTools.reduce((a, r) => a + r.steps.length, 0) / withTools.length).toFixed(1)) : null,
      errors: rows.filter((r) => r.error).length,
      days: [...new Set(rows.map((r) => r.day))].slice(-14),
      file: this.file(),
    };
  }

  /** JSONL export. `clean` strips the raw answer text, which is what a public dataset usually ships. */
  export({ out, clean = false } = {}) {
    const rows = this.read();
    if (!rows.length) return { ok: false, error: 'nothing captured yet (dataset.capture is off or no turns saved)' };
    const body = (clean
      ? rows.map((r) => ({ id: r.id, at: r.at, job: r.job, model: r.model, steps: r.steps.map((s) => s.name), rating: r.rating, usage: r.usage }))
      : rows
    )
      .map((r) => JSON.stringify(r))
      .join('\n');
    const file = out ? path.resolve(this.cfg.get('workspace'), out) : path.join(this.dir, `export-${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${body}\n`);
    return { ok: true, file, records: rows.length, bytes: fs.statSync(file).size };
  }

  /** Right to be forgotten: drop records, or everything. */
  purge({ id, before, all = false } = {}) {
    if (!all && !id && !before) return { ok: false, error: 'id, before or all is required' };
    const rows = this.read();
    const cut = before ? new Date(before).getTime() : null;
    const keep = rows.filter((r) => {
      if (all) return false;
      if (id && r.id === id) return false;
      if (cut && new Date(r.at).getTime() < cut) return false;
      return true;
    });
    this.writeAll(keep);
    return { ok: true, removed: rows.length - keep.length, left: keep.length };
  }
}

export const DATASET_DOCS = `MAJIN dataset (local, opt-in)
  capture=false by default; nothing is recorded until you say "learn from my runs" or set dataset.capture.
  stored: <data dir>/dataset/trajectories.jsonl — instruction, plan, tool names+args, outcome, usage, rating
  always redacted on write (no switch): api keys, tokens, JWTs, home path, username, card numbers
  shared with nobody: there is no upload code and no upload key — export is an explicit command`;
