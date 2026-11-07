/**
 * MAJIN — provider transport.
 * One request path, three dialects (OpenAI-compatible, Anthropic, mock).
 * Streaming in, tool calls out, retries with backoff, token+cost accounting.
 */
import { bus } from '../log.js';
import { admit, record, noteViolation, retryAfterMs, classify, estimateInputTokens } from '../ratelimit.js';
import { openaiStream, openaiOnce } from './openai.js';
import { anthropicStream, anthropicOnce } from './anthropic.js';
import { mockComplete } from './mock.js';
import { responsesStream, responsesOnce } from './responses.js';

export class ProviderError extends Error {
  constructor(msg, { status = 0, code = 'provider_error', hint = null, retryable = false } = {}) {
    super(msg);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.retryable = retryable;
  }
}

/**
 * @param {object} o
 * @param {object} o.route      cfg.resolveModel() output
 * @param {Array}  o.messages   [{role, content|tool_calls}]
 * @param {Array}  [o.tools]    [{name, description, parameters}]
 * @param {Function} [o.onEvent] (ev)=>void  {type:'delta',text} | {type:'tool',name}
 */
/**
 * Ett providerfel ar det vanligaste en nyborjare moter, och det vanligaste
 * svaret blir en rad ingen forstar. Har oversatts varje felform till en mening
 * med nasta handling - och klassen som avgor om det alls gar att forsoka igen.
 * Ett fel som aldrig lost sig (fel nyckel, slut pa krediter) ska inte fa loopen
 * att branna fyra steg mot samma dorr.
 */
const KEYCARD = 'Open the Providers card (right side), paste the key and press test.';
const NET_RE = /EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENETDOWN|ETIMEDOUT|EPIPE|EPROTO|socket hang up|network|fetch failed|Client network socket disconnected|timeout of|timed? ?out/i;
const BIG_RE = /context (window|length|limit)|too many tokens|prompt is too long|input is too long|maximum context|exceeds the model/i;

export function explainError(err, route = {}) {
  const raw = route.label || route.providerName || '';
  const who = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : 'The provider';
  const status = Number(err?.status) || 0;
  const msg = String(err?.message || '');
  const cause = String(err?.cause?.code || err?.cause?.message || '');
  const code = String(err?.code || '');
  const out = (kind, human, o = {}) => ({ kind, human, retryable: !!o.retryable, needsKey: !!o.needsKey, stop: !o.retryable });
  if (code === 'no_key' || /no api key/i.test(msg)) {
    return out('no_key', `You have not pasted a key for ${who} yet. ${KEYCARD}`, { needsKey: true });
  }
  if (/FreeTierError|free tier can only be used from within OpenCode/i.test(msg)) {
    return out('access', 'OpenCode rejected this free-tier request with an OpenCode app-only restriction. The key may still be valid. Check whether your account uses Go or Zen, then choose an allowed model or provider.');
  }
  if (status === 401 || /invalid or missing api key|invalid api key|unauthorized|incorrect api key|key (was )?(revoked|deleted|expired|invalid)|wrong api key/i.test(msg)) {
    return out('auth', `${who} rejected the API key - it is wrong, deleted, or from another account. ${KEYCARD}`, { needsKey: true });
  }
  if (status === 403) return out('access', `${who} denied access to this model or API. Check the provider's access rules, or choose another available model.`);
  if (status === 402 || /insufficient balance|no credit|out of credit|not enough credit|payment required|billing/i.test(msg)) {
    return out('billing', `${who} says the account is out of credit. Top it up there, or pick another provider in the Providers card - everything else keeps working.`);
  }
  if (status === 404 || /unknown model|model .*(not found|does not exist|isn.?t available)|invalid model|no such model/i.test(msg)) {
    return out('model', `${who} does not know the model "${route.model || 'unknown'}". Pick one from the list next to the key in the Providers card.`);
  }
  if (BIG_RE.test(msg)) {
    return out('toobig', `This conversation is longer than ${who} can read at once. Start a new chat, or tell me to summarize it - a shorter thread fits again.`);
  }
  if (status === 429 || /rate ?limit|too many requests|quota/i.test(msg)) {
    return out('rate', `${who} is rate limiting us right now. MAJIN waits and retries on its own; if it never clears, lower the Model Chain width in the Providers card.`, { retryable: true });
  }
  /* s08 (real-world audit 2026-10-20): lokal + timeout ≠ onåbar. Den installerade
     appen rapporterade "check that this machine has internet" för en lokal
     ollama som svarat 6 ms tidigare — bara för att första svaret var långsamt. */
  const localLane = (() => {
    const u = String(route.endpoint || route.baseUrl || '');
    return /(\/\/)(localhost|127(\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0)[:/]/i.test(u) || /^(ollama|lmstudio)/i.test(raw);
  })();
  if (localLane && /timeout|timed? ?out|aborted|abort/i.test(msg + ' ' + cause + ' ' + code)) {
    return out('slow', `${who} is answering but the reply took too long. The model is probably still loading — a first reply on CPU can take several minutes. This is NOT an internet problem. Try again in a moment; MAJIN keeps your settings.`, { retryable: true });
  }
  if (NET_RE.test(msg) || NET_RE.test(cause)) {
    return out('unreachable', `I cannot reach ${who}. Check that this machine has internet - or fix the address in the Providers card if you run your own server.`, { retryable: true });
  }
  if (status >= 500) {
    return out('upstream', `${who} is having trouble (HTTP ${status}). I will try again in a moment - if it keeps happening, press test in the Providers card.`, { retryable: true });
  }
  return out('provider', '', { retryable: Boolean(err?.retryable) });
}

const JOBCAT = (job) => (typeof job === 'string' ? (/(?:^|:)chat$/.test(job) ? 'interactive' : (/research|background|scheduler/.test(job) ? 'background' : 'tasks')) : 'tasks');
const quotaGet = (r) => r?.quota || null;

export async function complete(o) {
  const { route, messages, tools = [], onEvent, signal, maxTokens, temperature, job } = o;
  const max = maxTokens ?? route.maxTokens ?? 4096;
  const temp = temperature ?? route.temperature ?? 0.2;
  const retries = o.retries ?? 2;
  let attempt = 0;
  const started = Date.now();
  for (;;) {
    attempt += 1;
    /* V4 §7 admission: configured quota → queue+reserve; none → instant pass. */
    const release = await admit({ route, quotaGet, estIn: estimateInputTokens(messages), estOut: max, job: JOBCAT(job), signal });
    try {
      const res = await dispatch({ ...o, maxTokens: max, temperature: temp });
      res.elapsedMs = Date.now() - started;
      res.attempts = attempt;
      res.job = job;
      if (res.usage) {
        res.usage.costUsd = costOf(route, res.usage);
        record(route, res.usage, quotaGet);
      }
      release();
      return res;
    } catch (err) {
      release();
      const info = explainError(err, route);
      err.majin = info;
      const cls = classify(err);
      if (cls.cls === 'rate_limit') noteViolation(route, quotaGet);
      if (info.stop || attempt > retries || signal?.aborted) throw err;
      const ra = retryAfterMs(err);
      const backoff = Math.max(ra, Math.min(15000, 800 * 2 ** (attempt - 1)) + Math.random() * 400);
      bus.warn('provider.retry', { job, provider: route.providerName, attempt, backoff: Math.round(backoff), retryAfterMs: ra, cls: cls.cls, error: err.message });
      await sleep(backoff, signal);
      if (signal?.aborted) throw err;
    }
  }
}

async function dispatch(o) {
  const { route } = o;
  if (route.kind === 'mock') return mockComplete(o);
  if (!route.apiKey) {
    throw new ProviderError(`No API key for "${route.providerName}"`, {
      code: 'no_key',
      hint: KEYCARD,
    });
  }
  if (route.kind === 'anthropic') return o.stream ? anthropicStream(o) : anthropicOnce(o);
  if (route.kind === 'responses') return o.stream ? responsesStream(o) : responsesOnce(o);
  return o.stream ? openaiStream(o) : openaiOnce(o);
}

export function costOf(route, usage) {
  const p = route.pricing;
  if (!p) return 0;
  return ((usage.input || 0) / 1e6) * (p.in || 0) + ((usage.output || 0) / 1e6) * (p.out || 0);
}

export function sleep(ms, signal) {
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener?.('abort', () => (clearTimeout(t), res()), { once: true });
  });
}

export { openaiStream, openaiOnce };
