/**
 * MAJIN — OpenAI-compatible transport (works with DeepSeek, OpenRouter, Groq,
 * OpenAI, Ollama, LM Studio, vLLM, llama.cpp server, Nous, Together, xAI…).
 * Handles SSE streaming and incremental tool_call assembly.
 */
import { ProviderError } from './chat.js';
import { bus } from '../log.js';

const TIMEOUT_MS = Number(process.env.MAJIN_LLM_TIMEOUT || 180000);
/* s08 (real-world audit 2026-10-20): a LOCAL model's first completion can take
   minutes while it loads on CPU. 180 s is right for gateways, wrong for
   ollama/lmstudio on the same machine — and a local timeout must never be
   reported as "check your internet". Local endpoints get a generous default. */
const TIMEOUT_LOCAL_MS = Number(process.env.MAJIN_LLM_LOCAL_TIMEOUT || 600000);
export function isLocalRoute(route = {}) {
  try {
    const u = new URL(route.endpoint || route.baseUrl || 'http://x.invalid');
    return /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0)$/.test(u.hostname);
  } catch { return false; }
}

function headersFor(route) {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${route.apiKey}`,
    ...(route.extraHeaders || {}),
  };
}

/* Some OpenAI-compatible gateways return tool-call `arguments` as an already
   parsed object instead of a JSON string. Normalize at ingestion so every
   downstream consumer (argument parsing, checkpoint history, and the next
   request, where strict gateways reject non-string arguments) always sees a
   JSON string. Without this, JSON.parse receives "[object Object]" and a
   perfectly valid tool call fails as INVALID_TOOL_CALL. */
export function argsToJsonString(value) {
  if (typeof value === 'string') return value || '{}';
  if (value == null) return '{}';
  try { return JSON.stringify(value); } catch { return '{}'; }
}

function mapToolCalls(msg) {
  const calls = (msg.tool_calls || []).map((tc) => ({
    id: tc.id || `call_${Math.random().toString(36).slice(2, 8)}`,
    name: tc.function?.name || tc.name,
    argsJson: argsToJsonString(tc.function?.arguments ?? tc.arguments),
  }));
  // Legacy single function_call dialect still emitted by some endpoints.
  if (!calls.length && msg.function_call?.name) {
    calls.push({
      id: `call_${Math.random().toString(36).slice(2, 8)}`,
      name: msg.function_call.name,
      argsJson: argsToJsonString(msg.function_call.arguments),
    });
  }
  return calls;
}

export function buildMessages(route, messages) {
  const out = [];
  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.tool_call_id, ...(m.name ? { name: m.name } : {}), content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      out.push({
        role: 'assistant',
        content: m.content ? String(m.content) : null,
        ...(/deepseek/i.test(route.model || '') && m.reasoning_content ? { reasoning_content: String(m.reasoning_content) } : {}),
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name || tc.function?.name, arguments: argsToJsonString(tc.function?.arguments ?? tc.argsJson ?? tc.args) },
        })),
      });
      continue;
    }
    if (Array.isArray(m.content)) {
      const parts = m.content.filter((p) => p && (p.type === 'image_url' || p.type === 'text'));
      out.push({ role: m.role, content: parts.length ? parts : contentToText(m.content) });
      continue;
    }
    out.push({ role: m.role, content: contentToText(m.content) });
  }
  return out;
}

function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part.type === 'text') return part.text;
        if (part.type === 'image_url') return `[image ${String(part.image_url?.url || '').slice(0, 24)}…]`;
        return part.text || '';
      })
      .join('\n');
  }
  return String(content);
}

function body(route, { messages, tools, maxTokens, temperature, stream, toolChoice, extra }) {
  const normalizedMessages = buildMessages(route, messages || []);
  // Never issue a doomed upstream request with an empty messages array.
  // The UI receives a precise local error instead of a cryptic gateway 400.
  if (!normalizedMessages.length || !normalizedMessages.some((m) =>
    (m.role === 'user' || m.role === 'system' || m.role === 'developer') &&
    (typeof m.content === 'string' ? m.content.trim() : Array.isArray(m.content) && m.content.length)
  )) {
    throw new ProviderError('No user or system message reached the model. Your message is saved; retry the turn or start a new chat.', {
      status: 0, code: 'empty_messages', retryable: false,
      hint: 'The model request was blocked locally before contacting the provider.',
    });
  }
  const b = {
    model: route.model,
    messages: normalizedMessages,
    stream: Boolean(stream),
    max_tokens: maxTokens,
    temperature,
  };
  if (b.stream) b.stream_options = { include_usage: true };
  if (tools?.length) {
    b.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    b.tool_choice = toolChoice ?? 'auto';
  }
  return { ...b, ...(extra || {}) };
}

/**
 * Scope the provider deadline to the ENTIRE response (headers + JSON/SSE body).
 * Prior send() cleared its timeout immediately after fetch() returned headers,
 * so a stalled Ollama stream could hang a turn despite agent.stop().
 */
async function withResponse(route, payload, { signal } = {}, consume) {
  const ctrl = new AbortController();
  const local = isLocalRoute(route);
  const maxMs = local ? TIMEOUT_LOCAL_MS : TIMEOUT_MS;
  const timeout = setTimeout(() => ctrl.abort(new Error('model response deadline exceeded')), maxMs);
  // Keep the timer referenced while a response body is still pending.
  const onAbort = () => ctrl.abort(signal.reason || new Error('aborted'));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    const res = await fetch(route.endpoint || route.baseUrl, {
      method: 'POST', headers: headersFor(route), body: JSON.stringify(payload), signal: ctrl.signal,
    });
    return await consume(res);
  } catch (err) {
    if (ctrl.signal.aborted && !signal?.aborted) {
      throw new ProviderError((local ? 'Local model' : 'Model') + ' timed out before finishing its response (' + maxMs + ' ms)', {
        status: 0, code: 'model_timeout', retryable: false,
        hint: local
          ? 'The local inference endpoint stalled. Check Ollama/model CPU load or raise MAJIN_LLM_LOCAL_TIMEOUT.'
          : 'The model endpoint stalled. Check the provider or raise MAJIN_LLM_TIMEOUT.',
      });
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

async function fail(res) {
  const text = await res.text().catch(() => '');
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* html error page */
  }
  const msg = parsed?.error?.message || parsed?.message || text.slice(0, 400) || `HTTP ${res.status}`;
  throw new ProviderError(`${res.status}: ${msg}`, {
    status: res.status,
    code: parsed?.error?.code || `http_${res.status}`,
    retryable: res.status === 429 || res.status >= 500,
    hint: res.status === 401 ? 'Wrong or deleted API key.' : res.status === 402
          ? 'the account is out of credit — add credit at the provider, or pick another provider in the Providers card'
          : res.status === 429 ? 'Rate limited — MAJIN backs off and retries.' : res.status === 404 ? 'wrong baseUrl or model name.' : null,
  });
}

export async function openaiOnce(o) {
  const { route, tools = [], messages, signal, maxTokens, temperature, onEvent } = o;
  return withResponse(route, body(route, { messages, tools, maxTokens, temperature, stream: false, extra: o.extra }), { signal }, async (res) => {
  if (!res.ok) await fail(res);
  const json = await res.json();
  const choice = json.choices?.[0];
  const msg = choice?.message || {};
  const toolCalls = mapToolCalls(msg);
  onEvent?.({ type: 'delta', text: msg.content || '' });
  for (const call of toolCalls) if (call.name) onEvent?.({ type: 'tool', name: call.name });
  return {
    text: msg.content || '',
    reasoning: msg.reasoning_content || msg.reasoning || null,
    toolCalls,
    usage: usage(json.usage, msg.content, toolCalls),
    stopReason: choice?.finish_reason || 'stop',
    raw: { id: json.id, model: json.model },
  };
  });
}

async function* decodedStreamLines(body) {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of body) {
    buffered += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffered.indexOf('\n')) >= 0) {
      yield buffered.slice(0, end).trim();
      buffered = buffered.slice(end + 1);
    }
  }
  buffered += decoder.decode();
  if (buffered.trim()) yield buffered.trim();
}

export async function openaiStream(o) {
  const { route, tools = [], messages, signal, maxTokens, temperature, onEvent } = o;
  return withResponse(route, body(route, { messages, tools, maxTokens, temperature, stream: true, extra: o.extra }), { signal }, async (res) => {
  if (!res.ok) await fail(res);
  const ctype = String(res.headers.get('content-type') || '');
  if (res.ok && !/event-stream/i.test(ctype)) {
    /* Some gateways answer a stream:true request with plain JSON. Treat it as a
       normal completion instead of parsing nothing and answering empty. */
    const json = await res.json().catch(() => null);
    if (!json) await fail(res);
    const choice = json.choices?.[0] || {};
    const msg = choice.message || {};
    const toolCalls = mapToolCalls(msg);
    if (msg.content) onEvent?.({ type: 'delta', text: msg.content });
    for (const call of toolCalls) if (call.name) onEvent?.({ type: 'tool', name: call.name });
    return { text: msg.content || '', reasoning: msg.reasoning_content || msg.reasoning || null, toolCalls, usage: usage(json.usage, msg.content, toolCalls), stopReason: choice.finish_reason || 'stop', raw: { id: json.id, model: json.model }, fallback: 'json' };
  }
  let text = '';
  let reasoning = '';
  const calls = new Map();
  let finish = 'stop';
  let usageObj = null;
  for await (const line of decodedStreamLines(res.body)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let ev;
      try {
        ev = JSON.parse(data);
      } catch {
        throw new ProviderError('The provider sent malformed stream data; incomplete tool calls were discarded.', {
          code: 'invalid_stream_data', retryable: false,
        });
      }
      if (ev?.error) {
        // Do not echo upstream payloads: they can contain request data or secrets.
        throw new ProviderError('The provider reported a stream error; incomplete tool calls were discarded.', {
          code: 'provider_stream_error', retryable: false,
        });
      }
      if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
        throw new ProviderError('The provider sent an invalid stream event; incomplete tool calls were discarded.', {
          code: 'invalid_stream_data', retryable: false,
        });
      }
      if (ev.usage) usageObj = ev.usage;
      const choice = ev.choices?.[0];
      if (!choice) continue;
      const d = choice.delta || {};
      if (d.content) {
        text += d.content;
        onEvent?.({ type: 'delta', text: d.content });
      }
      if (d.reasoning_content || d.reasoning) {
        const r = d.reasoning_content || d.reasoning;
        reasoning += r;
        onEvent?.({ type: 'thinking', text: r });
      }
      for (const tc of d.tool_calls || []) {
        const key = tc.index ?? 0;
        const cur = calls.get(key) || { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += typeof tc.function.arguments === 'string' ? tc.function.arguments : argsToJsonString(tc.function.arguments);
        calls.set(key, cur);
        if (tc.function?.name && !cur.notified) {
          cur.notified = true;
          onEvent?.({ type: 'tool', name: cur.name });
        }
      }
      if (choice.finish_reason) finish = choice.finish_reason;
  }
  if (text.length > 6000) bus.warn('stream.truncated', { chars: text.length });
  const toolCalls = [...calls.values()].filter((c) => c.name).map((c) => ({ id: c.id || `call_${Math.random().toString(36).slice(2, 8)}`, name: c.name, argsJson: c.args || '{}' }));
  if (!text && !toolCalls.length && !reasoning) {
    bus.error('stream.empty', { endpoint: route.endpoint || route.baseUrl });
    throw new ProviderError(`${route.providerName || 'the provider'} sent an empty stream`, {
      status: 502,
      retryable: true,
      hint: 'the endpoint answered 200 but carried no text and no tool call — check the model id (a gateway needs vendor/model, e.g. kilocode/anthropic/claude-sonnet-4.5) or the baseUrl dialect',
    });
  }
  return {
    text,
    reasoning: reasoning || null,
    toolCalls,
    usage: usage(usageObj, text, toolCalls),
    stopReason: finish,
    raw: {},
  };
  });
}

function usage(u, text, toolCalls) {
  if (u)
    return {
      input: u.prompt_tokens ?? u.input ?? 0,
      output: u.completion_tokens ?? u.output ?? 0,
      cached: u.prompt_tokens_details?.cached_tokens || 0,
      reported: true,
      total: u.total_tokens ?? (u.prompt_tokens ?? u.input ?? 0) + (u.completion_tokens ?? u.output ?? 0),
    };
  const approx = Math.ceil((String(text).length + JSON.stringify(toolCalls || []).length) / 4);
  return { input: 0, output: approx, reported: false };
}
