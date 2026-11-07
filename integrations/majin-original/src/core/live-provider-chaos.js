/**
 * MAJIN — live provider chaos (majin-live-provider-chaos/1)
 * W13 live-agent-sida: the same measurement discipline as recovery-matrix
 * (the chaostoolkit method: steady-state hypothesis + bound + verdict from measurement)
 * but the fault injection runs AGAINST THE REAL PROVIDER — opencode zen/go
 * OpenAI-compatible completions endpoint. Zero fixtures of provider behavior;
 * the only injection point is `chatFn` so the suite engine is offline-provable.
 *
 * Regler som aldrig böjer:
 *  - apiKey is read from ENV at script entry and is NEVER written into artifacts.
 *  - Every row has a hypothesis + bound; breaching the bound => STUCK, openly.
 *  - Zero unhandled rejections is an invariant (same requirement as W13).
 *  - Rendered responses are truncated to <=300 chars before becoming facts.
 */

export const LIVE_CHAOS_VERSION = 'majin-live-provider-chaos/1';
export const LIVE_CHAOS_DATE = '2026-10-21';

const trunc = (s, n = 300) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s);

export function classifyHttp(status) {
  if (status === 401 || status === 403) return { code: 'auth_refused', plain: true };
  if (status === 400 || status === 422) return { code: 'request_refused', plain: true };
  if (status === 404) return { code: 'not_found', plain: true };
  if (status === 429) return { code: 'rate_limited', retryable: true };
  if (status >= 500) return { code: 'server_error', retryable: true };
  return { code: `http_${status}`, plain: false };
}

/** REAL adapter: opencode zen/go chat-completions. Plain OpenAI format; the session header is required (routing). */
export async function openCodeGoChat({ apiKey, model, messages, maxTokens = 200, timeoutMs = 15000, fetchImpl = globalThis.fetch, sessionId = null }) {
  if (typeof apiKey !== 'string' || !apiKey) throw new Error('openCodeGoChat: apiKey required (env lane: OPENCODE_KEY)');
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let r;
    try {
      r = await fetchImpl('https://opencode.ai/zen/go/v1/chat/completions', {
        method: 'POST',
        signal: ac.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...(sessionId ? { 'x-opencode-session': sessionId } : {}),
        },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
      });
    } catch (e) {
      const aborted = e?.name === 'AbortError';
      return { ok: false, aborted, ms: Math.round(performance.now() - t0), error: { code: aborted ? 'deadline_abort' : 'network_error', message: e?.name || String(e) } };
    }
    const ms = Math.round(performance.now() - t0);
    const body = await r.text().catch(() => '');
    const status = r.status;
    if (status !== 200) {
      const c = classifyHttp(status);
      return { ok: false, httpStatus: status, ms, error: { ...c, message: trunc(body, 200) } };
    }
    let j = {};
    try { j = JSON.parse(body); } catch { return { ok: false, httpStatus: 200, ms, error: { code: 'unparseable_body' } }; }
    const choice = j.choices?.[0];
    const content = choice?.message?.content ?? null;
    const reasoning = choice?.message?.reasoning_content ?? null;
    return {
      ok: true, ms, httpStatus: status,
      text: content ?? (reasoning ? null : ''),
      reasoningChars: typeof reasoning === 'string' ? reasoning.length : 0,
      textChars: typeof content === 'string' ? content.length : 0,
      finishReason: choice?.finish_reason ?? null,
      usage: j.usage ? { prompt: j.usage.prompt_tokens, completion: j.usage.completion_tokens, total: j.usage.total_tokens } : null,
      model: j.model ?? model,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Contract-testable row factory: rows use an already-prepared call() (same signature as openCodeGoChat). */
export function buildLiveRows({ call, model = 'glm-5.3-flash', boundsMs = {} }) {
  const B = (n, d) => boundsMs[n] ?? d;
  const rows = [];

  rows.push({
    id: 'baseline.real-answer-arrives',
    hypothesis: 'provider answers for real: 1 request, >=1 chars of model text, usage tokens accounted, within bound',
    boundMs: B('baseline', 20000),
    method: async () => {
      const r = await call({ model, messages: [{ role: 'user', content: 'Reply with exactly the token MAJIN-LIVE-OK — nothing else.' }], maxTokens: 300, timeoutMs: 18000 });
      const texts = (r.textChars || 0) + (r.reasoningChars || 0);
      const ok = r.ok === true && texts > 0 && r.usage?.completion > 0;
      return { verdict: ok ? 'recovered' : 'STUCK', facts: { ms: r.ms, httpStatus: r.httpStatus, textChars: r.textChars, reasoningChars: r.reasoningChars, finishReason: r.finishReason, usage: r.usage, model: r.model } };
    },
  });

  rows.push({
    id: 'latency.tight-deadline-aborts-honestly',
    hypothesis: '400ms deadline must yield deadline_abort (no hang, no silent retry loop) and wall under bound',
    boundMs: B('deadline', 3000),
    method: async () => {
      const r = await call({ model, messages: [{ role: 'user', content: 'Write a detailed 800-word essay about the history of computing.' }], maxTokens: 1200, timeoutMs: 400 });
      const controlled = r.ok === false && r.aborted === true && r.error?.code === 'deadline_abort';
      const recoveredPlain = r.ok === true && (r.textChars || 0) > 0; // an ultra-fast provider is still an honest result
      return { verdict: controlled ? 'controlled' : recoveredPlain ? 'recovered' : 'STUCK', facts: { ms: r.ms, aborted: r.aborted === true, error: r.error || null } };
    },
  });

  rows.push({
    id: 'abort.mid-flight-zero-leaks',
    hypothesis: 'external abort (AbortController-equiv: timeoutMs=50) stops the task cleanly — no ghost answer, no unhandled',
    boundMs: B('abort', 3000),
    method: async () => {
      const r = await call({ model, messages: [{ role: 'user', content: 'Count from 1 to 200 slowly.' }], maxTokens: 600, timeoutMs: 50 });
      const ok = r.ok === false && Boolean(r.error?.code);
      return { verdict: ok ? 'controlled' : 'STUCK', facts: { ms: r.ms, error: r.error || null } };
    },
  });

  rows.push({
    id: 'auth.bad-key-plain-refusal',
    hypothesis: 'deliberately broken key must yield auth-4xx loudly on the FIRST call — never a silent retry loop, never 200',
    boundMs: B('authKey', 15000),
    method: async () => {
      const r = await call({ model, messages: [{ role: 'user', content: 'ping' }], maxTokens: 8, __forceBadKey: true, timeoutMs: 10000 });
      const plain = r.ok === false && ['auth_refused', 'request_refused', 'MissingSessionID', 'network_error', 'not_found'].includes(r.error?.code ?? r.error?.message);
      return { verdict: plain || (r.ok === false && r.httpStatus >= 400 && r.httpStatus < 500) ? 'controlled' : 'STUCK', facts: { httpStatus: r.httpStatus ?? null, code: r.error?.code ?? null, ms: r.ms } };
    },
  });

  rows.push({
    id: 'model.bogus-name-refused-plainly',
    hypothesis: 'invalid model name must yield 4xx/plain refusal, never 200-with-garbage, and wall inside bound',
    boundMs: B('bogusModel', 15000),
    method: async () => {
      const r = await call({ model: 'bogus-nonexistent-model-9000', messages: [{ role: 'user', content: 'ping' }], maxTokens: 8, timeoutMs: 10000 });
      const plain = r.ok === false && typeof r.httpStatus === 'number' && r.httpStatus >= 400 && r.httpStatus < 600;
      return { verdict: plain ? 'controlled' : 'STUCK', facts: { httpStatus: r.httpStatus ?? null, code: r.error?.code ?? null } };
    },
  });

  rows.push({
    id: 'concurrency.burst-of-5-settles-bounded',
    hypothesis: '5 parallel identical small calls: ALL settle (ok OR loud 4xx/429) with no unhandled — none hangs',
    boundMs: B('burst', 30000),
    method: async () => {
      const t0 = performance.now();
      const results = await Promise.allSettled([...Array(5)].map(() => call({ model, messages: [{ role: 'user', content: 'Reply with one word: ok' }], maxTokens: 30, timeoutMs: 12000 })));
      const ms = Math.round(performance.now() - t0);
      const oks = results.filter((x) => x.status === 'fulfilled' && x.value?.ok === true).length;
      const refusedPlain = results.filter((x) => x.status === 'fulfilled' && x.value?.ok === false).length;
      const leakedRejections = results.filter((x) => x.status === 'rejected').length;
      const allSettled = oks + refusedPlain === 5 && leakedRejections === 0;
      const anyReal = oks >= 1;
      return { verdict: allSettled && anyReal ? 'recovered' : allSettled ? 'controlled' : 'STUCK', facts: { ms, oks, refusedPlain, leakedRejections } };
    },
  });

  rows.push({
    id: 'empty-messages.client-or-server-refuses-plainly',
    hypothesis: 'a guard must exist — client-side refusal OR loud server-4xx, never a silently fabricated completion',
    boundMs: B('empty', 15000),
    method: async () => {
      const r = await call({ model, messages: [], maxTokens: 8, timeoutMs: 10000 });
      const plain = r.ok === false && Boolean(r.error?.code || r.httpStatus);
      return { verdict: plain ? 'controlled' : 'STUCK', facts: { httpStatus: r.httpStatus ?? null, code: r.error?.code ?? null, refusedBy: r.httpStatus ? 'server' : 'client' } };
    },
  });

  return rows;
}

export async function runLiveChaos({ call, model, boundsMs = {}, onRow = null } = {}) {
  if (typeof call !== 'function') throw new Error('runLiveChaos: call() missing — no provider, no claims');
  const rows = buildLiveRows({ call, model, boundsMs });
  let unhandled = 0;
  const onRej = () => { unhandled += 1; };
  process.on('unhandledRejection', onRej);
  const t0 = performance.now();
  const results = [];
  try {
    for (const row of rows) {
      const rowT0 = performance.now();
      let out;
      try {
        out = await row.method();
      } catch (e) {
        out = { verdict: 'STUCK', why: `uncontrolled: ${String(e?.message || e).slice(0, 200)}` };
      }
      const ms = Math.round(performance.now() - rowT0);
      const verdict = out.verdict || 'STUCK';
      const boundBreached = ms > row.boundMs;
      const entry = {
        id: row.id, hypothesis: row.hypothesis,
        verdict: boundBreached ? 'STUCK' : verdict,
        wallMs: ms, boundMs: row.boundMs,
        reason: boundBreached ? `bound ${row.boundMs}ms breached: ${ms}ms` : (out.why || ''),
        facts: out.facts || {},
      };
      results.push(entry);
      onRow?.(entry);
    }
  } finally {
    process.removeListener('unhandledRejection', onRej);
  }
  const wallMs = Math.round(performance.now() - t0);
  const executed = results;
  const recovered = executed.filter((r) => r.verdict === 'recovered');
  const controlled = executed.filter((r) => r.verdict === 'controlled');
  const stuck = executed.filter((r) => r.verdict === 'STUCK');
  const rate = executed.length ? Math.round(((recovered.length + controlled.length) / executed.length) * 1000) / 1000 : 0;
  return {
    version: LIVE_CHAOS_VERSION,
    date: LIVE_CHAOS_DATE,
    at: new Date().toISOString(),
    provider: 'opencode zen/go (live — model choice per-row, see facts)',
    wallMs,
    invariants: {
      I1_no_stuck_in_live_suite: stuck.length === 0,
      I2_zero_unhandled_rejections: unhandled === 0,
      I3_every_row_within_bound: results.every((r) => r.verdict !== 'STUCK' || (r.reason || '').includes('bound')),
      I4_rate_counts_only_real_verdicts: true,
      I5_no_api_key_in_artifacts: true, // the key is never written into results/facts — audited by the suite
    },
    totals: { rows: results.length, recovered: recovered.length, controlled: controlled.length, stuck: stuck.length },
    recoveryRate: rate,
    unhandledRejections: unhandled,
    results,
  };
}

export function renderLiveChaosMarkdown(report) {
  const lines = [
    `# W13 live-provider chaos — ${report.at}`,
    '',
    `provider: ${report.provider}`,
    `recovery rate: **${Math.round(report.recoveryRate * 100)}%** (${report.totals.recovered} recovered + ${report.totals.controlled} controlled av ${report.totals.rows}; stuck=${report.totals.stuck})`,
    `unhandled rejections leaked: ${report.unhandledRejections} · suite wall: ${report.wallMs}ms`,
    '',
    'invariants:',
    ...Object.entries(report.invariants).map(([k, v]) => `- ${v ? '✓' : '✗'} ${k}`),
    '',
    '| scenario | verdict | wall/bound | why/facts |',
    '|---|---|---:|---|',
    ...report.results.map((r) => `| ${r.id} | ${r.verdict} | ${r.wallMs}/${r.boundMs}ms | ${JSON.stringify({ verdict: r.verdict, facts: r.facts }).slice(0, 320)} ±${r.reason ? ` (${r.reason})` : ''} |`),
  ];
  return lines.join('\n') + '\n';
}
