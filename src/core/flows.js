/**
 * MAJIN W5 EVENT FLOWS — durable natural-language automations.
 *
 *   when:  trigger spec  — schedule (via existing scheduler), file change (chokidar),
 *          webhook (HTTP intake), github event (poll via REST), manual.
 *   then:  action        — a registry tool call executed through the SAME guard
 *                          system as interactive turns (exec-risk = approval gate).
 *
 * Verktyg-principer (master directive W5):
 *  - Durable state: flows/<id>/state.json + runs.jsonl history; never volatile-only.
 *  - Deduplication: event content-hash drops repeats inside a bounded window.
 *  - Bounded retries: max 3 attempts per fire, never infinite replays.
 *  - Authorization: flows never invoke side-effectful tools without the same
 *    approval that interactive turns demand (the shared guard owns that).
 *  - No hidden infinite loops: flows support enable/disable + maxFiresPerHour.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const VERSION = 'majin-flows/1';

export function flowId(name) {
  return crypto.createHash('sha256').update(String(name).toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);
}

export function flowDir(workspaceDir, id) { return path.join(workspaceDir, 'flows', id); }

function readJsonSafe(p, fb = null) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }

export function loadFlow(workspaceDir, id) { return readJsonSafe(path.join(flowDir(workspaceDir, id), 'state.json')); }

export function saveFlow(workspaceDir, def) {
  const dir = flowDir(workspaceDir, def.id);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.state.tmp');
  fs.writeFileSync(tmp, JSON.stringify(def, null, 2));
  fs.renameSync(tmp, path.join(dir, 'state.json'));
  return dir;
}

export function listFlows(workspaceDir) {
  const base = path.join(workspaceDir, 'flows');
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => readJsonSafe(path.join(base, e.name, 'state.json')))
    .filter(Boolean)
    .map((f) => ({ id: f.id, name: f.name, enabled: f.enabled !== false, when: f.when, fireCount: (f.history || []).length, lastStatus: (f.history || []).slice(-1)[0]?.status || 'never' }));
}

export function eventHash(payload) {
  return crypto.createHash('sha256').update(String(typeof payload === 'object' ? JSON.stringify(payload) : payload)).digest('hex').slice(0, 20);
}

/* dedupe window: an event-hash inside the last N history entries counts as a repeat */
export function isDuplicate(flow, hash, windowSize = 25) {
  return (flow.history || []).slice(-windowSize).some((h) => h.eventHash === hash);
}

export function recordRun(workspaceDir, flow, entry) {
  flow.history = (flow.history || []).concat({ at: new Date().toISOString(), ...entry }).slice(-100);
  saveFlow(workspaceDir, flow);
  return flow;
}

/* Template expansion: {{path}}, {{content}}, {{event.<k>}} — nothing else,
   never eval; a missing binding stays as its literal marker (honest surprise
   instead of silent nonsense). */
export function renderTemplate(value, ev) {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (m, k) => {
      if (k === 'path') return ev.path != null ? String(ev.path) : m;
      if (k === 'hash') return ev.eventHash || m;
      if (k.startsWith('event.')) {
        const key = k.slice(6);
        return ev.meta && ev.meta[key] != null ? String(ev.meta[key]) : m;
      }
      return m;
    });
  }
  if (Array.isArray(value)) return value.map((v) => renderTemplate(v, ev));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderTemplate(v, ev)]));
  }
  return value;
}

/* rate limit: at most maxFiresPerHour fires in the rolling 3,600s window */
export function underRateLimit(flow, maxPerHour = 20) {
  const cap = Math.max(1, Math.min(600, Number(maxPerHour) || 20));
  const now = Date.now();
  const inHour = (flow.history || []).filter((h) => now - Date.parse(h.at) < 3600000).length;
  return inHour < cap;
}

/* Execute ONE fire against the registry. Executes through the shared guard:
   approval-needed tools return {approval} from registry.exec — flow records
   'waiting_approval' and STOPS (no repeated fires spawning approval queues). */
export async function fire(workspaceDir, flow, ev, { registry, session = 'flows', maxAttempts = 3, resolveApprover = null } = {}) {
  if (!flow.enabled) return { ok: false, status: 'disabled' };
  if (!underRateLimit(flow, flow.maxFiresPerHour)) {
    recordRun(workspaceDir, flow, { kind: 'rate-limited', eventHash: ev.eventHash, status: 'rate-limited' });
    return { ok: false, status: 'rate-limited' };
  }
  let lastError = null;
  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt++) {
    try {
      const args = renderTemplate(flow.then.args || {}, ev);
      const r = await registry.exec(flow.then.tool, args, { session: `flow:${flow.id}`, step: attempt, flow: flow.id });
      if (r.ok === true) {
        recordRun(workspaceDir, flow, { kind: 'fire', tool: flow.then.tool, attempt, status: 'ok', eventHash: ev.eventHash, summary: String(r.summary || '').slice(0, 120) });
        return { ok: true, status: 'ok', attempt };
      }
      const code = r.error?.code || '';
      if (code === 'approval_required' || code === 'approval_pending' || r.approval) {
        recordRun(workspaceDir, flow, { kind: 'fire', tool: flow.then.tool, attempt, status: 'waiting_approval', approvalId: r.approval?.id || r.approvalId || null, eventHash: ev.eventHash });
        return { ok: false, status: 'waiting_approval' };
      }
      lastError = r.error?.message || 'tool returned not-ok';
      if (/(rate|timeout|transient|network|ECONNRESET|ETIMEDOUT)/i.test(String(lastError))) continue; /* retryable -> next attempt */
      break; /* deterministic error — fail now, never retry into a wall */
    } catch (err) {
      lastError = String(err?.message || err);
      if (/(rate|timeout|ECONNRESET|ETIMEDOUT)/i.test(lastError)) continue;
      break;
    }
  }
  recordRun(workspaceDir, flow, { kind: 'fire', tool: flow.then.tool, status: 'failed', error: String(lastError || 'unknown').slice(0, 200), eventHash: ev.eventHash });
  return { ok: false, status: 'failed', error: String(lastError || 'unknown').slice(0, 200) };
}

/* --------------------------------- triggers -------------------------------- */

export class TriggerHub {
  constructor(workspaceDir, { onEvent = async () => {}, fileEventsCap = 50 } = {}) {
    this.ws = workspaceDir;
    this.onEvent = onEvent;
    this.watchers = new Map();
    this.fileEventsCap = fileEventsCap;
  }
  async startFileTrigger(flow) {
    if (this.watchers.has(flow.id)) return false;
    const spec = flow.when;
    if (spec?.type !== 'file' || !spec.path) return false;
    const chokidar = await import('chokidar').catch(() => null);
    if (!chokidar?.watch) throw new Error('Chokidar unavailable — chokidar@4 runtime dependency missing (chosen over custom fs.watch for cross-platform correctness, see DECISIONS.md)');
    const w = chokidar.watch(spec.path, { ignoreInitial: spec.fireForExisting !== true, persistent: true, depth: spec.depth ?? 6, awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 } });
    /* W5 VERIFIED-delta found REAL bug: chokidar swallows events that arise
       during the initial scan (before 'ready') when ignoreInitial is true —
       flows.add() returned "registered" but drops in that window vanished
       silently. Buffer pre-ready events and flush them once ready. */
    /* W5 VERIFIED-delta found the REAL bug: with ignoreInitial:true, files
       added DURING the initial scan are swallowed ENTIRELY — the user
       listener never gets called, so no buffering trick can save them
       (proven by e2e: immediate post-flows.add drop → no event, no record).
       Fix: on 'ready', file any entry whose mtime lands AFTER watch start
       (that window never existed on disk before the scan, so it cannot be
       a pre-existing file — no false positive possible). */
    const startedAt = Date.now();
    let ready = false;
    w.on('ready', async () => {
      ready = true;
      if (spec.event === 'unlink') return;
      const candidates = new Set();
      for (const [dir, files] of Object.entries(w.getWatched() || {})) {
        for (const f of files) if (f !== '.') candidates.add(path.join(dir, f));
      }
      for (const cand of candidates) {
        try {
          const st = fs.statSync(cand);
          if (st.mtimeMs >= startedAt - 250) await handle(cand);
        } catch { /* vanished again — ignore, unlink-watch covers removals */ }
      }
    });
    const cwd = process.cwd();
    w.on(spec.event === 'unlink' ? 'unlink' : spec.event === 'change' ? 'change' : 'add', async (p) => {
      /* pre-ready events do not exist with ignoreInitial:true (proven above);
         the mtime-window on 'ready' owns the warm-up case */
      if (!ready) return;
      await handle(p);
    });
    const handle = async (p) => {
      const event = { path: p.startsWith('/') ? p : path.join(cwd, p), eventHash: eventHash(p + ':' + (await fileStamp(p))), meta: { trigger: spec.event || 'add' } };
      const current = loadFlow(this.ws, flow.id) || flow;
      if (isDuplicate(current, event.eventHash)) { recordRun(this.ws, current, { kind: 'duplicate-suppressed', eventHash: event.eventHash, status: 'suppressed' }); return; }
      await this.onEvent(current, event);
    };
    this.watchers.set(flow.id, w);
    return true;
  }
  async stopFileTrigger(id) {
    const w = this.watchers.get(id);
    if (w) { await w.close(); this.watchers.delete(id); return true; }
    return false;
  }
  async stopAll() { for (const id of [...this.watchers.keys()]) await this.stopFileTrigger(id); }
}
async function fileStamp(p) { try { const st = fs.statSync(p); return `${st.size}:${st.mtimeMs}`; } catch { return 'gone'; } }

/* GitHub events trigger: poll-style (no webhooks setup required). Uses REST
   through an injectable fetchFn so tests stay offline; dedupe via event ids. */
export async function pollGithub(c, { fetchFn, perPage = 20 } = {}) {
  const events = await fetchFn(`/repos/${c.owner}/${c.repo}/events?per_page=${perPage}`);
  if (!Array.isArray(events)) return { ok: false, error: { code: 'github_events', message: 'unexpected events response' } };
  return { ok: true, events: events.map((e) => ({ id: e.id, type: e.type, created_at: e.created_at, actor: e.actor?.login })) };
}

export function newGithubEvents(flow, events) {
  const seen = new Set((flow.history || []).slice(-100).map((h) => h.meta?.eventId).filter(Boolean));
  return events.filter((e) => !seen.has(e.id));
}
