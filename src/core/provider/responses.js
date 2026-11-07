/**
 * OpenAI Responses wire protocol for Go models (Grok / GPT / Muse).
 * MAJIN's conversation and tool contracts remain provider-neutral.
 * Never interpret a successful HTTP response with no text and no tools as success.
 */
import { ProviderError } from './chat.js';

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(p => typeof p === 'string' ? p : (p?.text || '')).join('\n');
  return String(content ?? '');
}

export function responsesInput(messages = []) {
  const result = [];
  for (const msg of messages) {
    if (!msg) continue;
    if (msg.role === 'tool') {
      result.push({ type: 'function_call_output', call_id: msg.tool_call_id, output: contentText(msg.content) });
    } else if (msg.role === 'assistant' && msg.tool_calls?.length) {
      if (msg.content) result.push({ role: 'assistant', content: contentText(msg.content) });
      for (const tool of msg.tool_calls) {
        result.push({
          type: 'function_call',
          call_id: tool.id,
          name: tool.name,
          arguments: tool.argsJson || tool.function?.arguments || (typeof tool.args === 'string' ? tool.args : JSON.stringify(tool.args || {})),
        });
      }
    } else if (['system','developer','user','assistant'].includes(msg.role)) {
      result.push({ role: msg.role, content: contentText(msg.content) });
    }
  }
  return result;
}

function payload(o, stream) {
  const input = responsesInput(o.messages);
  if (!input.some(m => ['user', 'system', 'developer'].includes(m.role) && m.content?.trim())) {
    throw new ProviderError('No user or system message reached the model', { code: 'empty_messages', retryable: false });
  }
  const body = {
    model: o.route.model,
    input,
    stream,
    max_output_tokens: o.maxTokens ?? 4096,
  };
  if (Number.isFinite(o.temperature) && !/^(gpt-[56](?:[.-]|$)|o[134](?:[.-]|$))/i.test(o.route.model || '')) body.temperature = o.temperature;
  if (o.tools?.length) {
    body.tools = o.tools.map(t => ({
      type: 'function', name: t.name, description: t.description,
      parameters: t.parameters || { type: 'object', properties: {} },
      strict: false,
    }));
    body.tool_choice = 'auto';
  }
  return body;
}

export function decodeResponses(json, onEvent) {
  const out = Array.isArray(json?.output) ? json.output : [];
  let text = '';
  const toolCalls = [];
  for (const item of out) {
    if (item.type === 'message') {
      text += (item.content || []).filter(p => p?.type === 'output_text').map(p => p.text || '').join('');
    } else if (item.type === 'function_call') {
      if (item.name && (item.call_id || item.id)) {
        toolCalls.push({ id: item.call_id || item.id, name: item.name, argsJson: item.arguments || '{}' });
      }
    }
  }
  if (!text && typeof json?.output_text === 'string') text = json.output_text;
  if (json?.status === 'failed' || json?.error) {
    throw new ProviderError(String(json?.error?.message || 'Responses API failed').slice(0, 300), { code: 'responses_failed' });
  }
  if (json?.status === 'incomplete') {
    throw new ProviderError('Responses API returned incomplete output; task not verified', { code: 'responses_incomplete' });
  }
  if (!text && !toolCalls.length) {
    throw new ProviderError('Responses API returned no assistant text or tool call', { code: 'empty_response', retryable: true });
  }
  if (text) onEvent?.({ type: 'delta', text });
  for (const call of toolCalls) onEvent?.({ type: 'tool', name: call.name });
  const usage = json?.usage || {};
  return {
    text, reasoning: null, toolCalls,
    usage: { input: usage.input_tokens || 0, output: usage.output_tokens || 0, reported: Boolean(json?.usage) },
    stopReason: toolCalls.length ? 'tool_calls' : 'stop',
    raw: { id: json?.id || null, model: json?.model || null },
  };
}

async function request(o, stream, consume) {
  const ctrl = new AbortController();
  const maxMs = Number(process.env.MAJIN_LLM_TIMEOUT || 180000);
  const deadline = setTimeout(() => ctrl.abort(new Error('model response deadline exceeded')), maxMs);
  const abort = () => ctrl.abort(o.signal?.reason || new Error('aborted'));
  if (o.signal?.aborted) abort();
  else o.signal?.addEventListener?.('abort', abort, { once: true });
  try {
    const response = await fetch(o.route.endpoint || String(o.route.baseUrl).replace(/\/+$/, '') + '/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: stream ? 'text/event-stream' : 'application/json',
        authorization: 'Bearer ' + o.route.apiKey,
        ...(o.route.extraHeaders || {}),
      },
      body: JSON.stringify(payload(o, stream)),
      signal: ctrl.signal,
    });
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      let msg = raw.slice(0, 300);
      try { msg = JSON.parse(raw)?.error?.message || msg; } catch {}
      throw new ProviderError(String(response.status) + ': ' + msg, {
        status: response.status, retryable: response.status === 429 || response.status >= 500,
      });
    }
    return await consume(response);
  } catch (e) {
    if (ctrl.signal.aborted && !o.signal?.aborted) {
      throw new ProviderError('Responses model response timed out', { code: 'model_timeout' });
    }
    throw e;
  } finally {
    clearTimeout(deadline);
    o.signal?.removeEventListener?.('abort', abort);
  }
}

export async function responsesOnce(o) {
  return request(o, false, async res => decodeResponses(await res.json(), o.onEvent));
}

export async function responsesStream(o) {
  return request(o, true, async res => {
    if (!/event-stream/i.test(res.headers.get('content-type') || '')) {
      return decodeResponses(await res.json(), o.onEvent);
    }
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let terminal = null;
    const partialCalls = new Map();
    const notifiedTools = new Set();
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let pos;
      while ((pos = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, pos).trim();
        buffer = buffer.slice(pos + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(data); } catch { continue; }
        if (ev.type === 'response.output_text.delta') {
          text += ev.delta || '';
          o.onEvent?.({ type: 'delta', text: ev.delta || '' });
        }
        if (ev.type === 'response.output_item.added' && ev.item?.type === 'function_call') {
          const key = ev.output_index ?? ev.item.id ?? ev.item.call_id;
          partialCalls.set(key, { id: ev.item.call_id || ev.item.id, name: ev.item.name, argsJson: ev.item.arguments || '' });
          if (ev.item.name && !notifiedTools.has(ev.item.name)) {
            notifiedTools.add(ev.item.name);
            o.onEvent?.({ type: 'tool', name: ev.item.name });
          }
        }
        if (ev.type === 'response.function_call_arguments.delta') {
          const key = ev.output_index ?? ev.item_id;
          const call = partialCalls.get(key);
          if (call) call.argsJson += ev.delta || '';
        }
        if (ev.type === 'response.output_item.done' && ev.item?.type === 'function_call') {
          const key = ev.output_index ?? ev.item.id ?? ev.item.call_id;
          partialCalls.set(key, { id: ev.item.call_id || ev.item.id, name: ev.item.name, argsJson: ev.item.arguments || '{}' });
        }
        if (ev.type === 'response.failed' || ev.type === 'error') {
          throw new ProviderError(String(ev.response?.error?.message || ev.message || 'Responses stream failed').slice(0, 250), { code: 'responses_failed' });
        }
        if (ev.type === 'response.completed') terminal = ev.response;
      }
    }
    if (terminal) {
      // Use final canonical output instead of partial deltas for tools, but
      // do not replay text or tool-start events that were already streamed.
      return decodeResponses(terminal, (event) => {
        if (event.type === 'delta' && text) return;
        if (event.type === 'tool') {
          if (notifiedTools.has(event.name)) return;
          notifiedTools.add(event.name);
        }
        o.onEvent?.(event);
      });
    }
    const toolCalls = [...partialCalls.values()].filter(c => c.name && c.id).map(c => ({ ...c, argsJson: c.argsJson || '{}' }));
    if (!text && !toolCalls.length) throw new ProviderError('Responses stream ended without a completion', { code: 'empty_response', retryable: true });
    return { text, reasoning: null, toolCalls,
      usage: { input: 0, output: 0, reported: false },
      stopReason: toolCalls.length ? 'tool_calls' : 'stop', raw: {} };
  });
}
