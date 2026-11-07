/**
 * MAJIN W10 LEARNING-LOOP — measured mistakes become durable lessons, and
 * lessons can be DEMOTED when the same failure returns. No placebo metrics:
 *
 *  - a lesson starts UNVERIFIED; verify requires an explicit proof string
 *    naming HOW it was measured (spoken result, command, test name) —
 *    "fixed" without measurement stays marked "claimed, not proven"
 *  - re-recording the same failure trigger AFTER verification demotes the
 *    lesson to 'regressed' with the old proof archived — because the proof
 *    apparently did not hold
 *  - stats report demotions and unansweredClaim counts FIRST, so the loop
 *    surfaces what is KNOWN-BAD before what looks good
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const VERSION = 'majin-learn/1';

const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 240);

export class LessonStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'lessons.jsonl');
    this._cache = null;
  }
  _load() {
    if (this._cache) return this._cache;
    this._cache = [];
    let lines = [];
    try { lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean); } catch { /* empty store is a valid store */ }
    for (const l of lines) {
      try {
        const e = JSON.parse(l);
        if (e?.id && e?.trigger) this._cache.push(e);
      } catch { /* torn line — keep the rest of the log */ }
    }
    return this._cache;
  }
  _emit(e) {
    fs.appendFileSync(this.file, JSON.stringify(e) + '\n');
    (this._cache || []).push(e);
  }
  /** Latest record state per lesson key. */
  byId() {
    const m = new Map();
    for (const e of this._load()) m.set(e.id, e);
    return m;
  }

  record({ trigger, lesson, fix = '', source = 'agent' }) {
    const t = norm(trigger);
    if (!t || t.length < 8) return { ok: false, error: { code: 'bad_input', message: 'trigger must describe the failure concretely (≥8 chars), not "it broke"' } };
    const key = 'les-' + crypto.createHash('sha256').update(t).digest('hex').slice(0, 12);
    const prev = this.byId().get(key);
    if (!prev) {
      const rec = { id: key, trigger: String(trigger).trim().slice(0, 280), lesson: String(lesson || '').trim().slice(0, 400), fix: String(fix || '').slice(0, 400), source: String(source).slice(0, 80), status: 'unverified', count: 1, proofs: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      this._emit(rec);
      return { ok: true, occasion: 'new', record: rec };
    }
    const demoted = prev.status === 'verified';
    const rec = {
      ...prev,
      count: prev.count + 1,
      status: demoted ? 'regressed' : prev.status,
      lesson: lesson ? String(lesson).trim().slice(0, 400) : prev.lesson,
      fix: fix ? String(fix).slice(0, 400) : prev.fix,
      regressedAt: demoted ? new Date().toISOString() : prev.regressedAt || null,
      demotions: (prev.demotions || 0) + (demoted ? 1 : 0),
      updatedAt: new Date().toISOString(),
    };
    this._emit(rec);
    return { ok: true, occasion: demoted ? 'regression' : 'reoccurrence', record: rec, honest: demoted ? 'the stored proof did NOT hold — proof archived, lesson demoted to regressed' : undefined };
  }

  verify({ id, proof }) {
    const rec = this.byId().get(id);
    if (!rec) return { ok: false, error: { code: 'unknown_lesson', message: `no lesson with id ${id} — list them with ma.lessons` } };
    const p = String(proof || '').trim();
    if (p.length < 20) {
      return { ok: false, error: { code: 'proof_required', message: 'verify refuses without a concrete proof (≥20 chars): name the measurement — command, test, or observed result. A bald "fixed now" is exactly what the loop forbids.' } };
    }
    const next = { ...rec, status: 'verified', verifiedAt: new Date().toISOString(), proofs: [...(rec.proofs || []), { proof: p.slice(0, 400), at: new Date().toISOString() }], updatedAt: new Date().toISOString() };
    this._emit(next);
    return { ok: true, record: next };
  }

  list({ status = null, cap = 100 } = {}) {
    const all = [...this.byId().values()].sort((a, b) => (b.demotions || 0) - (a.demotions || 0) || b.count - a.count);
    const f = status ? all.filter((r) => r.status === status) : all;
    return f.slice(0, cap);
  }

  stats() {
    const all = [...this.byId().values()];
    const by = { unverified: 0, verified: 0, regressed: 0 };
    let demotionsTotal = 0, occurrences = 0;
    for (const r of all) { by[r.status] = (by[r.status] || 0) + 1; demotionsTotal += r.demotions || 0; occurrences += r.count; }
    return { total: all.length, occurrences, demotionsTotal, by, openness: by.unverified + by.regressed };
  }
}

export function renderStats(stats, version = VERSION) {
  return [
    `learn-loop ${version}`,
    `  lessons recorded: ${stats.total} (${stats.occurrences} total occurrences)`,
    `  OPEN (unverified + regressed): ${stats.openness}  ← what needs proof first`,
    `  verified: ${stats.by.verified} | regressed proofs: ${stats.demotionsTotal} (proofs that did NOT hold — honesty metric)`,
  ].join('\n');
}
