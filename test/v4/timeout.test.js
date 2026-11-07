/**
 * A deadline is not a stop — unless the tool is told.
 *
 * V2's runner races the tool against a timer. When the timer wins, the promise
 * rejects but `def.execute()` keeps running with no signal. A tool that writes
 * after its deadline landed a side effect after the goal was already recorded as
 * failed, with no receipt for it.
 *
 * What V4 can do, and does:
 *   - give every in-process tool a signal that fires on the turn's abort OR its
 *     own deadline, so a cooperative tool stops before its effect lands;
 *   - stop a plugin worker, which is the only way to stop code in a child.
 *
 * What V4 cannot do, and says so: a tool that ignores the signal keeps running.
 * No process can un-run code it cannot interrupt. For that case the test asserts
 * the weaker but honest property — no success is ever recorded for it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { ToolRegistry } from '../../src/v2/tools/registry.js';
import { ConversationStore, GoalStore } from '../../src/v4/store.js';
import { createAgent } from '../../src/v4/agent.js';
import { PluginWorker } from '../../src/v4/sandbox.js';
import { tempHome } from './helpers.mjs';

function buildAgent({ toolDef, toolTimeoutMs = 150 }) {
  const home = tempHome();
  const config = {
    version: 'test',
    paths: { home },
    workspaceDir: path.join(home, 'workspace'),
    limits: { maxMessageChars: 4000, maxModelRounds: 2, maxToolCallsPerTurn: 2, toolTimeoutMs, maxContextTokens: 4000 },
    approvals: { policy: 'sandbox-auto' },
  };
  fs.mkdirSync(config.workspaceDir, { recursive: true });
  const conversations = new ConversationStore({ dir: path.join(home, 'conv') });
  const goals = new GoalStore({ dir: path.join(home, 'goals') });
  const registry = new ToolRegistry();
  registry.define(toolDef);
  const tools = { registry, root: config.workspaceDir, memory: null };
  const model = {
    info: { demo: false },
    infoFor: () => ({ demo: false }),
    chat: async () => ({ text: '', toolCalls: [{ id: 'c1', name: toolDef.name, argsJson: '{}' }], demo: false }),
  };
  const agent = createAgent({ config, conversations, goals, tools, model });
  agent.approvals.grant(`tool:${toolDef.name}`, { user: 'owner', mode: 'session', maxUses: 10 });
  return { home, config, agent, goals, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test('timeout: a cooperative tool is told about its deadline and stops before the effect lands', async () => {
  const target = () => path.join(home, 'workspace', 'late.txt');
  let home;
  const h = buildAgent({
    toolDef: {
      name: 'slow_write',
      description: 'would write late, but obeys the deadline',
      tier: 'write',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async (_input, ctx = {}) => {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 600);
          ctx.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(Object.assign(new Error('deadline exceeded'), { cls: 'TIMEOUT' }));
          }, { once: true });
        });
        fs.writeFileSync(path.join(h.config.workspaceDir, 'late.txt'), 'skrev ändå');
        return { ok: true };
      },
    },
  });
  home = h.home;
  try {
    const res = await h.agent.runTurn({ text: 'skriv' });
    assert.equal(res.status, 'failed', `expected a failed turn, got ${res.status}`);
    await new Promise((r) => setTimeout(r, 900)); // well past the tool's own delay
    assert.equal(fs.existsSync(target()), false, 'the timed-out write executed anyway');
    const goal = h.goals.get(res.goalId);
    assert.ok(!goal.receipts.some((r) => r.result === 'success' && r.action === 'tool:slow_write'));
  } finally {
    h.cleanup();
  }
});

test('timeout: a tool that ignores the signal still never earns a success receipt', async () => {
  const h = buildAgent({
    toolDef: {
      name: 'stubborn',
      description: 'ignores the signal entirely',
      tier: 'read',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => {
        await new Promise((r) => setTimeout(r, 600));
        return { ok: true };
      },
    },
  });
  try {
    const res = await h.agent.runTurn({ text: 'kör' });
    assert.equal(res.status, 'failed');
    const goal = h.goals.get(res.goalId);
    assert.ok(!goal.receipts.some((r) => r.result === 'success'), 'no success may be recorded for an overrun');
    assert.ok(goal.receipts.some((r) => r.result === 'failure' && r.errorClass === 'TIMEOUT'));
  } finally {
    h.cleanup();
  }
});

test('timeout: a plugin worker is stopped when its call deadline passes', async () => {
  const root = tempHome();
  const dir = path.join(root, 'plugins', 'slowp');
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { name: 'slowp', version: '1.0.0', kernelApi: 1, description: 'slow plugin', permissions: [], capabilities: [{ kind: 'tool', name: 'wait' }] };
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'index.js'), `
    export function activate(ctx) {
      ctx.registerTool({ name: 'wait', description: 'waits', tier: 'read', execute: async () => { await new Promise((r) => setTimeout(r, 10_000)); return { done: true }; } });
    }
  `);
  const worker = new PluginWorker({ dir, manifest, callTimeoutMs: 200 });
  try {
    await worker.start();
    const started = Date.now();
    const signal = new AbortController();
    const call = worker.call('wait', {}, { signal: signal.signal });
    setTimeout(() => signal.abort(), 100);
    await assert.rejects(() => call);
    assert.ok(Date.now() - started < 5000, 'the call ended near its deadline');
    assert.equal(worker.dead, true, 'the worker was stopped, so no late effect can land');
  } finally {
    await worker.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
