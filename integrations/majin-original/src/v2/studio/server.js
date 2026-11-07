/**
 * MAJIN V2 Studio server — read-only operator surface over the REAL kernel
 * objects (EventBus, TelemetryLedger shards, AuditChain). Zero deps: node:http.
 *
 * Architecture pattern reused (logged in DEPENDENCIES_AND_LICENSES.md), not
 * code: opencode's server split — REST for documents, SSE for the live stream:
 *   GET /                    inline single-file page (no external assets)
 *   GET /api/events          SSE: synthetic server.connected first, ring-buffer
 *                            replay, then live bus events, heartbeat comments
 *   GET /api/telemetry?days  aggregate() JSON over the ledger shards
 *   GET /api/audit/verify    AuditChain.verify() — the honest verdict as-is
 *
 * Safety: read-only BY CONSTRUCTION — there are no POST/PUT/DELETE routes at
 * all; nothing in this process can mutate goals, consents or files. Operator
 * write actions belong to a later lane behind approvals.check(), never here.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { AuditChain, AUDIT_FILE } from '../audit/chain.js';
import { aggregate } from '../telemetry/aggregate.js';
import { EVENT_NAMES } from '../runtime/events.js';

// consent lifecycle travels on these names (approvals.js emits them; EVENT_NAMES
// is the kernel-centric list — operator surfaces need both)
const STUDIO_EVENT_NAMES = [...new Set([...EVENT_NAMES, 'task.updated', 'consent.revoked', 'consent.expired', 'approval.required'])];
import { renderStudioPage } from './page.js';

const HEARTBEAT_MS = 15000;
const REPLAY_LIMIT = 100;

/** fresh-instance verification — endpoint answers never trust server memory */
function safeChainVerify(auditDir) {
  try {
    return new AuditChain(auditDir).verify();
  } catch (err) {
    return { ok: false, reason: err.cls || 'FAILED', detail: String(err.message || err) };
  }
}

function readChainEntries(auditDir) {
  const file = path.join(auditDir, AUDIT_FILE);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    try { out.push(JSON.parse(line)); } catch { /* the verify() verdict above carries the truth; a partial line just does not render */ }
  }
  return out;
}

/** operator-friendly payload projection: keep it shallow and small */
function summarize(payload) {
  const out = {};
  for (const k of Object.keys(payload || {}).slice(0, 10)) {
    const v = payload[k];
    out[k] = typeof v === 'object' && v !== null ? '[obj]' : v;
  }
  return out;
}

export function createStudioServer({
  bus,
  telemetryDir,
  auditDir,
  page = null, // default built AFTER enableWrites is known — the UI never lies about the gate
  approvals = null,      // Approvals instance — required when enableWrites/enableGoals
  enableWrites = false,  // consent write surface; OFF unless explicitly enabled
  enableGoals = null,    // { workspaceDir, provider? } — objective runs; OFF unless explicitly enabled
  voice = null,          // { outDir, tts?, stt? } — speak/listen surfaces; OFF unless explicitly enabled
  enableBundle = null,   // { dir } — evidence dossier export/verify; OFF unless explicitly enabled
  enableDoctor = null,   // { runnerUrl?, whisperBin?, studioPort? } — preflight dogfood in the UI; OFF unless explicitly enabled
} = {}) {
  if (!bus) throw new Error('studio requires an EventBus');
  if (!telemetryDir) throw new Error('studio requires telemetryDir');
  if (!auditDir) throw new Error('studio requires auditDir');
  if (enableWrites && !approvals) throw new Error('enableWrites requires an Approvals instance');
  if (enableGoals) {
    if (!approvals) throw new Error('enableGoals requires an Approvals instance — runs pay consent like every other held op');
    if (!enableGoals.workspaceDir) throw new Error('enableGoals requires a FIXED workspaceDir (client-supplied paths are never honoured)');
  }
  const goals = enableGoals
    ? { workspaceDir: enableGoals.workspaceDir, provider: enableGoals.provider || null, busy: false, current: null }
    : null;
  if (voice && !voice.outDir) throw new Error('voice requires outDir');
  if (enableBundle && !enableBundle.dir) throw new Error('bundle surface requires a FIXED dir (client-supplied destinations are never honoured)');
  const bundle = enableBundle ? { dir: enableBundle.dir } : null;
  if (page == null) page = renderStudioPage({ enableWrites, enableGoals: !!enableGoals, enableVoice: !!voice, enableBundle: !!bundle, enableDoctor: !!enableDoctor });

  const clients = new Set();
  const unsubs = STUDIO_EVENT_NAMES.map((name) =>
    bus.on(name, (event) => {
      const frame = `data: ${JSON.stringify(event)}\n\n`;
      for (const res of clients) {
        try { res.write(frame); } catch { clients.delete(res); }
      }
    })
  );

  const heartbeat = setInterval(() => {
    for (const res of clients) {
      try { res.write(`: hb ${Date.now()}\n\n`); } catch { clients.delete(res); }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const MAX_BODY = 8192;
  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  function readBody(req, cap = MAX_BODY) {
    return new Promise((resolve, reject) => {
      // drain-and-discard past the cap: destroying the socket mid-upload would
      // give the client ECONNRESET and no answer; a 413 must always LAND.
      let size = 0;
      let tooLarge = false;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > cap) { tooLarge = true; return; }
        if (!tooLarge) chunks.push(c);
      });
      req.on('end', () => {
        if (tooLarge) reject(Object.assign(new Error('body too large'), { code: 413 }));
        else resolve(Buffer.concat(chunks).toString('utf8'));
      });
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://studio.local');

    // ---- voice surfaces (speak/listen lanes with consent paths intact) ----
    if (url.pathname === '/api/voice/speak' && req.method === 'POST') {
      if (!voice?.tts) {
        json(res, 403, { error: 'voice surface disabled', detail: 'start studio with --enable-voice --voice-dir — disabled means SILENCE, no hidden synthesis' });
        return;
      }
      let body;
      try {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch (err) {
        json(res, err.code === 413 ? 413 : 400, { error: err.code === 413 ? 'body too large' : 'invalid JSON body' });
        return;
      }
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > 4000) {
        json(res, 400, { error: 'text must be a non-empty string (max 4000 chars)' });
        return;
      }
      try {
        const { speak } = await import('../voice/speak.js');
        const crypto = await import('node:crypto');
        const ext = voice.tts.formatHint || (voice.tts.name === 'buffer' ? 'wav' : 'mp3');
        const outPath = path.join(voice.outDir, `speak-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`);
        const ledger = new (await import('../telemetry/ledger.js')).TelemetryLedger(telemetryDir);
        const r = await speak(text, { provider: voice.tts, approvals, telemetry: ledger, events: bus, outPath });
        if (!r.ok && r.decision === 'waiting') {
          json(res, 403, { decision: 'waiting', pendingScope: r.pendingScope, reason: r.reason, hint: 'grant scope voice:external via the Consent panel — external synthesis never runs silently' });
          return;
        }
        json(res, 200, { ok: true, audio: `/api/voice/audio/${path.basename(r.audioPath)}`, bytes: r.bytes, format: r.format || ext, verified: r.verified, provider: r.provider, durationMs: r.durationMs });
      } catch (err) {
        json(res, err.cls === 'DEPENDENCY_MISSING' ? 503 : 400, { error: String(err.message || err).slice(0, 300), cls: err.cls || 'ERROR' });
      }
      return;
    }

    if (url.pathname.startsWith('/api/voice/audio/') && req.method === 'GET') {
      if (!voice) { json(res, 404, { error: 'voice disabled' }); return; }
      const name = decodeURIComponent(url.pathname.slice('/api/voice/audio/'.length));
      if (!/^[\w.-]{1,128}$/.test(name)) {
        json(res, 400, { error: 'invalid audio name (path traversal is refused, not sanitized)' });
        return;
      }
      const full = path.join(voice.outDir, name);
      if (!full.startsWith(path.resolve(voice.outDir) + path.sep) && full !== path.join(voice.outDir, name)) { /* resolved-outDir check below */ }
      const resolved = path.resolve(full);
      if (!resolved.startsWith(path.resolve(voice.outDir) + path.sep)) {
        json(res, 400, { error: 'refused: outside voice outDir' });
        return;
      }
      if (!fs.existsSync(resolved)) { json(res, 404, { error: 'no such audio' }); return; }
      const mime = resolved.endsWith('.mp3') ? 'audio/mpeg' : resolved.endsWith('.wav') ? 'audio/wav' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': mime, 'content-length': fs.statSync(resolved).size });
      fs.createReadStream(resolved).pipe(res);
      return;
    }

    if (url.pathname === '/api/voice/listen' && req.method === 'POST') {
      if (!voice?.stt) {
        json(res, 403, { error: 'stt surface disabled', detail: 'configure a stt provider (--voice-stt-command) — no provider means honest NOTHING, no fabricated transcript' });
        return;
      }
      let body;
      try {
        const raw = await readBody(req, 25 * 1024 * 1024); // audio is big; the 8KB text cap does not apply
        body = raw ? JSON.parse(raw) : {};
      } catch (err) {
        json(res, err.code === 413 ? 413 : 400, { error: err.code === 413 ? 'audio too large (max 25MB)' : 'invalid JSON body' });
        return;
      }
      let wav;
      try {
        wav = Buffer.from(String(body.wavBase64 || ''), 'base64');
        if (wav.length < 44) throw new Error('too small');
      } catch {
        json(res, 400, { error: 'wavBase64 must decode to a real WAV payload (>= 44 bytes)' });
        return;
      }
      const crypto = await import('node:crypto');
      const wavPath = path.join(voice.outDir, `listen-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.wav`);
      fs.mkdirSync(voice.outDir, { recursive: true });
      fs.writeFileSync(wavPath, wav);
      try {
        const { listen } = await import('../voice/listen.js');
        const ledger = new (await import('../telemetry/ledger.js')).TelemetryLedger(telemetryDir);
        const r = await listen(wavPath, { provider: voice.stt, approvals, telemetry: ledger, events: bus });
        if (!r.ok && r.decision === 'waiting') {
          json(res, 403, { decision: 'waiting', pendingScope: r.pendingScope, reason: r.reason, hint: 'grant scope voice:external via the Consent panel' });
          return;
        }
        // honest verdict: transcript never fabricated by us — provider truth passes through
        json(res, 200, { ok: true, verdict: r.transcript && r.transcript !== '' ? 'capture' : 'inconclusive', transcript: r.transcript ?? '', provider: r.provider, bytes: wav.length });
      } catch (err) {
        json(res, err.cls === 'DEPENDENCY_MISSING' ? 503 : err.cls === 'PERMISSION_DENIED' ? 403 : 500, { error: String(err.message || err).slice(0, 300), cls: err.cls || 'ERROR' });
      } finally {
        fs.rmSync(wavPath, { force: true }); // uploads are transient; the verdict is the artifact
      }
      return;
    }

    // ---- consent write surface ( Approvals is the only authority; studio is a gate ) ----
    if (req.method === 'POST' && url.pathname === '/api/consent') {
      if (!enableWrites) {
        json(res, 403, { error: 'writes disabled', detail: 'consent writes require starting studio with enableWrites — silence/disabled means NO, never a silent grant' });
        return;
      }
      let body;
      try {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch (err) {
        json(res, err.code === 413 ? 413 : 400, { error: err.code === 413 ? 'body too large' : 'invalid JSON body' });
        return;
      }
      const { scope, user, mode, maxUses, ttlMs } = body;
      if (typeof scope !== 'string' || !scope || scope.length > 256) {
        json(res, 400, { error: 'scope must be a non-empty string (max 256 chars)' });
        return;
      }
      try {
        // Approvals enforces: named human required, known mode required.
        // rejections are DATA the operator needs — surface them, never mask.
        approvals.grant(scope, { user, mode, maxUses, ttlMs });
      } catch (err) {
        json(res, 400, { error: String(err.message || err), scope });
        return;
      }
      json(res, 201, { granted: scope, status: approvals.status(scope) });
      return;
    }

    if (req.method === 'DELETE' && url.pathname === '/api/consent') {
      if (!enableWrites) {
        json(res, 403, { error: 'writes disabled' });
        return;
      }
      const scope = url.searchParams.get('scope');
      if (!scope) {
        json(res, 400, { error: 'DELETE /api/consent requires ?scope=' });
        return;
      }
      const existed = approvals.status(scope).granted;
      approvals.revoke(scope);
      json(res, 200, { revoked: scope, existed });
      return;
    }

    if (url.pathname === '/api/goals' && req.method === 'POST') {
      if (!goals) {
        json(res, 403, { error: 'goals surface disabled', detail: 'start studio with enableGoals — disabled means NO runs, never a silent maybe' });
        return;
      }
      // busy precedes the gate: a refused-overlap request must NOT burn a
      // consent use the operator paid for (found by test — one 409 consumed a grant)
      if (goals.busy) {
        json(res, 409, { error: 'a goal is already running', current: goals.current, note: 'concurrency is refused honestly, one operator-run at a time (no consent consumed)' });
        return;
      }
      // consent gate — dogfooding: a studio run pays exactly like any held op;
      // one grant = one run (mode 'once' is the natural approval)
      const gate = approvals.check('studio:run-goals', { preflightReason: 'operator UI objective run' });
      if (gate.decision !== 'allow') {
        json(res, 403, { decision: gate.decision, note: gate.note, requiredScope: 'studio:run-goals', hint: 'grant via the Consent panel (POST /api/consent) — exactly that scope, nothing wider' });
        return;
      }
      let body;
      try {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch (err) {
        json(res, err.code === 413 ? 413 : 400, { error: err.code === 413 ? 'body too large' : 'invalid JSON body' });
        return;
      }
      const objective = typeof body.objective === 'string' ? body.objective.trim() : '';
      if (!objective || objective.length > 2000) {
        json(res, 400, { error: 'objective must be a non-empty string (max 2000 chars)' });
        return;
      }
      // workspace is FIXED at server start — any path in the body is ignored by
      // construction and told so, never silently honoured (injection surface)
      const workspaceFixed = goals.workspaceDir;
      goals.busy = true;
      goals.current = { objective: objective.slice(0, 120), startedAt: new Date().toISOString() };
      bus.emit('goal.created', { goalId: 'studio:' + Date.now().toString(36), source: 'studio', objectiveLen: objective.length });
      try {
        const { runObjective } = await import('../runtime/orchestrator.js');
        const { TelemetryLedger } = await import('../telemetry/ledger.js');
        const telemetry = new TelemetryLedger(telemetryDir);
        const summary = await runObjective(objective, { workspaceDir: workspaceFixed, events: bus, provider: goals.provider, telemetry });
        // final state is DATA — a FAILED goal is a 200 with the truth, not a hidden 500
        json(res, 200, { state: summary.goal?.state || summary.finalState || 'UNKNOWN', produced: summary.produced || [], compiler: summary.compiler?.source || null, workspaceFixed, workspaceOverrideIgnored: 'workspace' in body });
      } catch (err) {
        json(res, 200, { state: 'ERROR', error: String(err.message || err).slice(0, 300), workspaceFixed });
      } finally {
        goals.busy = false;
        goals.current = null;
      }
      return;
    }

    if (url.pathname === '/api/doctor/run' && req.method === 'POST') {
      if (!enableDoctor) {
        json(res, 403, { error: 'doctor panel disabled — start with --enable-doctor-panel. disabled means NO probe (honest gate)', cls: 'SURFACE_DISABLED' });
        return;
      }
      const { runDoctor } = await import('../ops/doctor.js');
      const report = await runDoctor({
        paths: { telemetry: telemetryDir, audit: auditDir, bin: 'bin/majin-v2.mjs' },
        runnerUrl: enableDoctor.runnerUrl || null,
        whisperBin: enableDoctor.whisperBin || null,
        studioPort: enableDoctor.studioPort || 0,
      });
      json(res, 200, { ok: true, verdict: report.verdict, summary: report.summary, checks: report.checks });
      return;
    }

    if (url.pathname === '/api/bundle/export' && req.method === 'POST') {
      if (!bundle) {
        json(res, 403, { error: 'bundle surface disabled — start with --bundle-dir. Disabled means NO dossier (honest gate)', cls: 'SURFACE_DISABLED' });
        return;
      }
      try {
        const { exportBundle } = await import('../audit/export.js');
        const r = exportBundle(auditDir, bundle.dir);
        json(res, 200, { ok: true, files: r.files, stats: r.stats });
      } catch (e) {
        json(res, 409, { ok: false, cls: e.cls || 'FAILED', error: e.message });
      }
      return;
    }

    if (url.pathname === '/api/bundle/verify' && req.method === 'POST') {
      if (!bundle) {
        json(res, 403, { error: 'bundle surface disabled — start with --bundle-dir. Disabled means NO dossier (honest gate)', cls: 'SURFACE_DISABLED' });
        return;
      }
      const { verifyBundle } = await import('../audit/export.js');
      const v = verifyBundle(bundle.dir);
      json(res, 200, {
        ok: v.ok, cls: v.cls, detail: v.detail || '',
        chainEntries: v.chain?.entries ?? null,
        anchors: v.anchors?.cls ?? null, tsr: v.tsr?.cls ?? null, genTime: v.tsr?.genTime ?? null,
      });
      return;
    }

    if (url.pathname === '/api/goals/active' && req.method === 'GET') {
      json(res, 200, goals ? { enabled: true, busy: goals.busy, current: goals.current } : { enabled: false, busy: false, current: null });
      return;
    }

    if (req.method !== 'GET') {
      json(res, 405, { error: 'unsupported method on this surface', method: req.method });
      return;
    }

    if (url.pathname === '/api/consent/status') {
      if (!approvals) {
        json(res, 503, { error: 'no approvals instance wired', granted: false });
        return;
      }
      const scope = url.searchParams.get('scope');
      if (!scope) {
        json(res, 400, { error: 'requires ?scope=' });
        return;
      }
      json(res, 200, approvals.status(scope));
      return;
    }

    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }

    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      // synthetic first event — the observation boundary marker (opencode shape)
      res.write(`data: ${JSON.stringify({ type: 'server.connected', at: new Date().toISOString() })}\n\n`);
      for (const e of bus.audit({ last: REPLAY_LIMIT })) {
        res.write(`data: ${JSON.stringify(e)}\n\n`);
      }
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (url.pathname === '/api/telemetry') {
      const days = Math.max(1, Math.min(90, Number(url.searchParams.get('days')) || 7));
      try {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(aggregate(telemetryDir, { lastDays: days })));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(err.message || err) }));
      }
      return;
    }

    if (url.pathname === '/api/audit/verify') {      // fresh instance — verification never trusts the server's in-memory view
      let verdict;
      try {
        verdict = new AuditChain(auditDir).verify();
      } catch (err) {
        verdict = { ok: false, reason: err.cls || 'FAILED', detail: String(err.message || err) };
      }
      res.writeHead(200, { 'content-type': 'application/json' }); // verdict is DATA — a broken chain is not a transport failure
      res.end(JSON.stringify(verdict));
      return;
    }

    if (url.pathname === '/api/receipts') {
      // receipts are chain entries of kind 'receipt' — the chain is the ONLY
      // source of truth; a broken chain yields an honest empty answer with
      // the reason attached, never silently stale "facts"
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
      const goalId = url.searchParams.get('goalId');
      const verdict = safeChainVerify(auditDir);
      if (!verdict.ok) {
        json(res, 200, { ok: false, reason: verdict.reason, receipts: [], note: 'chain broken — receipts withheld, not presented as fact' });
        return;
      }
      let entries = readChainEntries(auditDir).filter((e) => e.kind === 'receipt');
      if (goalId) entries = entries.filter((e) => e.payload.goalId === goalId);
      const receipts = entries.slice(-limit).map((e) => ({ seq: e.seq, at: e.ts, ...e.payload }));
      json(res, 200, { ok: true, count: receipts.length, goalId: goalId || null, receipts });
      return;
    }

    if (url.pathname === '/api/chain/tail') {
      const n = Math.max(1, Math.min(100, Number(url.searchParams.get('n')) || 20));
      const verdict = safeChainVerify(auditDir);
      if (!verdict.ok) {
        json(res, 200, { ok: false, reason: verdict.reason, entries: [] });
        return;
      }
      const entries = readChainEntries(auditDir).slice(-n).map((e) => ({ seq: e.seq, at: e.ts, kind: e.kind, actor: e.actor, ...summarize(e.payload) }));
      json(res, 200, { ok: true, count: entries.length, entries });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found', path: url.pathname }));
  });

  server.on('close', () => {
    clearInterval(heartbeat);
    for (const u of unsubs) u();
  });

  /** listen(): returns actual bound address (port 0 — ephemeral — supported) */
  function listen({ port = 0, host = '127.0.0.1' } = {}) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        const addr = server.address();
        resolve({ host: addr.address, port: addr.port, url: `http://${addr.address}:${addr.port}` });
      });
    });
  }

  // close(): deterministic — long-lived SSE keep-alives never stall teardown
  function close() {
    return new Promise((resolve) => {
      for (const res of clients) { try { res.end(); } catch { /* already gone */ } }
      clients.clear();
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }

  return { server, listen, close };
}
