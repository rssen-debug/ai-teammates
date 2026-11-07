/**
 * V2 model runtime contracts: every provider failure class lands in the kernel
 * vocabulary (TIMEOUT, AUTH_REQUIRED, MODEL_RATE_LIMIT, MODEL_FAILURE,
 * NETWORK_FAILURE, INVALID_TOOL_OUTPUT) and validated output never trusts a
 * model that fails its schema. Exercised against an in-process mock server —
 * NOT against a real vendor key, so CI never depends on secrets/network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { z } from 'zod';
import { OpenAICompatibleProvider, ModelError, chatValidated } from '../src/v2/model/provider.js';

function mockServer(routes) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        const u = new URL(req.url, 'http://x');
        const route = routes[u.searchParams.get('mode') || 'ok'];
        if (route) {
          const out = await route({ body: body ? JSON.parse(body) : {} });
          if (out === null) return; // route hijacked the socket (timeout lanes)
          res.writeHead(out.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(out.json));
        } else {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'no such mode' }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const okChat = (content) => ({ id: 'cmpl-x', model: 'mock-1', choices: [{ message: { role: 'assistant', content } }], usage: { total_tokens: 7 } });

const routes = {
  ok: ({ body }) => {
    // shape check (returned is recorded in body for the caller to assert on)
    if (body.model !== 'v2-mock' || !Array.isArray(body.messages)) return { status: 400, json: { error: 'malformed request' } };
    return { status: 200, json: okChat('{"greeting":"hello"}') };
  },
  rate: () => ({ status: 429, json: { error: 'slow down' } }),
  auth: () => ({ status: 401, json: { error: 'bad key' } }),
  boom: () => ({ status: 500, json: { error: 'vendor boom' } }),
  junk: () => ({ status: 200, json: { this_is: 'not a chat completion' } }),
  notjson: () => ({ status: 200, json: okChat('<html>i am not json</html>') }),
};

test('provider: happy path through the compatibility surface', async () => {
  const server = await mockServer(routes);
  const port = server.address().port;
  const p = new OpenAICompatibleProvider({ name: 'mock', baseUrl: `http://127.0.0.1:${port}`, model: 'v2-mock' });
  const res = await p.chat([{ role: 'system', content: 'x' }]);
  assert.equal(res.text, '{"greeting":"hello"}');
  assert.equal(res.model, 'mock-1');
  await new Promise((r) => server.close(r));
});

test('provider: status classes land exactly in kernel vocabulary', async () => {
  const server = await mockServer(routes);
  const port = server.address().port;
  const f = (mode, cls) => new OpenAICompatibleProvider({ name: 'mock', baseUrl: `http://127.0.0.1:${port}/?mode=${mode}`, model: 'v2-mock' });
  await assert.rejects(() => f('rate', '').chat([{ role: 'user', content: 'x' }]), (e) => e instanceof ModelError && e.cls === 'MODEL_RATE_LIMIT');
  await assert.rejects(() => f('auth').chat([{ role: 'user', content: 'x' }]), (e) => e.cls === 'AUTH_REQUIRED');
  await assert.rejects(() => f('boom').chat([{ role: 'user', content: 'x' }]), (e) => e.cls === 'MODEL_FAILURE');
  await assert.rejects(() => f('junk').chat([{ role: 'user', content: 'x' }]), (e) => e.cls === 'INVALID_TOOL_OUTPUT');
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

test('provider: unreachable host -> NETWORK_FAILURE; slow route -> TIMEOUT', async () => {
  const dead = new OpenAICompatibleProvider({ name: 'dead', baseUrl: 'http://127.0.0.1:1', model: 'x' });
  await assert.rejects(() => dead.chat([{ role: 'user', content: 'y' }]), (e) => e.cls === 'NETWORK_FAILURE');
  const slow = http.createServer((req, res) => { /* deliberate stall */ });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  const port = slow.address().port;
  const p = new OpenAICompatibleProvider({ name: 'slow', baseUrl: `http://127.0.0.1:${port}`, model: 'x', timeoutMs: 400 });
  const t0 = Date.now();
  await assert.rejects(() => p.chat([{ role: 'user', content: 'y' }]), (e) => e.cls === 'TIMEOUT');
  assert.ok(Date.now() - t0 < 3000, 'abort honored instead of hanging forever');
  slow.closeAllConnections();
  await new Promise((r) => slow.close(r));
});

test('chatValidated: JSON parse + zod schema gate; schema-fail is INVALID_TOOL_OUTPUT', async () => {
  const server = await mockServer(routes);
  const port = server.address().port;
  const provider = new OpenAICompatibleProvider({ name: 'mock', baseUrl: `http://127.0.0.1:${port}`, model: 'v2-mock' });
  const Greeter = z.object({ greeting: z.string() });
  const v = await chatValidated(provider, [{ role: 'user', content: 'hi' }], { schema: Greeter, timeoutMs: 5000 });
  assert.deepEqual(v.value, { greeting: 'hello' });
  // same endpoint, deliberately WRONG schema -> classification, never a value
  const Other = z.object({ num: z.number() });
  await assert.rejects(() => chatValidated(provider, [{ role: 'user', content: 'hi' }], { schema: Other }), (e) => e.cls === 'INVALID_TOOL_OUTPUT');
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});
