/**
 * MAJIN — mock provider.
 * Lets the whole agent loop run with zero keys: deterministic, offline, used by
 * the test suite and by first-run "copy this demo" mode in the UI.
 */
import { bus } from '../log.js';

const scripts = new Map();
const calls = [];

/* test/verify-krok: vad skulle ha skickats pa traden, exakt */
export function lastCalls() {
  return calls.map((c) => ({ ...c }));
}
export function resetCalls() {
  calls.length = 0;
}

export function setScript(session, steps) {
  scripts.set(session, [...steps]);
}

export async function mockComplete(o) {
  const { messages = [], onEvent, job } = o;
  const key = o.mockKey || job || 'default';
  calls.push({ key, messages: messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })) });
  const scripted = scripts.get(key);
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const q = textOf(last?.content);
  if (scripted?.length) {
    const step = scripted.shift();
    if (step.throw) throw new Error(String(step.throw)); /* Del 3C: scripted transient flakes */
    return emit(o, step);
  }
  if (job === 'router') return emit(o, { text: 'code' });
  if (job === 'moa') return emit(o, { text: `MOA answer on "${q.slice(0, 40)}"` });
  if (o.tools?.length && !messages.some((m) => m.role === 'tool')) {
    return emit(o, {
      text: 'Checking the situation first.',
      toolCalls: [{ id: 'call_mock1', name: o.tools[0].name, argsJson: '{}' }],
      stopReason: 'tool_calls',
    });
  }
  return emit(o, {
    text: `I am in demo mode, so nothing real has happened yet - there is no model behind me.\n\nOpen the Providers card on the right, pick your provider, paste the key and press save. After that I can touch files, the terminal, the browser and your messages.\n\nYou wrote: "${(q || 'nothing').slice(0, 200)}"`,
  });
}

function textOf(c) {
  if (!c) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p.text || '')).join(' ');
  return String(c);
}

async function emit(o, step) {
  const text = step.text ?? '';
  for (const chunk of splitWords(text)) {
    o.onEvent?.({ type: 'delta', text: chunk });
    await sleep(4);
  }
  const toolCalls = (step.toolCalls || []).map((tc, i) => ({ id: tc.id || `call_m${i}`, name: tc.name, argsJson: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {}) }));
  if (toolCalls.length) for (const tc of toolCalls) o.onEvent?.({ type: 'tool', name: tc.name });
  bus.debug('mock.reply', { job: o.job, chars: text.length, tools: toolCalls.length });
  return {
    text,
    reasoning: step.reasoning || null,
    toolCalls,
    usage: { input: Math.ceil(JSON.stringify(o.messages || '').length / 4), output: Math.ceil(text.length / 4), reported: false },
    stopReason: toolCalls.length ? 'tool_calls' : 'stop',
    raw: { mock: true },
  };
}

function splitWords(t) {
  const out = [];
  let cur = '';
  for (const w of String(t).split(/(?<=\s)/)) {
    cur += w;
    if (cur.length > 12) {
      out.push(cur);
      cur = '';
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
