/**
 * V2 supervisor-with-model-planner contracts: the planner role may split the
 * work, but the acceptance verifiers are ALWAYS created by the framework from
 * the compiled goal (never by the model), bad planner output falls back loudly
 * to the template, and unknown roles are rejected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenAICompatibleProvider } from '../src/v2/model/provider.js';
import { roleCall } from '../src/v2/supervisor/roles.js';
import { planWithModel } from '../src/v2/supervisor/plan-with-model.js';
import { compileDeterministic } from '../src/v2/compiler/goal-compiler.js';
import { runObjective } from '../src/v2/runtime/orchestrator.js';

function mockServer(contentFor) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'p', model: 'mock', choices: [{ message: { role: 'assistant', content: contentFor(JSON.parse(body || '{}')) } }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const GOOD_PLANNER = (body) => JSON.stringify({
  subtasks: [
    { action: 'fetch html skeleton', role: 'executor', deps: [] },
    { action: 'fill css and script', role: 'executor', deps: [] },
    { action: 'verify everything', role: 'verifier', deps: [] }, // sneaky: must be ignored
  ],
  notes: 'split into two builds',
});

test('planWithModel: executor subtasks honored; model-verify attempts discarded; framework verifiers ALWAYS from goal', async () => {
  const server = await mockServer(GOOD_PLANNER);
  const port = server.address().port;
  const provider = new OpenAICompatibleProvider({ name: 'planner', baseUrl: `http://127.0.0.1:${port}`, model: 'x' });
  const compiled = compileDeterministic('build a site');
  const { graph, roles, meta } = await planWithModel(compiled, provider, { goalId: 'goal_pm' });
  server.closeAllConnections(); await new Promise((r) => server.close(r));
  assert.equal(meta.source, 'model');
  const tasks = [...graph.tasks.values()];
  const buildTasks = tasks.filter((t) => t.id.startsWith('build:'));
  assert.equal(buildTasks.length, 2);
  const verifyTasks = tasks.filter((t) => t.id.startsWith('verify:'));
  assert.equal(verifyTasks.length, compiled.acceptance.length, 'exactly the compiled acceptance items get verifiers');
  assert.ok(verifyTasks.every((t) => t.deps.length === 2), 'each verifier waits on both builds');
  assert.equal(roles['verify:files'], 'verifier');
});

test('planWithModel: planner garbage -> template fallback, loud meta', async () => {
  const server = await mockServer(() => 'not a plan');
  const port = server.address().port;
  const provider = new OpenAICompatibleProvider({ name: 'planner', baseUrl: `http://127.0.0.1:${port}`, model: 'x' });
  const compiled = compileDeterministic('build a site');
  const { graph, meta } = await planWithModel(compiled, provider, { goalId: 'goal_pm2' });
  server.closeAllConnections(); await new Promise((r) => server.close(r));
  assert.equal(meta.source, 'template');
  assert.equal(meta.fallbackFrom, 'INVALID_TOOL_OUTPUT');
  assert.deepEqual(graph.readySet(), ['plan']);
});

test('roleCall: unknown role rejected; schema mismatched role output classified', async () => {
  const server = await mockServer(() => JSON.stringify({ nope: true }));
  const port = server.address().port;
  const provider = new OpenAICompatibleProvider({ name: 'mockr', baseUrl: `http://127.0.0.1:${port}`, model: 'x' });
  await assert.rejects(() => roleCall('ninja', 'x', provider), (e) => e.cls === 'INVALID_TOOL_OUTPUT');
  await assert.rejects(() => roleCall('planner', 'x', provider), (e) => e.cls === 'INVALID_TOOL_OUTPUT');
  server.closeAllConnections(); await new Promise((r) => server.close(r));
});

test('orchestrator with model-planner: still completes with framework verifiers; model-verifier attempt NEVER reaches the graph', async () => {
  const server = await mockServer(GOOD_PLANNER);
  const port = server.address().port;
  const provider = new OpenAICompatibleProvider({ name: 'planner', baseUrl: `http://127.0.0.1:${port}`, model: 'x' });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-pm-orch-'));
  const s = await runObjective('build a modern portfolio website and show it to me', { workspaceDir: ws, provider, plannerWithModel: true, allowModel: false });
  server.closeAllConnections(); await new Promise((r) => server.close(r));
  assert.equal(s.goal.state, 'COMPLETED');
  assert.equal(s.planner.source, 'model');
  assert.ok(s.goal.verifiedReceipts >= 2, 'framework verification receipts present');
});
