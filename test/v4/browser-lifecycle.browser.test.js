// Real local CDP browser lifecycle with an injected planner. Not live Go proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-goal-browser-'));
process.env.MAJIN_HOME = home; // Before dynamic imports of V1's filesystem layout.
const { findBrowser, isOpen, closeFor } = await import('../../src/core/browser.js');
const { webTools } = await import('../../src/core/tools/web.js');
const { registerHostTools } = await import('../../src/v4/tools/host.js');
const { createAgent } = await import('../../src/v4/agent.js');
const { ConversationStore, GoalStore } = await import('../../src/v4/store.js');
const { ToolRegistry } = await import('../../src/v2/tools/registry.js');
const { z } = await import('zod');

test('goal browsers stay isolated through consent and close on completion or denial', { timeout: 90000 }, async (t) => {
  if (!findBrowser()) { fs.rmSync(home, { recursive: true, force: true }); t.skip('No installed browser binary; no lifecycle PASS claimed.'); return; }
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Controlled task page</title><h1>Local lifecycle fixture</h1>'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = { version: 'test', paths: { home }, workspaceDir: path.join(home, 'workspace'), limits: { maxMessageChars: 4000, maxModelRounds: 3, maxToolCallsPerTurn: 4, toolTimeoutMs: 35000 }, approvals: { policy: 'sandbox-auto' } };
  fs.mkdirSync(config.workspaceDir);
  const conversations = new ConversationStore({ dir: path.join(home, 'conversations') });
  const goals = new GoalStore({ dir: path.join(home, 'goals') });
  const registry = new ToolRegistry();
  const tools = { registry, root: config.workspaceDir, memory: null };
  const model = { info: { demo: false, provider: 'injected-test', model: 'injected-test' }, async chat({ messages }) {
    return messages.some((m) => m.role === 'tool') ? { text: 'Controlled task complete.', toolCalls: [] } : { text: '', toolCalls: [
      { id: 'open', name: 'browser_open', argsJson: JSON.stringify({ url: base, headless: true }) },
      { id: 'hold', name: 'controlled_hold', argsJson: '{}' },
    ] };
  } };
  const agent = createAgent({ config, conversations, goals, tools, model });
  registry.define({ name: 'controlled_hold', description: 'Controlled no-op awaiting separate consent', tier: 'process', inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }), execute: async () => ({ ok: true }) });
  registerHostTools(registry, { browserRuntime: { available: true }, lanes: { web: { available: true, module: { webTools }, exportName: 'webTools', tools: ['browser.open'] } } }, { workspaceDir: config.workspaceDir, approvals: agent.approvals, session: 'v4' });
  const sessions = [];
  const outcomes=[];
  const emit=(event,data)=>{if(event==='tool_result')outcomes.push({name:data.name,ok:data.ok,error:data.error,summary:data.summary});};
  try {
    const first = await agent.runTurn({ text: 'Controlled task A', emit });
    const second = await agent.runTurn({ text: 'Controlled task B', emit });
    sessions.push(`v4:${first.goalId}`, `v4:${second.goalId}`);
    assert.notEqual(sessions[0], sessions[1]);
    for (const task of [first, second]) {
      assert.equal((await agent.resolveApproval({ conversationId: task.conversationId, approve: true, emit })).status, 'awaiting_approval');
      assert.equal(conversations.get(task.conversationId).pendingApproval.tool, 'controlled_hold');
    }
    assert.ok(sessions.every((session) => isOpen(session)), 'both distinct task browsers remain open during consent: '+JSON.stringify(outcomes));
    assert.equal((await agent.resolveApproval({ conversationId: first.conversationId, approve: true })).status, 'completed');
    assert.equal(isOpen(sessions[0]), false);
    assert.equal(isOpen(sessions[1]), true, 'completing A never closes B');
    assert.equal((await agent.resolveApproval({ conversationId: second.conversationId, approve: false })).status, 'denied');
    assert.equal(isOpen(sessions[1]), false, 'denial releases B browser and its fleet slot');
  } finally {
    for (const session of sessions) await closeFor(session, { wait: true });
    await new Promise((resolve) => server.close(resolve));
    const resolved = path.resolve(home), parent = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(resolved.startsWith(parent + 'majin-goal-browser-'), 'cleanup remains in this test temp directory');
    await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
  t.diagnostic('Actual local browser processes and task isolation; injected planner, no physical iPhone or Go-model claim.');
});
