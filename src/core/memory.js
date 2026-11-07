/**
 * MAJIN — memory + skills.
 * Plain files in the data dir: facts.md (vem användaren är), events.jsonl (vad som hänt),
 * skills/*.md (hur man gör saker). Agenten skriver i dem själv — det är hela "vuxen"-delen.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dirs, resolveData } from './paths.js';
import { bus } from './log.js';

const stop = new Set(['och', 'att', 'det', 'som', 'för', 'med', 'den', 'the', 'and', 'this', 'that', 'with', 'from', 'jag', 'du', 'pa', 'på', 'av', 'en', 'et', 'at', 'är', 'ar', 'har', 'ha', 'ska', 'borde', 'kunde']);

function words(s) {
  /* s23 (real-world audit 2026-10-20): code-tokens like "IRONWOOD-799" or
     "order.1234" were kept WHOLE (with '.' and '-'), so a single-token recall
     ("IRONWOOD") never matched. Split on everything that is not a letter or
     number — symmetric for fact AND query, so hyphenated/dot facts recall. */
  return String(s || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !stop.has(w));
}

function tokenize(s) {
  return new Set(words(s));
}

export class Memory {
  constructor(cfg) {
    this.cfg = cfg;
    this.dir = resolveData(cfg?.get('memory.dir'), dirs.memory);
    fs.mkdirSync(this.dir, { recursive: true });
    /* WAVE 3 (§9) — delta memory protocol. facts.md stays the materialized
       view (read path untouched); every mutation additionally lands in an
       append-only delta log under a monotonic revision. That makes memory
       changes auditable, lets sessions detect staleness via an injection
       ledger, and turns no-op writes into measurable saves instead of
       silent full-file rewrites. */
    this.stateFile = path.join(this.dir, 'memory-state.json');
    this.deltasFile = path.join(this.dir, 'memory-deltas.jsonl');
    const st = this._loadState();
    this._rev = st.rev;
    this._sessions = st.sessions;
  }

  _loadState() {
    try {
      const st = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      return {
        rev: Number.isFinite(st.rev) && st.rev >= 0 ? Math.floor(st.rev) : 0,
        sessions: st.sessions && typeof st.sessions === 'object' ? { ...st.sessions } : {},
      };
    } catch { return { rev: 0, sessions: {} }; }
  }

  _saveState() {
    try {
      const tmp = this.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ rev: this._rev, sessions: this._sessions }) + '\n');
      fs.renameSync(tmp, this.stateFile);
    } catch (err) {
      bus.debug('memory.state.failed', { error: err.message });
    }
  }

  /** Current memory revision (monotonic; 0 = never mutated this store). */
  rev() { return this._rev; }

  _bump(kind, text) {
    this._rev += 1;
    this._saveState();
    try {
      fs.appendFileSync(this.deltasFile, JSON.stringify({ rev: this._rev, ts: new Date().toISOString(), kind, text: String(text || '').slice(0, 300) }) + '\n');
    } catch (err) {
      bus.debug('memory.delta.failed', { error: err.message });
    }
  }

  /**
   * Entries recorded AFTER fromRev, oldest first. Corrupt lines are skipped
   * individually — a torn write must never kill the whole protocol.
   * @param {number} fromRev
   */
  deltaSince(fromRev = 0, { limit = 200 } = {}) {
    const base = Number.isFinite(fromRev) ? Math.floor(fromRev) : 0;
    let lines = [];
    try { lines = fs.readFileSync(this.deltasFile, 'utf8').split('\n').filter(Boolean); } catch { return []; }
    const out = [];
    for (const l of lines.slice(-2000)) {
      try {
        const e = JSON.parse(l);
        if (Number.isFinite(e.rev) && e.rev > base) out.push(e);
      } catch { /* torn line — skip the entry, keep the log */ }
    }
    return out.slice(0, limit);
  }

  /* --- injection ledger: which rev did a session last SEE injected? --- */
  noteInjected(session = 'main') {
    const sid = String(session || 'main');
    if (this._sessions[sid] === this._rev) return { ok: true, rev: this._rev, wrote: false };
    this._sessions[sid] = this._rev;
    this._saveState();
    return { ok: true, rev: this._rev, wrote: true };
  }
  injectedRev(session = 'main') {
    const v = this._sessions[String(session || 'main')];
    return Number.isFinite(v) ? v : null;
  }
  /** >0 means the session is THIS many memory mutations behind. */
  staleness(session = 'main') {
    const v = this.injectedRev(session);
    return v === null ? this._rev : Math.max(0, this._rev - v);
  }

  get factsFile() {
    return path.join(this.dir, 'facts.md');
  }

  get eventsFile() {
    return path.join(this.dir, 'events.jsonl');
  }

  facts() {
    try {
      return fs
        .readFileSync(this.factsFile, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        // Older writes accidentally dropped bullet prefixes on existing notes.
        // Read those plain lines too, so a later save does not erase them.
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.replace(/^- /, ''));
    } catch {
      return [...(this.cfg.get('memory.facts') || [])];
    }
  }

  remember(text, tags = []) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!clean) return { ok: false, why: 'tom text' };
    const existing = this.facts();
    const tk = tokenize(clean);
    const dup = existing.findIndex((f) => {
      const ek = tokenize(f);
      const inter = [...tk].filter((w) => ek.has(w)).length;
      return ek.size && inter / Math.max(1, new Set([...tk, ...ek]).size) > 0.75;
    });
    const line = `${clean}${tags.length ? ` \`${tags.join('` \`')}\`` : ''}`;
    /* §9 no-op write elimination: an identical fact at the same slot changes
       NOTHING, so the old unconditional full-file rewrite is provably a
       wasted write. Skip it and say so — the delta protocol reports saves,
       it does not hide work. */
    if (dup >= 0 && existing[dup] === line) {
      bus.debug('memory.remember.noop', { chars: clean.length });
      return { ok: true, count: existing.length, replaced: null, unchanged: true, file: this.factsFile, rev: this._rev };
    }
    if (dup >= 0) existing[dup] = line;
    else existing.unshift(line);
    const capped = existing.slice(0, this.cfg?.get('memory.maxNotes') || 400);
    fs.writeFileSync(this.factsFile, `# Minnen\n\n${capped.map(f => '- ' + f.replace(/^- /, '')).join('\n')}\n`);
    this._bump(dup >= 0 ? 'update' : 'add', clean);
    bus.info('memory.remember', { dup: dup >= 0, chars: clean.length, rev: this._rev });
    return { ok: true, count: capped.length, replaced: dup >= 0 ? clean : null, file: this.factsFile, rev: this._rev };
  }

  forget(query) {
    const existing = this.facts();
    const q = tokenize(query);
    const keep = existing.filter((f) => {
      const k = tokenize(f.replace(/^- /, ''));
      const inter = [...q].filter((w) => k.has(w)).length;
      return !(inter >= 1 && inter / Math.max(1, q.size) > 0.5);
    });
    const removed = existing.length - keep.length;
    /* §9: no match → nothing changed → no rewrite, no revision bump. The
       event-before (silent full rewrite of identical bytes) is the class of
       silent waste delta memory exists to kill. */
    if (removed === 0) return { ok: true, removed: 0, rev: this._rev };
    fs.writeFileSync(this.factsFile, `# Minnen\n\n${keep.map(f => '- ' + f.replace(/^- /, '')).join('\n')}\n`);
    this._bump('forget', query);
    return { ok: true, removed, rev: this._rev };
  }

  event(type, data = {}) {
    try {
      fs.appendFileSync(this.eventsFile, JSON.stringify({ ts: new Date().toISOString(), type, ...data }) + '\n');
    } catch (err) {
      bus.debug('memory.event.failed', { error: err.message });
    }
    return { ok: true };
  }

  recall(query, k = 8) {
    const q = tokenize(query);
    if (!q.size) return [];
    const scored = this.facts()
      .map((f) => {
        const t = tokenize(f);
        let s = 0;
        for (const w of q) if (t.has(w)) s += 1;
        return { text: f, score: s / Math.max(3, t.size) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  recentEvents(n = 12) {
    try {
      const lines = fs.readFileSync(this.eventsFile, 'utf8').trim().split('\n').filter(Boolean).slice(-n);
      return lines.map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { type: 'raw', text: l.slice(0, 200) };
        }
      });
    } catch {
      return [];
    }
  }

  digest() {
    const cap = this.cfg?.get('memory.digestChars') || 2200;
    const facts = this.facts().slice(0, 40);
    const events = this.recentEvents(8);
    const lines = [
      facts.length ? `Knows about the user:\n${facts.map((f) => `- ${f}`).join('\n')}` : '',
      events.length ? `Latest:\n${events.map((e) => `- ${e.type}: ${String(e.summary || e.text || e.msg || '').slice(0, 120)}`).join('\n')}` : '',
    ].filter(Boolean);
    const out = lines.join('\n\n');
    return out.length > cap ? `${out.slice(0, cap)}\n…` : out;
  }

  stats() {
    return { facts: this.facts().length, events: this.recentEvents(1000).length, dir: this.dir, rev: this._rev };
  }

  /**
   * §9 delta memory for the event stream: rotate the unbounded events.jsonl
   * to a rev-stamped archive and keep only the newest `keep` entries as the
   * active working set. Content is preserved (archived, not deleted), entry
   * count is returned so callers can verify conservation.
   */
  compactEvents(keep = 200) {
    const keepN = Math.max(1, Math.floor(Number(keep) || 200));
    let lines = [];
    try { lines = fs.readFileSync(this.eventsFile, 'utf8').split('\n').filter(Boolean); } catch { return { ok: true, archived: null, kept: 0, total: 0 }; }
    if (lines.length <= keepN) return { ok: true, archived: null, kept: lines.length, total: lines.length };
    const archive = path.join(this.dir, `events.r${this._rev}.n${lines.length}.jsonl`);
    try {
      fs.writeFileSync(archive, lines.join('\n') + '\n');
      fs.writeFileSync(this.eventsFile, lines.slice(-keepN).join('\n') + '\n');
    } catch (err) {
      bus.debug('memory.compactEvents.failed', { error: err.message });
      return { ok: false, error: err.message, archived: null, total: lines.length };
    }
    bus.info('memory.compactEvents', { total: lines.length, kept: keepN, archive: path.basename(archive) });
    return { ok: true, archived: archive, kept: keepN, total: lines.length };
  }
}

/* ------------------------------- skills ----------------------------------- */

const FRONT = /^---\n([\s\S]*?)\n---\n?/;

export class Skills {
  constructor(cfg) {
    this.cfg = cfg;
    this.dir = resolveData(cfg?.get('skills.dir'), dirs.skills);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  list() {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => {
          const raw = fs.readFileSync(path.join(this.dir, f), 'utf8');
          const m = FRONT.exec(raw);
          const meta = {};
          if (m) {
            for (const line of m[1].split('\n')) {
              const i = line.indexOf(':');
              if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
            }
          }
          return { file: f, name: meta.name || f.replace(/\.md$/, ''), when: meta.when || '', tools: meta.tools || '', disabled: Boolean(meta.disabled && !/^false/.test(meta.disabled)), fails: Number(meta.fails) || 0, uses: Number(meta.uses) || 0, steps: raw.replace(FRONT, '').trim(), meta };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  /* Del 7C: outcomes are counted on DISK state, never on memory — two agents
     see the same truth, and a crash mid-run cannot fake a success streak. */
  _file(slug) { return path.join(this.dir, `${slug}.md`); }

  _readRaw(slug) {
    const raw = fs.readFileSync(this._file(slug), 'utf8');
    const m = FRONT.exec(raw);
    const meta = {};
    if (m) {
      for (const line of m[1].split('\n')) {
        const i = line.indexOf(':');
        if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
    }
    return { meta, steps: raw.replace(FRONT, '').trim() };
  }

  _writeRaw(slug, meta, steps) {
    const lines = Object.entries(meta).map(([k, v]) => `${k}: ${v}`);
    const body = `---\n${lines.join('\n')}\n---\n${(steps || '').trim()}\n`;
    const tmp = `${this._file(slug)}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, this._file(slug)); /* atomic: no torn frontmatter */
  }

  /** Record one outcome for a skill. ok=false bumps fails (resets streak);
     ok=true resets fails. At maxFails in a row the skill is disabled HONESTLY
     (never deleted — a human can re-enable when the world changed). */
  recordOutcome(slug, { ok, why = '' } = {}) {
    const maxFails = Math.max(1, Math.min(10, Number(this.cfg?.get('skills.maxFails')) || 3));
    let raw;
    try { raw = this._readRaw(slug); } catch {
      return { ok: false, why: `no skill '${slug}'` };
    }
    const meta = raw.meta;
    const fails = Number(meta.fails) || 0;
    const streak = Number(meta.streak) || 0;
    if (ok) {
      meta.fails = '0';
      meta.streak = String(streak + 1);
      meta.lastOk = new Date().toISOString();
    } else {
      const nextFail = fails + 1;
      meta.fails = String(nextFail);
      meta.streak = '0';
      meta.lastFail = new Date().toISOString();
      meta.lastFailWhy = String(why || '').slice(0, 200);
      if (nextFail >= maxFails) {
        meta.disabled = `true (${nextFail} failures in a row — last: ${String(why || '').slice(0, 120)})`;
      }
    }
    this._writeRaw(slug, meta, raw.steps);
    bus.info('skill.outcome', { name: slug, ok: Boolean(ok), fails: Number(meta.fails) || 0, disabled: Boolean(meta.disabled && meta.disabled !== 'false') });
    return { ok: true, fails: Number(meta.fails) || 0, streak: Number(meta.streak) || 0, disabled: Boolean(meta.disabled && meta.disabled !== 'false') };
  }

  /** Explicit user re-enable: clears fails and disabled. */
  enable(slug) {
    let raw;
    try { raw = this._readRaw(slug); } catch {
      return { ok: false, why: `no skill '${slug}'` };
    }
    raw.meta.fails = '0';
    raw.meta.disabled = 'false';
    delete raw.meta.lastFailWhy;
    this._writeRaw(slug, raw.meta, raw.steps);
    bus.info('skill.enable', { name: slug });
    return { ok: true };
  }

  /* P5 (V5 §3: "reusable, tested skills with versioning and rollback").
     Every content change: (a) archives the previous full file under
     .versions/<slug>.v<N>.md, (b) bumps version honestly, (c) CARRIES the
     fail/streak/disabled accountability — an edit never launders a track
     record, (d) writes atomically (P0 standard: tmp + rename, never torn). */
  _versionsDir() { return path.join(this.dir, '.versions'); }

  _archiveCurrent(slug) {
    try {
      const file = this._file(slug);
      if (!fs.existsSync(file)) return { archived: null, prevVersion: 0 };
      let meta = {};
      try { meta = this._readRaw(slug).meta; } catch { meta = {}; }
      const prevVersion = Math.max(0, Number(meta.version) || 0);
      fs.mkdirSync(this._versionsDir(), { recursive: true });
      const archive = path.join(this._versionsDir(), `${slug}.v${prevVersion || 'pre'}.md`);
      fs.copyFileSync(file, archive);
      // cap: newest 10 archives per slug
      const keep = 10;
      const all = fs.readdirSync(this._versionsDir()).filter((f) => f.startsWith(`${slug}.v`) && f.endsWith('.md'));
      if (all.length > keep) {
        const sorted = all.map((f) => ({ f, t: fs.statSync(path.join(this._versionsDir(), f)).mtimeMs })).sort((a, b) => a.t - b.t);
        for (const old of sorted.slice(0, sorted.length - keep)) fs.unlinkSync(path.join(this._versionsDir(), old.f));
      }
      return { archived: archive, prevVersion };
    } catch (err) {
      bus.warn('skill.archive_failed', { name: slug, message: String(err?.message || err) });
      return { archived: null, archiveError: String(err?.message || err), prevVersion: 0 };
    }
  }

  /** Archived versions of a skill, oldest first. */
  versions(slug) {
    try {
      const dir = this._versionsDir();
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(`${slug}.v`) && f.endsWith('.md'))
        .map((f) => {
          const raw = fs.readFileSync(path.join(dir, f), 'utf8');
          const m = FRONT.exec(raw);
          const meta = {};
          if (m) for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
          return { file: path.join(dir, f), version: Number(meta.version) || 0, updated: meta.updated || null };
        })
        .sort((a, b) => a.version - b.version);
      return files;
    } catch {
      return [];
    }
  }

  /** Roll back to an archived version (default: newest archive). The CURRENT
     state is archived first — rollback never destroys information either way. */
  rollback(slug, version = null) {
    const target = (() => {
      const all = this.versions(slug);
      if (!all.length) return null;
      if (version == null) return all[all.length - 1];
      return all.find((v) => v.version === Number(version)) || null;
    })();
    if (!target) return { ok: false, why: `no archived version of '${slug}'${version != null ? ` (v${version})` : ''}` };
    try {
      const live = this._readRaw(slug);
      const liveVersion = Math.max(0, Number(live.meta.version) || 0);
      this._archiveCurrent(slug); // symmetric safety: current becomes the newest archive
      const rawTarget = fs.readFileSync(target.file, 'utf8');
      const tmp = `${this._file(slug)}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, rawTarget);
      fs.renameSync(tmp, this._file(slug)); /* atomic restore */
      bus.info('skill.rollback', { name: slug, from: liveVersion, to: target.version });
      return { ok: true, from: liveVersion, to: target.version, restored: this._file(slug) };
    } catch (err) {
      return { ok: false, why: `rollback failed: ${String(err?.message || err)}` };
    }
  }

  save({ name, when, steps, tools = '' }) {
    const slug = String(name || 'skill')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48);
    if (!slug) return { ok: false, why: 'the name could not be written as a filename' };
    /* version + accountability: previous content is archived, previous FAIL
       and STREAK counters travel with the skill (an edit is not an acquittal) */
    const archiveInfo = this._archiveCurrent(slug);
    let prevMeta = {};
    try { prevMeta = this._readRaw(slug).meta; } catch { prevMeta = {}; }
    const version = (Math.max(0, Number(prevMeta.version) || 0)) + 1;
    const file = path.join(this.dir, `${slug}.md`);
    const metaLines = [
      `name: ${name}`,
      `when: ${when || ''}`,
      `tools: ${Array.isArray(tools) ? tools.join(', ') : tools || ''}`,
      `version: ${version}`,
      `updated: ${new Date().toISOString()}`,
    ];
    for (const k of ['fails', 'streak', 'lastOk', 'lastFail', 'lastFailWhy', 'disabled', 'uses', 'lastUsed']) { /* uses/lastUsed: K2-consistent — an edit never erases the visit ledger either */
      if (prevMeta[k] !== undefined) metaLines.push(`${k}: ${prevMeta[k]}`);
      else if (k === 'fails' && version > 1) metaLines.push('fails: 0');
    }
    const body = `---\n${metaLines.join('\n')}\n---\n${(steps || '').trim()}\n`;
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file); /* atomic: same standard as config.plan — never torn */
    bus.info('skill.save', { name: slug, file, version, archived: archiveInfo.archived });
    const out = { ok: true, file, name: slug, version, archived: archiveInfo.archived };
    if (archiveInfo.archiveError) out.archiveError = archiveInfo.archiveError; // honestly surfaced, never hidden
    return out;
  }

  /* WAVE 7 / radar #3 ADOPT: outcome history counts as a SMALL reputation
     weight, visible and deterministic. Token relevance still dominates
     (×10), a proven skill (streak ≥ 3) gets +2, a failing one (fails ≥ 1)
     gets −1. The boost never rescues a keyword mismatch — a skill that does
     not match the task stays off the list, and heavy token winners still win:
     evidence beats enthusiasm, but never overrides competence. */
  static outcomeBoost(meta) {
    const streak = Number(meta?.streak) || 0;
    const fails = Number(meta?.fails) || 0;
    return (streak >= 3 ? 2 : 0) + (fails >= 1 ? -1 : 0);
  }

  /* WAVE 10 — skill visit telemetry (user directive). A "visit" is recorded
     HONESTLY at the moment a skill is actually presented to the agent:
     (a) injected into the system prompt (ambient), or (b) returned by a
     deliberate majin.skill action=match lookup. Never incremented speculatively
     — a visit means the skill was put in front of the model, nothing more,
     nothing claimed. Stored on DISK (`uses`, `lastUsed`) so two agent
     processes count the same truth and a crash cannot inflate it. */
  hit(slugs) {
    const out = { ok: true, counted: [] };
    for (const slug of [...new Set(slugs)]) {
      try {
        const { meta, steps } = this._readRaw(slug);
        meta.uses = String((Number(meta.uses) || 0) + 1);
        meta.lastUsed = new Date().toISOString();
        this._writeRaw(slug, meta, steps);
        out.counted.push({ slug, uses: Number(meta.uses) });
      } catch { /* a missing skill file must never break the turn */ }
    }
    return out;
  }

  match(text, k = 4) {
    const q = tokenize(text);
    if (!q.size) return [];
    return this.list()
      .filter((s) => !s.disabled) /* Del 7C: a repeat-fail skill is never selected */
      .map((s) => {
        const t = tokenize(`${s.name} ${s.when}`);
        let score = 0;
        for (const w of q) if (t.has(w)) score += 1;
        const boost = Skills.outcomeBoost(s.meta);
        return { ...s, score, boost, rank: score * 10 + boost };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name)) /* deterministic ties */
      .slice(0, k);
  }

  prompt() {
    const max = this.cfg?.get('skills.maxInPrompt') || 12;
    const eligible = this.list().filter((s) => !s.disabled);
    const list = eligible.slice(0, max);
    if (!list.length) return '';
    /* WAVE 7 / radar #5 ADOPT: silent truncation made honest — when skills
       grow past maxInPrompt the prompt says so, and the bus carries the
       numbers so the UI/CLI can surface "N skills not shown" instead of
       pretending the catalog is complete. */
    if (eligible.length > max) {
      bus.info('skill.pruned', { shown: list.length, eligible: eligible.length, max, hidden: eligible.length - max });
    }
    /* WAVE 10: count a visiting exactly for the skills actually shown — the
       pruned ones were NOT in front of the model and must not inflate. */
    this.hit(list.map((s) => s.file.replace(/\.md$/, '')));
    const line = (s) => {
      const visits = (Number(s.meta?.uses) || 0) + 1; /* +1 = this visit, counted above */
      return `- ${s.name} — ${s.when} [visited ×${visits}${Number(s.meta?.streak) >= 1 ? ` · streak ${s.meta.streak}` : ''}]\n${s.steps.split('\n').slice(0, 12).map((l) => `    ${l}`).join('\n')}`;
    };
    return `Learned skills (follow them when they fit):\n${list.map(line).join('\n')}` + (eligible.length > max ? `\n(${eligible.length - max} more learned skills not shown — see the skills list)` : '');
  }
}

export { tokenize, words };
