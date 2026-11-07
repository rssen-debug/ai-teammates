/**
 * V2 model provider adapter (master brief sections 59-60 + error contracts).
 *
 * Zero-dependency OpenAI-compatible chat adapter over fetch. Covers opencode
 * serve, OpenAI itself, and any compatible endpoint. EVERY failure is mapped
 * to the kernel failure-class vocabulary — the scheduler never sees a raw
 * network string. Responses are receipts, not promises.
 */
import { z } from 'zod';

export class ModelError extends Error {
  constructor(cls, message, meta = {}) { super(message); this.name = 'ModelError'; this.cls = cls; this.meta = meta; }
}

export const ChatMessage = z.object({ role: z.enum(['system', 'user', 'assistant', 'tool']), content: z.string() });

export class OpenAICompatibleProvider {
  constructor({ name, baseUrl, apiKey = null, model, timeoutMs = 60_000, extraHeaders = null } = {}) {
    if (!baseUrl) throw new Error('provider requires baseUrl');
    if (!model) throw new Error('provider requires model');
    this.name = name || baseUrl;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
    // gateway-required routing headers (e.g. opencode Go refuses without
    // x-opencode-session — live-proven fact carried from V1 presets)
    this.extraHeaders = extraHeaders;
  }

  /** chat(messages, {responseFormat, timeoutMs}) -> {text, usage, model, requestId, elapsedMs} */
  async chat(messages, { responseFormat = null, timeoutMs = null } = {}) {
    const body = { model: this.model, messages: messages.map((m) => ChatMessage.parse(m)) };
    if (responseFormat) body.response_format = responseFormat;
    const t0 = Date.now();
    const limit = timeoutMs ?? this.timeoutMs;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), limit);
    let res;
    // URL-safe join preserving query strings (mock routes are keyed by ?mode=)
    const url = new URL(this.baseUrl);
    url.pathname = `${url.pathname.replace(/\/$/, '')}/chat/completions`;
    try {
      res = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          ...(this.extraHeaders || {}),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      const aborted = err.name === 'AbortError' || /timeout|aborted/i.test(String(err.message));
      throw new ModelError(aborted ? 'TIMEOUT' : 'NETWORK_FAILURE', aborted ? `provider timed out after ${limit}ms` : `network: ${err.message}`, { provider: this.name });
    } finally { clearTimeout(timer); }

    if (res.status === 401 || res.status === 403) throw new ModelError('AUTH_REQUIRED', `provider auth failed (${res.status})`, { provider: this.name });
    if (res.status === 429) throw new ModelError('MODEL_RATE_LIMIT', `rate limited (${res.status})`, { provider: this.name });
    if (res.status >= 500) throw new ModelError('MODEL_FAILURE', `provider 5xx (${res.status})`, { provider: this.name });
    if (!res.ok) throw new ModelError('MODEL_FAILURE', `provider error ${res.status}`, { provider: this.name });

    let json;
    try { json = await res.json(); } catch (err) { throw new ModelError('INVALID_TOOL_OUTPUT', `non-JSON response body: ${err.message}`, { provider: this.name }); }
    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new ModelError('INVALID_TOOL_OUTPUT', 'response lacks choices[0].message.content', { provider: this.name });
    return {
      text,
      usage: json.usage || null,
      model: json.model || this.model,
      requestId: json.id || null,
      elapsedMs: Date.now() - t0,
      provider: this.name,
    };
  }
}

/**
 * chatValidated(provider, messages, {schema}) — the discipline of §4.2 in one
 * helper: model output parses AND matches the zod schema or it is classified
 * INVALID_TOOL_OUTPUT. There is no repair-then-trust path.
 */
export async function chatValidated(provider, messages, { schema, ...opts } = {}) {
  const res = await provider.chat(messages, { responseFormat: schema ? { type: 'json_object' } : null, ...opts });
  if (!schema) return { ...res, value: res.text };
  let parsed;
  try { parsed = JSON.parse(res.text); } catch (err) {
    throw new ModelError('INVALID_TOOL_OUTPUT', `model output not JSON: ${err.message}`, { provider: provider.name });
  }
  const v = schema.safeParse(parsed);
  if (!v.success) throw new ModelError('INVALID_TOOL_OUTPUT', 'model output failed schema validation', { provider: provider.name, issues: v.error.issues.length });
  return { ...res, value: v.data };
}
