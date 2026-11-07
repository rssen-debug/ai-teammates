/**
 * A scripted OpenAI-compatible provider for end-to-end tests.
 *
 * Why this exists: unit tests can stub `model.chat`. That proves the agent's
 * bookkeeping, not the chain that actually runs on the owner's machine. This
 * server speaks the real dialect — SSE chunks, incremental tool calls,
 * `[DONE]` — so the test exercises V4's real transport, the real tool runner,
 * the real registry and the real filesystem underneath it.
 *
 * A step is either an object or a function `(request, index) => step`:
 *
 *   { text: '…' }                                  plain answer
 *   { toolCalls: [{ name, args, id }] }            one or more tool calls
 *   { text: '…', toolCalls: […] }                  both
 *   { httpStatus: 401, error: '…' }                an upstream failure
 *
 * Every request body is recorded in `requests` so a test can assert exactly
 * which tools the model was offered at each round.
 */
import http from 'node:http';

function sse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export async function startFakeProvider(steps, { onRequest = null } = {}) {
  const requests = [];
  const list = Array.isArray(steps) ? steps : [steps];

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      body = { __unparsable: raw.slice(0, 200) };
    }
    const index = requests.length;
    requests.push(body);
    let resolved;
    try {
      const step = typeof steps === 'function'
        ? steps(body, index)
        : list[Math.min(index, list.length - 1)];
      resolved = typeof step === 'function' ? step(body, index) : step;
      if (onRequest) onRequest(body, index, resolved);
    } catch (err) {
      // An assertion inside a script would otherwise leave the HTTP client
      // waiting forever, and the failure would surface as a timeout instead of
      // the real message. Answer with the error as text so the turn fails fast.
      resolved = { text: `FAKE_PROVIDER_ERROR: ${String(err?.message || err)}` };
    }

    if (resolved?.httpStatus) {
      res.writeHead(resolved.httpStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: resolved.error || 'scripted failure' } }));
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    if (resolved?.text) sse(res, { choices: [{ delta: { content: resolved.text } }] });
    (resolved?.toolCalls || []).forEach((call, i) => {
      sse(res, {
        choices: [{
          delta: {
            tool_calls: [{
              index: i,
              id: call.id || `call_${index}_${i}`,
              type: 'function',
              function: {
                name: call.name,
                arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {}),
              },
            }],
          },
        }],
      });
    });
    sse(res, {
      choices: [{
        delta: {},
        finish_reason: resolved?.toolCalls?.length ? 'tool_calls' : 'stop',
      }],
      ...(resolved?.usage ? { usage: resolved.usage } : {}),
    });
    res.write('data: [DONE]\n\n');
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  return {
    url,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Read the last `role: tool` message in a recorded request. */
export function lastToolMessage(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'tool') {
      try {
        return JSON.parse(messages[i].content);
      } catch {
        return { raw: messages[i].content };
      }
    }
  }
  return null;
}

/** Names of the tools offered in a recorded request. */
export function offeredTools(body) {
  return (body?.tools || []).map((t) => t?.function?.name).filter(Boolean);
}

/** The last user message, for scripted branching. */
export function lastUserMessage(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return String(messages[i].content || '');
  }
  return '';
}
