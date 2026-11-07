/**
 * MAJIN — privacy-first product diagnostics.
 *
 * TRE separata lanier, aldrig hopslutna:
 *  A) Lokalt driftslogg (alltid pa, stannar pa disken) — hjalper ANVANDAREN
 *     felsoka sin egen instans: startfel, kraschkategori, misslyckade
 *     update-checks, verktygsfelen. Aldrig chattinnehall, alder filnamn,
 *     aldrig API-nycklar, aldrig IP.
 *  B) FRIVILLIG produktanalytics (opt-in, default OFF) — grova talmatningar:
 *     kategornaha lyftningser loweralties rinsingarg, ingen text. Skickas
 *     ALDRIG utan att bade `diagnostics.analytics: true` OCH en konfigurerad
 *     endpoint finns. Utan backend: lokal lagring + status som sager sanningen.
 *  C) Explicit felrimports delning (inte byggd annu) — separat knapp i UI.
 *
 * Implementerat har: A + B-grunden. Ingen automatisk träningsdata. Ingen
 * "training-sharing" finns som system alls annu — den dagen ska fyra separata
 * samtycken gaenskalas, inte tre.
 */
import fs from 'node:fs';
import path from 'node:path';
import { VERSION } from './version.js';

export const DIAG_ALLOWLIST = new Set([
  'kind', 'version', 'os', 'category', 'ok', 'ms', 'count',
  'toolCategory', 'routeCategory', 'job', 'sessionCount', 'crashCategory',
  'updateResult', 'noistra', 'ts',
]);

const MAX_RING = 240;
const MAX_BYTES = 8192; // per event JSON — stoppa akidenttal payloads

function sanitize(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(ev)) {
    if (!DIAG_ALLOWLIST.has(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 120);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** Skapa en isolated namespace per runtime. */
export function createDiagnostics({ dirs, cfg, log = () => {}, osInfo = null }) {
  const file = path.join(dirs.logs || dirs.root, 'diagnostics.log');
  const one = osInfo || { platform: process.platform, release: '' };

  function record(kind, fields = {}) {
    const ev = sanitize({ ...fields, kind, version: VERSION, os: one.platform, ts: Date.now() });
    if (!ev) return { ok: false, reason: 'not a plain object' };
    const dropped = Object.keys(fields).filter((k) => !DIAG_ALLOWLIST.has(k));
    if (dropped.length) log('diag.dropped', { kind, dropped });
    let line = JSON.stringify(ev);
    if (line.length > MAX_BYTES) return { ok: false, reason: 'payload too large' };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      ringAppend(file, line + '\n');
      return { ok: true, dropped };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  function ringAppend(f, line) {
    let lines = [];
    try { lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { /* fesh */ }
    lines.push(line);
    if (lines.length > MAX_RING) lines = lines.slice(-MAX_RING);
    fs.writeFileSync(f, lines.join('\n') + '\n');
  }

  function tail(n = 40) {
    try {
      return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n).map((l) => JSON.parse(l));
    } catch { return []; }
  }

  function clear() {
    try { fs.rmSync(file); } catch { /* onard */ }
  }

  /** Postar en batch till konfigurad endpoint ENDAST vid explicit opt-in. */
  async function flush({ fetchImpl = globalThis.fetch } = {}) {
    const conf = cfg?.get ? (cfg.get('diagnostics') || {}) : {};
    if (conf.analytics !== true) return { ok: true, sent: 0, status: 'off', reason: 'analytics disabled (opt-in off) — nothing leaves this machine' };
    if (!conf.endpoint || !/^https:\/\//i.test(conf.endpoint)) {
      return { ok: false, sent: 0, status: 'no_endpoint', reason: 'analytics on but no https endpoint configured — events stay local' };
    }
    const batch = tail(60);
    if (!batch.length) return { ok: true, sent: 0, status: 'empty' };
    try {
      const res = await fetchImpl(conf.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-majin-diag': VERSION },
        body: JSON.stringify({ schema: 'majin.diag.v1', events: batch }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { ok: false, sent: 0, status: `http_${res.status}` };
      removeSent(batch.length);
      return { ok: true, sent: batch.length, status: 'delivered' };
    } catch (err) {
      return { ok: false, sent: 0, status: err.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
    }
  }

  function removeSent(n) {
    const lines = tail(n + 400);
    if (lines.length <= n) return clear();
    const rest = lines.slice(0, Math.max(0, lines.length - n));
    fs.writeFileSync(file, rest.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  function status() {
    const conf = cfg?.get ? (cfg.get('diagnostics') || {}) : {};
    return {
      localLog: file,
      events: tail(1000).length,
      analytics: conf.analytics === true,
      endpoint: conf.analytics === true ? (conf.endpoint || null) : null,
      claim: conf.analytics === true && conf.endpoint
        ? 'opt-in allowed list uploads'
        : 'LOCAL ONLY — nothing is transmitted',
    };
  }

  return { record, tail, clear, flush, status, file };
}
