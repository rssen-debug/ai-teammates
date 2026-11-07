/**
 * MAJIN V4 — client session model.
 *
 * The browser's conversation state, extracted from the DOM so it can be tested
 * without a browser. This exists because the UI once dropped the conversation id
 * returned by the server, which silently started a new conversation on every
 * message. That class of bug is invisible in server tests and obvious here.
 *
 * Pure: no fetch, no DOM, no timers. `apply(event, data)` returns a list of
 * intents the view should perform (append text, show a tool card, speak, ...).
 */

export const INITIAL = Object.freeze({
  conversationId: null,
  turnId: null,
  lastSeq: 0,
  reconnects: 0,
  goalId: null,
  streaming: false,
  status: 'idle',
  text: '',
  tools: [],
  messages: [],
  pendingApproval: null,
  error: null,
  demo: null,
  model: null,
});

function clone(state) {
  return {
    ...state,
    tools: state.tools.map((t) => ({ ...t })),
    messages: state.messages.slice(),
  };
}

/**
 * Fold one server-sent event into the session.
 *
 * @param {object} state
 * @param {string} event  SSE event name
 * @param {object} data   parsed payload
 * @returns {{state: object, intents: Array<object>}}
 */
export function applyEvent(state, event, data) {
  const s = clone(state);
  const intents = [];

  switch (event) {
    case 'open':
      if (data?.model) {
        s.model = data.model;
        s.demo = Boolean(data.model.demo);
      }
      // Remember the turn so a dropped connection can reattach to the same work.
      if (data?.turnId) {
        s.turnId = data.turnId;
        s.lastSeq = 0;
      }
      break;

    case 'user':
      s.status = 'thinking';
      s.streaming = true;
      s.text = '';
      s.error = null;
      break;

    case 'state':
      if (data?.state === 'thinking') s.status = 'thinking';
      else if (data?.state === 'working') s.status = 'working';
      else if (data?.state === 'verifying') s.status = 'verifying';
      break;

    case 'delta':
      s.status = 'speaking';
      s.text += String(data?.text ?? '');
      intents.push({ type: 'append_text', text: String(data?.text ?? '') });
      break;

    case 'tool_start': {
      const tool = {
        id: data?.id || data?.name,
        name: data?.name || 'tool',
        state: 'running',
        summary: data?.input?.fileName || '',
      };
      s.tools.push(tool);
      s.status = 'working';
      intents.push({ type: 'tool_start', tool });
      break;
    }

    case 'tool_result': {
      const id = data?.id || data?.name;
      const tool = [...s.tools].reverse().find((t) => t.id === id || t.name === data?.name);
      if (tool) {
        tool.state = data?.ok ? (data.verified ? 'verified' : 'ok') : 'failed';
        tool.summary = data?.summary || '';
        tool.receiptId = data?.receiptId || null;
      }
      intents.push({ type: 'tool_result', id, ok: Boolean(data?.ok), verified: Boolean(data?.verified) });
      break;
    }

    case 'goal':
      if (data?.id) s.goalId = data.id;
      intents.push({ type: 'goal', goal: data });
      break;

    case 'approval_required':
      s.pendingApproval = { tool: data?.tool || 'tool', reason: data?.reason || '' };
      s.status = 'awaiting_approval';
      intents.push({ type: 'approval_required', approval: s.pendingApproval });
      break;

    case 'replay':
      if (data?.content) {
        s.text = String(data.content);
        intents.push({ type: 'append_text', text: String(data.content), replay: true });
      } else if (data?.truncated) {
        intents.push({ type: 'replay_truncated' });
      }
      if (data?.conversationId) s.conversationId = data.conversationId;
      break;

    case 'error':
      s.error = data?.message || 'error';
      s.status = 'failed';
      intents.push({ type: 'error', message: s.error });
      break;

    case 'cancelled':
      s.status = 'cancelled';
      intents.push({ type: 'cancelled' });
      break;

    case 'done': {
      // The server is the authority on which conversation this turn belongs to.
      if (data?.conversationId) s.conversationId = data.conversationId;
      if (data?.goalId) s.goalId = data.goalId;
      s.streaming = false;
      s.status = data?.status || 'completed';
      if (data?.status === 'awaiting_approval') s.status = 'awaiting_approval';
      if (data?.status === 'completed' || data?.status === 'replayed') {
        s.messages.push({ role: 'assistant', content: s.text });
      }
      intents.push({ type: 'done', status: s.status, conversationId: s.conversationId, goalId: s.goalId });
      s.text = '';
      break;
    }

    case 'resume_result':
      s.status = data?.status === 'completed' ? 'completed' : 'blocked';
      intents.push({ type: 'resume_result', status: s.status, missing: data?.missing || [] });
      break;

    default:
      break;
  }

  return { state: s, intents };
}

/** Fold a whole SSE transcript. Useful in tests and for replaying a log. */
export function applyAll(state, events) {
  let current = state;
  const all = [];
  for (const { event, data } of events) {
    const result = applyEvent(current, event, data);
    current = result.state;
    all.push(...result.intents);
  }
  return { state: current, intents: all };
}

/**
 * Split an SSE byte stream into events. Kept separate from the view so the
 * parsing rules (multi-line data, comments, CRLF) are tested directly.
 */
export function createSseParser() {
  let buffer = '';
  return {
    push(chunk) {
      // Normalise line endings up front: a proxy or an older server may emit
      // CRLF, and a parser that only looks for "\n\n" would stall forever.
      buffer += String(chunk).replace(/\r\n?/g, '\n');
      const out = [];
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const parsed = parseBlock(raw);
        if (parsed) out.push(parsed);
      }
      return out;
    },
    get pending() {
      return buffer;
    },
  };
}

export function parseBlock(raw) {
  let event = 'message';
  let seq = 0;
  const dataLines = [];
  for (const line of String(raw).replace(/\r/g, '').split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('id:')) seq = Number(line.slice(3).trim()) || 0;
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  try {
    return { event, seq, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return null;
  }
}
