/**
 * End-to-end: a model authors the goal, the orchestrator executes and verifies
 * it on its own evidence gates. The model is a LOCAL mock — the discipline
 * being proven is the wiring, not a vendor key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runObjective } from '../src/v2/runtime/orchestrator.js';
import { OpenAICompatibleProvider } from '../src/v2/model/provider.js';

function mockGoalAuthor() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'y', model: 'mock', choices: [{ message: { role: 'assistant', content: JSON.stringify({
            objective: 'build a portfolio website and show it',
            deliverables: ['runnable website project'],
            acceptance: [{ id: 'files', description: 'index.html exists with html doctype', verify: { kind: 'file', spec: { path: 'index.html', contains: '<' } }, inferred: false }],
            risk: 'low', permissions: ['workspace_write'],
          }) } }],
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('model-authored goal drives the full orchestrator pipeline to COMPLETED (provenance=model)', async () => {
  const server = await mockGoalAuthor();
  const port = server.address().port;
  const provider = new OpenAICompatibleProvider({ name: 'goal-author', baseUrl: `http://127.0.0.1:${port}`, model: 'x' });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-orch-model-'));
  const s = await runObjective('build a portfolio website and show it to me', { workspaceDir: ws, provider });
  server.closeAllConnections(); await new Promise((r) => server.close(r));
  assert.equal(s.compiler.source, 'model');
  assert.equal(s.goal.state, 'COMPLETED', 'index.html verified independently');
  assert.ok(fs.existsSync(path.join(ws, 'index.html')));
  assert.ok(s.goal.verifiedReceipts >= 1);
});
