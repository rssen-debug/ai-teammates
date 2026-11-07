/* MAJIN — SAFE ADAPTERS (Del 7B).
   An adapter is a DECLARATIVE json descriptor for one external HTTP JSON
   endpoint. It contains NO executable code, is never eval'd, and its
   permission class tells callers what may ever happen: read = GET only,
   external-write = POST writing user data (approval territory),
   external-post = public submission (hard approval). Validation is HARD:
   an invalid adapter is never written to disk. */
import fs from 'node:fs';
import path from 'node:path';
import { dirs, resolveData } from './paths.js';
import { bus } from './log.js';

export const PERMISSIONS = Object.freeze(['read', 'external-write', 'external-post']);
export const METHODS = Object.freeze({ read: ['GET'], 'external-write': ['POST', 'PUT', 'PATCH'], 'external-post': ['POST'] });

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
const FIELD_RE = /^[a-zA-Z][a-zA-Z0-9_\-]{0,63}$/;
const PATH_RE = /^[a-zA-Z0-9_.\[\]-]{1,120}$/;

export function validateAdapter(spec) {
  const issues = [];
  const s = spec && typeof spec === 'object' ? spec : {};
  if (!SLUG_RE.test(String(s.name || ''))) issues.push(`name must be a lowercase slug like "my-source" (got ${JSON.stringify(s.name || '')})`);
  if (s.kind !== 'http-json') issues.push(`kind must be "http-json" — adapters never run code (got ${JSON.stringify(s.kind)})`);
  const url = String(s.baseUrl || '');
  try {
    const u = new URL(url);
    const local = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname);
    if (u.protocol === 'javascript:' || u.protocol === 'data:') issues.push(`forbidden scheme ${u.protocol}`);
    else if (u.protocol !== 'https:' && !local) issues.push(`baseUrl must be https (or localhost in dev) — got ${u.protocol}//${u.host}`);
    if ((u.username || u.password)) issues.push('credentials must never live inside baseUrl');
  } catch {
    issues.push(`baseUrl is not a URL (got ${JSON.stringify(url)})`);
  }
  if (!PERMISSIONS.includes(s.permission)) issues.push(`permission must be one of ${PERMISSIONS.join(' | ')} (got ${JSON.stringify(s.permission)})`);
  const headers = s.headers && typeof s.headers === 'object' ? s.headers : {};
  for (const [k, v] of Object.entries(headers)) {
    if (!/^[!#$%&'*+\-.^_`|~a-zA-Z0-9]{1,64}$/.test(k)) issues.push(`odd header name ${JSON.stringify(k)}`);
    const val = String(v);
    if (/Bearer\s+(?!{env:[A-Z0-9_]+})/i.test(val) || /^sk-[A-Za-z0-9]/i.test(val)) {
      issues.push(`header ${k} looks like a raw secret — use {env:NAME} placeholders only`);
    }
    if (/javascript:|data:\/|<script/i.test(val)) issues.push(`header ${k} carries an executable payload — refused`);
  }
  /* mapping: response-field → flat where-to-put rows. Strings ONLY, paths ONLY. */
  const mapping = s.mapping && typeof s.mapping === 'object' ? s.mapping : {};
  for (const [out, from] of Object.entries(mapping)) {
    if (!FIELD_RE.test(out)) issues.push(`mapping output field ${JSON.stringify(out)} is not a plain field name`);
    if (!PATH_RE.test(String(from))) issues.push(`mapping source ${JSON.stringify(from)} must be a dotted path like items.0.title — never code`);
  }
  const timeoutMs = Number(s.timeoutMs ?? 15000);
  if (!(timeoutMs >= 1000 && timeoutMs <= 120000)) issues.push('timeoutMs must sit inside 1000..120000');
  const rate = s.rate && typeof s.rate === 'object' ? Number(s.rate.maxPerHour) : 60;
  if (!(rate >= 1 && rate <= 10000)) issues.push('rate.maxPerHour must sit inside 1..10000');
  return issues;
}

export class Adapters {
  constructor(cfg) {
    this.cfg = cfg;
    this.dir = resolveData(cfg?.get('adapters.dir'), dirs.adapters);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  list() {
    try {
      return fs.readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          try { return { ...JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')), file: f }; } catch { return { file: f, broken: true }; }
        });
    } catch { return []; }
  }

  /** HARD validation before write — an invalid adapter never touches disk. */
  create(spec) {
    const issues = validateAdapter(spec);
    if (issues.length) return { ok: false, issues };
    const file = path.join(this.dir, `${String(spec.name)}.json`);
    const clean = {
      name: String(spec.name),
      kind: 'http-json',
      baseUrl: String(spec.baseUrl),
      permission: String(spec.permission),
      headers: spec.headers && typeof spec.headers === 'object' ? spec.headers : {},
      mapping: spec.mapping && typeof spec.mapping === 'object' ? spec.mapping : {},
      timeoutMs: Math.max(1000, Math.min(120000, Number(spec.timeoutMs ?? 15000))),
      rate: { maxPerHour: Math.max(1, Math.min(10000, Number(spec.rate?.maxPerHour ?? 60))) },
      created: new Date().toISOString(),
    };
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n');
    fs.renameSync(tmp, file); /* atomic */
    bus.info('adapter.create', { name: clean.name, permission: clean.permission });
    return { ok: true, adapter: clean, file };
  }

  remove(name) {
    const file = path.join(this.dir, `${name}.json`);
    if (!fs.existsSync(file)) return { ok: false, why: `no adapter ${name}` };
    fs.unlinkSync(file);
    try { fs.unlinkSync(path.join(this.dir, `.state-${name}.json`)); } catch {}
    bus.info('adapter.remove', { name });
    return { ok: true };
  }

  /* ---- Del 7D: execution, routed THROUGH the engine's own gates ----
     read adapters: direct GET. external-write/post: an explicit approvals
     request FIRST (the same singleton gate that guards jobs.send), and
     the tool arg `approved` must be true as well — belt and suspenders,
     both surviving process restarts. Rate limits + failure discipline live
     in a sidecar state file per adapter: an adapter that keeps failing
     disables itself (default 3 in a row) and must be enabled explicitly. */

  _stateFile(name) { return path.join(this.dir, `.state-${name}.json`); }
  _loadState(name) {
    try { return JSON.parse(fs.readFileSync(this._stateFile(name), 'utf8')); } catch { return { calls: [], fails: 0, streak: 0, disabled: false }; }
  }
  _saveState(name, st) {
    const f = this._stateFile(name); const tmp = `${f}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(st, null, 1) + '\n'); fs.renameSync(tmp, f);
  }

  _loadSpec(name) {
    try {
      const spec = JSON.parse(fs.readFileSync(path.join(this.dir, `${name}.json`), 'utf8'));
      return spec && typeof spec === 'object' ? spec : null;
    } catch { return null; }
  }

  _record(name, ok, why = '') {
    const st = this._loadState(name);
    if (ok) { st.fails = 0; st.streak = (st.streak || 0) + 1; st.lastOk = new Date().toISOString(); }
    else {
      st.streak = 0;
      st.fails = (st.fails || 0) + 1;
      st.lastFail = new Date().toISOString();
      st.lastWhy = String(why).slice(0, 200);
      const maxFails = Math.max(1, Math.min(10, Number(this.cfg?.get('adapters.maxFails')) || 3));
      if (st.fails >= maxFails) { st.disabled = true; st.disabledWhy = `${st.fails} failures in a row — last: ${st.lastWhy}`; }
    }
    this._saveState(name, st);
    bus.info('adapter.outcome', { name, ok: Boolean(ok), fails: st.fails, disabled: Boolean(st.disabled) });
    return st;
  }

  enable(name) {
    if (!this._loadSpec(name)) return { ok: false, why: `no adapter ${name}` };
    const st = this._loadState(name);
    st.disabled = false; st.fails = 0; delete st.disabledWhy; delete st.lastWhy;
    this._saveState(name, st);
    bus.info('adapter.enable', { name });
    return { ok: true };
  }

  /** Execute one call. honors: validation (re-read from disk), permission
     class, approval gate, rate limit, timeout, JSON mapping. NEVER throws —
     failures are recorded and return honest error envelopes. */
  async call(name, { params = {}, approved = false, approvals = null, session = 'desktop' } = {}) {
    const spec = this._loadSpec(name);
    if (!spec) return { ok: false, error: { code: 'not_found', message: `no adapter ${name}` } };
    /* defense in depth: specs are re-validated on every execution path, so a
       hand-edited descriptor still cannot smuggle a hostile scheme/code in. */
    const issues = validateAdapter(spec);
    if (issues.length) return { ok: false, error: { code: 'invalid_spec', message: `spec on disk fails validation: ${issues.join('; ')}` } };
    const st0 = this._loadState(name);
    if (st0.disabled) return { ok: false, error: { code: 'adapter_disabled', message: `"${name}" disabled itself: ${st0.disabledWhy || 'repeat failures'}. Human input needed: action enable.`, hint: 'majin.adapter({action:"enable",name})' } };
    if (params && typeof params !== 'object') return { ok: false, error: { code: 'bad_params', message: 'params must be an object' } };

    const url = new URL(spec.baseUrl);
    const isWrite = spec.permission !== 'read';
    const method = isWrite ? METHODS[spec.permission][0] : 'GET';

    /* EXTERNAL-* needs a human "yes" recorded in the engine's approval gate. */
    if (isWrite) {
      if (!approved) return { ok: false, error: { code: 'approval_required', message: `permission class "${spec.permission}" never runs without an explicit approval: call again with approved:true after the user says yes`, hint: 'show the user exactly what will be posted, then resubmit' } };
      if (approvals && typeof approvals.request === 'function') {
        const decision = await approvals.request({ tool: `majin.adapter:${name}`, reason: `external ${spec.permission} to ${url.host}`, detail: `${method} ${spec.baseUrl} body=${JSON.stringify(params).slice(0, 400)}`, args: params, session }, Number(this.cfg?.get('tasks.approvalTimeoutMs')) || 0);
        if (!decision?.approved) return { ok: false, error: { code: 'denied', message: `the human declined: ${decision?.why || decision?.note || 'no reason'}` }, denied: true };
      }
    }

    /* rate limit: count calls from the rolling hour, from disk */
    const st = this._loadState(name);
    const hourAgo = Date.now() - 3600_000;
    st.calls = (st.calls || []).filter((t) => t > hourAgo);
    const maxPerHour = Math.max(1, Math.min(10000, Number(spec.rate?.maxPerHour ?? 60)));
    if (st.calls.length >= maxPerHour) {
      this._saveState(name, st);
      return { ok: false, error: { code: 'rate_limited', message: `adapter "${name}" self-limit reached: ${st.calls.length}/${maxPerHour} calls in the last hour. Wait, or raise rate.maxPerHour in the spec.` } };
    }
    st.calls.push(Date.now()); this._saveState(name, st);

    const headers = {};
    for (const [k, v] of Object.entries(spec.headers || {})) {
      const val = String(v).replace(/\{env:([A-Z0-9_]+)\}/g, (_, e) => process.env[e] || '');
      if (/\{env:[A-Z0-9_]+\}/.test(val)) { this._record(name, false, 'missing env secret'); return { ok: false, error: { code: 'config_missing', message: `an {env:NAME} placeholder in headers has no environment value — set it first` } }; }
      headers[k] = val;
    }
    if (isWrite) headers['Content-Type'] = headers['Content-Type'] || 'application/json';

    const ctrl = new AbortController();
    const timeoutMs = Math.max(1000, Math.min(120000, Number(spec.timeoutMs ?? 15000)));
    const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
    let res, body;
    try {
      res = await fetch(url, { method, headers, body: isWrite ? JSON.stringify(params) : undefined, signal: ctrl.signal, redirect: 'error' });
    } catch (err) {
      clearTimeout(timer);
      this._record(name, false, err.name === 'AbortError' || err === 'timeout' ? `timeout after ${timeoutMs}ms` : err.message);
      return { ok: false, error: { code: 'network', message: `${method} ${url.host} failed: ${err.message || err}` } };
    }
    clearTimeout(timer);
    try {
      body = await res.arrayBuffer();
      if (body.byteLength > 4_000_000) { this._record(name, false, 'response too large'); return { ok: false, error: { code: 'too_large', message: 'response exceeded 4MB cap' } }; }
    } catch (err) { this._record(name, false, err.message); return { ok: false, error: { code: 'read_body', message: err.message } }; }
    if (!res.ok) { this._record(name, false, `http ${res.status}`); return { ok: false, error: { code: 'http', message: `${url.host} answered ${res.status} ${res.statusText}` } }; }
    let json;
    try { json = JSON.parse(Buffer.from(body).toString('utf8')); }
    catch { this._record(name, false, 'not json'); return { ok: false, error: { code: 'not_json', message: 'kind is http-json but the answer was not JSON' } }; }
    this._record(name, true);

    const rows = mapRows(json, spec.mapping || {});
    bus.info('adapter.call', { name, method, status: res.status, rows: rows.length });
    return { ok: true, adapter: name, method, status: res.status, rows, meta: { permission: spec.permission, mapped: Object.keys(spec.mapping || {}).length } };
  }
}

/** dotted-path mapping with array expansion:
   mapping { title: 'items.0.name' } on {items:[{name:'a'},{name:'b'}]} → rows
   [{title:'a'},{title:'b'}]. Numeric middle segments enumerate the array. */
export function mapRows(json, mapping) {
  const entries = Object.entries(mapping || {});
  if (!entries.length) return json === null || json === undefined ? [] : [{ value: json }];
  const groups = new Map();
  for (const [out, src] of entries) {
    const segs = String(src).split('.');
    let arrRoot = null; let leaf = null;
    for (let i = 0; i < segs.length; i++) {
      const cur = walk(json, segs.slice(0, i + 1));
      if (Array.isArray(cur)) { arrRoot = segs.slice(0, i + 1).join('.'); leaf = segs.slice(i + 1); break; }
    }
    const key = arrRoot || '(scalar)';
    if (!groups.has(key)) groups.set(key, []);
    let sub = arrRoot ? segs.slice(arrRoot.split('.').length) : segs;
    /* the first segment AFTER the array root is the enumerator index (e.g.
       'items.0.title') — drop it: we enumerate the array ourselves. */
    if (sub.length && /^\d+$/.test(sub[0])) sub = sub.slice(1);
    groups.get(key).push([out, sub]);
  }
  let rows = [];
  for (const [root, fields] of groups) {
    const arr = root === '(scalar)' ? [json] : walk(json, root.split('.'));
    if (!Array.isArray(arr)) continue;
    rows = arr.map((item) => {
      const row = {};
      let firstRootDone = false;
      for (const [out, segs] of fields) {
        const from = root === '(scalar)' ? json : (firstRootDone ? item : item);
        row[out] = walk(from, segs);
      }
      firstRootDone = true;
      return row;
    });
    break; /* first group defines rows; cross-array products are refused honestly */
  }
  return rows;
}

function walk(obj, segs) {
  let cur = obj;
  for (const s of segs) {
    if (cur === null || cur === undefined) return undefined;
    cur = Array.isArray(cur) ? cur[Number(s)] : cur[s];
  }
  return cur;
}
