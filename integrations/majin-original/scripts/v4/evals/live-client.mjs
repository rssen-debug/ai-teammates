// Reusable acceptance client. Planning/tool choice stays in the real MAJIN host.
import { randomUUID } from 'node:crypto';
import { createSseParser } from '../../../src/v4/ui/session.js';

export function evaluationClient({ base, cookie, signal = AbortSignal.timeout(240000) }) {
  const origin = new URL(base);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(origin.hostname)))) throw Error('Evaluation host must be HTTPS or loopback HTTP without embedded credentials');
  if (typeof cookie !== 'string' || !cookie.trim() || /[\r\n]/.test(cookie)) throw Error('An existing paired cookie is required; never put it in arguments or evidence');
  async function request(route, body) {
    const response = await fetch(origin.origin + route, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal,
      headers: { cookie, origin: origin.origin, ...(body ? { 'content-type': 'application/json', 'x-majin-csrf': '1' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw Error(`Host ${route}: HTTP ${response.status}`);
    return response;
  }
  return {
    get: async (route) => (await request(route)).json(),
    async stop(conversationId, { rejectPending = false } = {}) {
      const response = await fetch(origin.origin + (rejectPending ? '/api/approve' : '/api/cancel'), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { cookie, origin: origin.origin, 'content-type': 'application/json', 'x-majin-csrf': '1' },
        body: JSON.stringify({ conversationId, ...(rejectPending ? { approve: false } : {}) }),
      });
      await response.arrayBuffer();
      return response.ok;
    },
    async run({ task, conversationId, approve = async () => undefined, onEvent = () => {}, maxApprovals = 24 }) {
      let response = await request('/api/chat', { text: task, requestId: `genesis-eval-${randomUUID()}`, ...(conversationId ? { conversationId } : {}) });
      const events = []; let approvals = 0, totalBytes = 0;
      for (;;) {
        if (!response.headers.get('content-type')?.startsWith('text/event-stream')) throw Error('Host returned no event stream');
        const reader = response.body.getReader(), parser = createSseParser(), decoder = new TextDecoder();
        let pending, done;
        try {
          for (;;) {
            const chunk = await reader.read(); if (chunk.done) break;
            signal.throwIfAborted(); totalBytes += chunk.value.byteLength;
            if (totalBytes > 16 * 1024 * 1024) throw Error('Evaluation stream exceeded its byte budget');
            for (const event of parser.push(decoder.decode(chunk.value, { stream: true }))) {
              events.push(event);
              if (events.length > 4000) throw Error('Evaluation stream exceeded its event budget');
              if (event.event === 'approval_required') pending = event.data;
              if (event.event === 'done') done = event.data;
              onEvent(event);
            }
          }
          if (parser.pending.trim()) throw Error('Truncated host event stream');
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        if (!done) throw Error('Host stream ended without a completion state');
        conversationId = done.conversationId || conversationId;
        if (done.status !== 'awaiting_approval') return { ...done, events, approvals };
        if (!pending || !conversationId) throw Error('Approval lacks a task handle');
        const decision = await approve({ ...pending, conversationId });
        if (decision === undefined) return { ...done, events, approvals, blocked: 'Owner approval required for an action outside this evaluation scope.' };
        if (typeof decision !== 'boolean' || ++approvals > maxApprovals) throw Error('Evaluation approval budget exhausted');
        response = await request('/api/approve', { conversationId, approve: decision });
      }
    },
  };
}
