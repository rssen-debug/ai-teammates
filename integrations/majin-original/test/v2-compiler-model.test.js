/**
 * V2 compiler-router contracts: a model may author goals, but zod gates them,
 * permissions clamp to the allowlist, provenance is stamped by US (never the
 * model), and every model failure falls back to deterministic LOUDLY.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { compileGoal, KNOWN_PERMISSIONS } from '../src/v2/compiler/router.js';
import { OpenAICompatibleProvider } from '../src/v2/model/provider.js';
import { InvalidCompilation } from '../src/v2/compiler/goal-compiler.js';

function mockLlmServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const out = handler(JSON.parse(body || '{}'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'x', model: 'mock', choices: [{ message: { role: 'assistant', content: out } }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const GOOD = JSON.stringify({
  objective: 'build a landing page',
  deliverables: ['runnable website project'],
  acceptance: [{ id: 'files', description: 'index.html exists', verify: { kind: 'file', spec: { path: 'index.html', contains: '<html' } }, inferred: true }],
  risk: 'low', permissions: ['workspace_write'],
});

test('router: model authors the goal -> parsed, permission-clamped, provenance stamped by us', async () => {
  const server = await mockLlmServer((body) => {
    assert.ok(body.messages[0].content.includes('JSON only'));
    const payload = JSON.parse(GOOD);
    payload.permissions = ['workspace_write', 'delete_home', 'send_email']; // poison attempts
    payload.source = 'already:trusted:by:you'; // provenance-override attempt
    payload.schema = 'forged'; // schema-override attempt
    return JSON.stringify(payload);
  });
  const port = server.address().port;
  const provider = new OpenAICompatibleProvider({ name: 'mockllm', baseUrl: `http://127.0.0.1:${port}`, model: 'x' });
  const { goal, meta } = await compileGoal('build a landing page', { provider });
  server.closeAllConnections(); await new Promise((r) => server.close(r));
  assert.equal(meta.source, 'model');
  assert.deepEqual(goal.permissions, ['workspace_write'], 'clamped to allowlist');
  assert.equal(goal.source, 'model', 'we stamped provenance, not the model');
  assert.equal(goal.risk, 'low');
});

test('router: malformed model goal -> loud deterministic fallback with classification (never silent)', async () => {
  const server = await mockLlmServer(() => 'tell me about dolphins'); // not JSON at all
  const port = server.address().port;
  const provider = new OpenAICompatibleProvider({ name: 'mockllm', baseUrl: `http://127.0.0.1:${port}`, model: 'x' });
  const { goal, meta } = await compileGoal('build a website', { provider });
  server.closeAllConnections(); await new Promise((r) => server.close(r));
  assert.equal(meta.source, 'deterministic');
  assert.equal(meta.fallbackFrom, 'INVALID_TOOL_OUTPUT');
  assert.equal(goal.source, 'deterministic');
});

test('router: model endpoint dead -> deterministic fallback classified NETWORK_FAILURE', async () => {
  const provider = new OpenAICompatibleProvider({ name: 'dead', baseUrl: 'http://127.0.0.1:1', model: 'x', timeoutMs: 3000 });
  const { goal, meta } = await compileGoal('research benchmarks', { provider });
  assert.equal(meta.source, 'deterministic');
  assert.equal(meta.fallbackFrom, 'NETWORK_FAILURE');
  assert.equal(goal.acceptance[0].verify.spec.path, 'report.md');
});

test('router: allowModel=false uses deterministic even when a provider exists', async () => {
  const provider = new OpenAICompatibleProvider({ name: 'never-called', baseUrl: 'http://127.0.0.1:1', model: 'x' });
  const { goal, meta } = await compileGoal('build a website', { provider, allowModel: false });
  assert.equal(meta.source, 'deterministic');
  assert.equal(goal.deliverables[0], 'runnable website project');
});

test('permissions allowlist is intentionally small (expand only via PR)', () => {
  assert.ok(KNOWN_PERMISSIONS.length <= 8);
  for (const p of KNOWN_PERMISSIONS) assert.match(p, /^[a-z_]+$/);
});
