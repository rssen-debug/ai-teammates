/**
 * Tool recovery, using V2's recovery advisor (`src/v2/recover/advisor.js`).
 *
 * The rule the tests defend: a failure gets a *bounded* retry, and only for
 * work with no side effects. Retrying a write could duplicate an effect that
 * actually landed before the error surfaced.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { ToolRegistry } from '../../src/v2/tools/registry.js';
import { ConversationStore, GoalStore } from '../../src/v4/store.js';
import { createAgent } from '../../src/v4/agent.js';
import { recoveryPlan } from '../../src/v2/recover/advisor.js';
import { tempHome } from './helpers.mjs';

function build({ toolDef, modelScript }) {
  const home = tempHome();
  const config = {
    version: 'test',
    paths: { home },
    workspaceDir: path.join(home, 'workspace'),
    limits: { maxMessageChars: 4000, maxModelRounds: 3, maxToolCallsPerTurn: 3, toolTimeoutMs: 2000 },
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

test('recovery: a read tool that fails once is retried and succeeds', async () => {
  let attempts = 0;
  const h = build({
    toolDef: {
      name: 'flaky_read',
      description: 'fails once, then works',
      tier: 'read',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => {
        attempts += 1;
        if (attempts === 1) {
          const err = new Error('upstream timed out');
          err.cls = 'TIMEOUT';
          throw err;
        }
        return { ok: true };
      },
    },
    modelScript: [callTool('flaky_read'), { text: 'klart' }],
  });
  try {
    const events = [];
    const res = await h.agent.runTurn({ text: 'läs', emit: (t, d) => events.push({ t, d }) });
    assert.equal(attempts, 2, 'the tool ran twice');
    assert.equal(res.status, 'completed', `turn should recover, got ${res.status}`);
    const recovery = events.filter((e) => e.t === 'recovery');
    assert.equal(recovery.length, 1);
    assert.equal(recovery[0].d.failureClass, 'TIMEOUT');
    assert.equal(recovery[0].d.action, 'retry_simple');
    // both attempts are visible in the goal's evidence, not hidden
    const goal = h.goals.get(res.goalId);
    assert.ok(goal.receipts.some((r) => r.result === 'failure' && r.errorClass === 'TIMEOUT'));
    assert.ok(goal.receipts.some((r) => r.result === 'success'));
  } finally {
    h.cleanup();
  }
});

test('recovery: a write tool is never retried, because the effect may have landed', async () => {
  let attempts = 0;
  const h = build({
    toolDef: {
      name: 'write_once',
      description: 'always fails',
      tier: 'write',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => {
        attempts += 1;
        const err = new Error('disk hiccup');
        err.cls = 'TIMEOUT';
        throw err;
      },
    },
    modelScript: [callTool('write_once'), { text: 'klart' }],
  });
  try {
    // A write tier needs consent; grant it so the test exercises the retry rule
    // rather than the approval gate.
    h.agent.approvals.grant('tool:write_once', { user: 'owner', mode: 'session', maxUses: 10 });
    const res = await h.agent.runTurn({ text: 'skriv' });
    assert.equal(attempts, 1, 'a write is attempted exactly once');
    assert.equal(res.status, 'failed');
  } finally {
    h.cleanup();
  }
});

test('recovery: the retry budget is bounded by the advisor, never infinite', async () => {
  let attempts = 0;
  const h = build({
    toolDef: {
      name: 'always_flaky',
      description: 'always fails',
      tier: 'read',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => {
        attempts += 1;
        const err = new Error('still down');
        err.cls = 'NETWORK_FAILURE';
        throw err;
      },
    },
    modelScript: [callTool('always_flaky'), { text: 'klart' }],
  });
  try {
    const res = await h.agent.runTurn({ text: 'läs' });
    assert.equal(res.status, 'failed');
    const budget = recoveryPlan('NETWORK_FAILURE').totalBudget;
    // retry_backoff x2 is the only executable step in that plan: 1 + 2 attempts
    assert.equal(attempts, 3, `expected 1 + 2 retries, got ${attempts} (class budget ${budget})`);
    assert.ok(attempts < 8, 'bounded, not a loop');
  } finally {
    h.cleanup();
  }
});

test('recovery: a failure class with no executable retry is reported, not invented', async () => {
  let attempts = 0;
  const h = build({
    toolDef: {
      name: 'needs_permission',
      description: 'permission denied',
      tier: 'read',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => {
        attempts += 1;
        const err = new Error('denied');
        err.cls = 'PERMISSION_DENIED';
        throw err;
      },
    },
    modelScript: [callTool('needs_permission'), { text: 'klart' }],
  });
  try {
    const events = [];
    const res = await h.agent.runTurn({ text: 'läs', emit: (t, d) => events.push({ t, d }) });
    assert.equal(res.status, 'failed');
    assert.equal(attempts, 1, 'the denied tool must not be retried');
    const recovery = events.filter((e) => e.t === 'recovery');
    // The tool-level advisor emits exactly one decision for this call. The
    // goal supervisor may additionally report its separate replan/checkpoint
    // bookkeeping, but neither may turn into a retry of the denied tool.
    const advisor = recovery.filter((e) => e.d.tool === 'needs_permission');
    assert.equal(advisor.length, 1);
    assert.equal(advisor[0].d.action, 'none', 'no retry step was executed');
    assert.ok(advisor[0].d.advice.includes('escalate'), 'the human-facing advice is surfaced');
    assert.ok(!recovery.some((e) => String(e.d.action || '').startsWith('retry_')), 'no retry was invented');
  } finally {
    h.cleanup();
  }
});
