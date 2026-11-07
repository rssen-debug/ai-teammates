/**
 * MAJIN V2 GODMODE — operator doctor.
 * Honest preflight for the operator machine: every check reports a real
 * probe result. States, exactly these words (honesty column discipline):
 *  OK              — probe passed
 *  FAIL            — probe ran and FAILED (core requirement unmet)
 *  MISSING         — optional component expected but absent/path wrong
 *  NOT_CONFIGURED  — optional component not configured at all (no probe attempted)
 *  NOT_REACHABLE   — probe attempted, target refused/unreachable (real error kept)
 * Requirement class: CORE (release cannot operate) or OPT (lane stays gated).
 */

const DOCTOR_TIMEOUT_MS = 1000;

async function probeUrl(url, { timeoutMs = DOCTOR_TIMEOUT_MS } = {}) {
  const started = Date.now();
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    return { ok: res.ok, status: res.status, elapsedMs: Date.now() - started };
  } catch (e) {
    return { ok: false, status: null, error: e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message), elapsedMs: Date.now() - started };
  }
}

/**
 * runDoctor({ env, fsMod, fetchImpl?, paths, runnerUrl, whisperBin, studioPort })
 * Everything injectable for offline proof; defaults are the real machine view.
 */
export async function runDoctor({
  env = process.env,
  fsMod = null,
  paths = {},
  runnerUrl = null,
  whisperBin = null,
  studioPort = 4783,
  fetchImpl = null,
} = {}) {
  const fs = fsMod || (await import('node:fs'));
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const checks = [];

  const rows = [];
  const add = (name, req, state, detail) => { checks.push({ name, req, state, detail }); };

  /* CORE: Node >=22, matching canonicalize and p-queue runtime engines. */
  {
    const major = Number((process.versions.node || '0').split('.')[0]);
    add('node-runtime', 'CORE', major >= 22 ? 'OK' : 'FAIL', `node v${process.versions.node} (requires >= 22)`);
  }

  /* CORE: repo shape — bin entrypoint present */
  {
    const bin = paths.bin || 'bin/majin-v2.mjs';
    add('repo-entrypoint', 'CORE', fs.existsSync(bin) ? 'OK' : 'FAIL', bin);
  }

  /* CORE: work dirs creatable/writable (probe = real mkdir + write + cleanup) */
  for (const [key, def] of [['telemetry', 'v2-telemetry'], ['audit', 'v2-audit'], ['run', 'v2-run'], ['voice', 'v2-voice']]) {
    const dir = paths[key] || def;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.doctor-${crypto.randomBytes(4).toString('hex')}`);
      fs.writeFileSync(probe, 'probe');
      fs.unlinkSync(probe);
      add(`dir:${key}`, 'CORE', 'OK', `${dir} writable (created + verified + cleaned)`);
    } catch (e) {
      add(`dir:${key}`, 'CORE', 'FAIL', `${dir}: ${e.code || e.message}`);
    }
  }

  /* OPT: opencode key — presence as boolean + fingerprint ONLY, value never leaves */
  {
    const key = env.OPENCODE_API_KEY || '';
    if (!key) {
      add('opencode-key', 'OPT', 'NOT_CONFIGURED', 'live lane gated: OPENCODE_API_KEY not in env (honest — no live calls without it)');
    } else {
      const fp = crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
      add('opencode-key', 'OPT', 'OK', `present, sha256:${fp}… (fingerprint only; the value never leaves env)`);
    }
  }

  /* OPT: runner reachability — real probe, real error retained, no hang */
  {
    if (!runnerUrl) {
      add('gui-runner', 'OPT', 'NOT_CONFIGURED', 'live GUI-QA gated: --runner-url not given (MAJIN-INTERACTIVE-01?)');
    } else {
      const r = fetchImpl ? await fetchImpl(runnerUrl).then((x) => ({ ok: x.ok, status: x.status })).catch((e) => ({ ok: false, error: e.message })) : await probeUrl(runnerUrl);
      add('gui-runner', 'OPT', r.ok ? 'OK' : 'NOT_REACHABLE', r.ok ? `${runnerUrl} answered HTTP ${r.status}` : `${runnerUrl}: ${r.error || 'HTTP ' + r.status}`);
    }
  }

  /* OPT: whisper binary — existence probe only (execution requires audio payload) */
  {
    if (!whisperBin) {
      add('whisper-stt', 'OPT', 'NOT_CONFIGURED', 'listen lane gated: --doctor-whisper-bin not given');
    } else if (fs.existsSync(whisperBin)) {
      const st = fs.statSync(whisperBin);
      add('whisper-stt', 'OPT', 'OK', `${whisperBin} exists (${st.size} bytes; execution requires an audio payload)`);
    } else {
      add('whisper-stt', 'OPT', 'MISSING', `${whisperBin}: file does not exist`);
    }
  }

  /* OPT: studio port availability — real bind probe */
  {
    const net = await import('node:net');
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(studioPort, '127.0.0.1');
    });
    add('studio-port', 'OPT', free ? 'OK' : 'FAIL', `127.0.0.1:${studioPort} ${free ? 'free (bind probe verified)' : 'OCCUPIED (bind probe)'}`);
  }

  const coreFailed = checks.filter((c) => c.req === 'CORE' && c.state !== 'OK');
  const gaps = checks.filter((c) => c.req === 'OPT' && c.state !== 'OK');
  const verdict = coreFailed.length > 0 ? 'NOT_READY' : gaps.length > 0 ? 'READY_WITH_GATES' : 'READY';
  return { verdict, checks, summary: { coreFailed: coreFailed.length, gatedOpt: gaps.length } };
}

/** CLI formatter — the table is the report; states are the honest words above */
export function formatDoctor(result) {
  const lines = ['MAJIN V2 DOCTOR', '================'];
  for (const c of result.checks) {
    lines.push(`${c.state.padEnd(15)} [${c.req}] ${c.name} — ${c.detail}`);
  }
  lines.push('----------------');
  lines.push(`VERDICT: ${result.verdict} (core-fail: ${result.summary.coreFailed}, gated-optional: ${result.summary.gatedOpt})`);
  if (result.verdict === 'READY_WITH_GATES') {
    lines.push('Core release runnable now; the listed gates open via docs/v2/OPERATOR_RUNBOOK_WINDOWS.md.');
  } else if (result.verdict === 'NOT_READY') {
    lines.push('Fix the CORE rows above. The doctor fabricates no OK — these are real failures.');
  }
  return lines.join('\n');
}
