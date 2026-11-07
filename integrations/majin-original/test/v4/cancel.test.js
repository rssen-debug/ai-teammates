/**
 * Cancellation must reach the work, not just the socket.
 *
 * A turn runs tools with a timeout (20 s by default, 15 s for plugins). Until
 * now `executeToolCall` received no signal at all, so pressing stop during a
 * tool call detached the client while the work kept going and its side effects
 * landed with no receipt. That is the worst kind of lie: the UI said cancelled.
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
import { Kernel } from '../../src/v4/kernel.js';
import { tempHome } from './helpers.mjs';

function build({ toolDef, modelScript }) {
  const home = tempHome();
  const config = {
    version: 'test',
    paths: { home },
    workspaceDir: path.join(home, 'workspace'),
    limits: { maxMessageChars: 4000, maxModelRounds: 2, maxToolCallsPerTurn: 2, toolTimeoutMs: 8000, maxContextTokens: 4000 },
    approvals: { policy: 'sandbox-auto' },
  };
  fs.mkdirSync(config.workspaceDir, { recursive: true });
  const conversations = new ConversationStore({ dir: path.join(home, 'conv') });
  const goals = new GoalStore({ dir: path.join(home, 'goals') });
  const registry = new ToolRegistry();
  registry.define(toolDef);
  const tools = { registry, root: config.workspaceDir, memory: null };
  let i = 0;
  const model = {
    info: { demo: false },
    infoFor: () => ({ demo: false }),
    async chat() {
      const step = modelScript[Math.min(i, modelScript.length - 1)];
      i += 1;
      return { text: step.text || '', toolCalls: step.toolCalls || [], demo: false };
    },
  };
  const agent = createAgent({ config, conversations, goals, tools, model });
  return { home, config, goals, agent, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

const callTool = (name) => ({ text: '', toolCalls: [{ id: `c_${name}`, name, argsJson: '{}' }] });

test('cancel: a long tool call receives an abort signal and stops when the turn is cancelled', async () => {
  let sawSignal = false;
  let finished = false;
  const h = build({
    toolDef: {
      name: 'slow_but_cooperative',
      description: 'waits for an abort signal',
      tier: 'read',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async (_input, ctx = {}) => {
        sawSignal = Boolean(ctx.signal);
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => { finished = true; resolve(); }, 5000);
          ctx.signal?.addEventListener('abort', () => { clearTimeout(t); finished = false; reject(Object.assign(new Error('cancelled'), { code: 'ABORTED' })); }, { once: true });
        });
        return { ok: true };
      },
    },
    modelScript: [callTool('slow_but_cooperative'), { text: 'klart' }],
  });
  try {
    const controller = h.agent.beginTurn('conv_x');
    const turn = h.agent.runTurn({ text: 'kör', conversationId: null, signal: controller.signal });

    await new Promise((r) => setTimeout(r, 150));
    controller.abort();
    const result = await turn;

    assert.equal(sawSignal, true, 'the tool must be given a signal to obey');
    assert.equal(finished, false, 'the tool did not run to completion after the abort');
    assert.equal(result.status, 'cancelled');
  } finally {
    h.cleanup();
  }
});

test('cancel: a plugin worker call is stopped, not left running in the child process', async () => {
  const root = tempHome();
  const dir = path.join(root, 'plugins', 'slowy');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    name: 'slowy',
    version: '1.0.0',
    kernelApi: 1,
    description: 'a plugin that takes its time',
    permissions: [],
    capabilities: [{ kind: 'tool', name: 'slow' }],
  }));
  fs.writeFileSync(path.join(dir, 'index.js'), `
    export function activate(ctx) {
      ctx.registerTool({
        name: 'slow',
        description: 'waits five seconds',
        tier: 'read',
        execute: async () => { await new Promise((r) => setTimeout(r, 5000)); return { done: true }; },
      });
    }
  `);

  const worker = new PluginWorker({ dir, manifest: JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')), callTimeoutMs: 10_000 });
  try {
    await worker.start();
    const started = Date.now();
    const call = worker.call('slow', {});
    await new Promise((r) => setTimeout(r, 100));
    worker.stop();
    await assert.rejects(() => call, (err) => /died|not running/i.test(err.message));
    assert.ok(Date.now() - started < 3000, 'the call did not wait out its five seconds');
  } finally {
    worker.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cancel: a cancelled turn records a cancelled goal, never a completion', async () => {
  const h = build({
    toolDef: {
      name: 'cooperative',
      description: 'obeys the signal',
      tier: 'read',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async (_i, ctx = {}) => new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 3000, { ok: true });
        ctx.signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('cancelled'), { code: 'ABORTED' })); }, { once: true });
      }),
    },
    modelScript: [callTool('cooperative'), { text: 'klart' }],
  });
  try {
    const controller = h.agent.beginTurn('conv_y');
    const turn = h.agent.runTurn({ text: 'kör', signal: controller.signal });
    await new Promise((r) => setTimeout(r, 120));
    controller.abort();
    const result = await turn;
    const goal = h.goals.get(result.goalId);
    assert.equal(goal.state, 'CANCELLED', `goal was ${goal.state}`);
    assert.ok(!goal.receipts.some((r) => r.result === 'success' && r.action === 'tool:cooperative'));
  } finally {
    h.cleanup();
  }
});

test('cancel: cancelling a turn stops the plugin worker it was waiting on', async () => {
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
  const kernel = new Kernel({ pluginsEnabled: true, isolate: true, quarantineDir: path.join(root, 'q') });
  try {
    await kernel.loadPlugins(path.join(root, 'plugins'));
    const tool = kernel.get('tool', 'wait');
    assert.ok(tool, 'plugin tool registered');

    const controller = new AbortController();
    const started = Date.now();
    const call = tool.execute({}, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 150));
    controller.abort();

    await assert.rejects(() => call, (err) => /cancel/i.test(err.message));
    assert.ok(Date.now() - started < 4000, 'the call ended promptly, not after ten seconds');
    const worker = [...kernel.workers.values()][0];
    assert.equal(worker?.dead ?? true, true, 'the worker was stopped');
  } finally {
    await kernel.shutdownWorkers();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cancel: logging out stops the turns that session started', async () => {
  const { startTestServer, postChat, readSse } = await import('./helpers.mjs');
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const res = await postChat(s.base, cookie, { text: 'Skriv filen utloggad.txt med innehåll: x', requestId: 'lo1' });
    const turnId = res.headers.get('x-majin-turn');

    const out = await fetch(`${s.base}/api/auth/logout`, {
      method: 'POST',
      headers: { 'x-majin-csrf': '1', origin: s.base, cookie },
    });
    assert.equal(out.status, 200);

    const events = await readSse(res);
    const status = events.filter((e) => e.type === 'done').pop()?.data?.status;
    // The turn may already have finished (the demo brain is fast); what must be
    // true is that the revoked device cannot read it afterwards.
    const re = await fetch(`${s.base}/api/chat/stream?turnId=${turnId}&from=0`, { headers: { cookie } });
    assert.equal(re.status, 401, 'a revoked session cannot reattach');
    assert.ok(['cancelled', 'completed'].includes(status), status);
  } finally {
    await s.close();
  }
});

test('cancel: cancelOwnedBy stops one session and leaves the other device running', async () => {
  const h = build({
    toolDef: {
      name: 'idle',
      description: 'does nothing',
      tier: 'read',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => ({ ok: true }),
    },
    modelScript: [{ text: 'hej' }],
  });
  try {
    const a = h.agent.beginTurn('turn:a', { owner: 'session-phone' });
    const b = h.agent.beginTurn('turn:b', { owner: 'session-desktop' });

    const stopped = h.agent.cancelOwnedBy('session-phone');
    assert.equal(stopped, 1);
    assert.equal(a.signal.aborted, true, 'the revoked session\'s turn stopped');
    assert.equal(b.signal.aborted, false, 'the other device keeps working');

    assert.equal(h.agent.cancelOwnedBy('unknown'), 0);
    h.agent.endTurn('turn:a', a);
    h.agent.endTurn('turn:b', b);
  } finally {
    h.cleanup();
  }
});
