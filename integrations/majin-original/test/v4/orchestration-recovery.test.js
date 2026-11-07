import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tempHome } from './helpers.mjs';
import { TeamStore, runTeam } from '../../src/core/teams.js';
import { createTeamTools } from '../../src/v4/teams.js';
import { createGraphTool } from '../../src/v4/graph.js';
import { runInTurn } from '../../src/v4/turn-state.js';

test('team: failed nodes are retried on resume; only successful work is skipped', async () => {
  const workspaceDir = tempHome();
  try {
    const store = new TeamStore({ workspaceDir });
    store.ensureTeam('recovery');
    store.addMember('recovery', { id: 'worker', role: 'test' });
    const goals = [{ id: 'a', member: 'worker', input: 'first' }, { id: 'b', member: 'worker', input: 'second', deps: ['a'] }];
    const first = await runTeam({ store, team: 'recovery', goals, makeWorker: () => async () => ({ ok: false, error: 'transient', steps: 1 }) });
    assert.deepEqual(store.loadCheckpoint('recovery', first.runId).done, {});
    // A checkpoint written by an older version must also be repaired on read.
    store.saveCheckpoint('recovery', first.runId, { done: { a: { ok: false, steps: 1 } } });
    const calls = [];
    const resumed = await runTeam({ store, team: 'recovery', goals, resumeId: first.runId,
      makeWorker: () => async (node) => { calls.push(node.id); return { ok: true, text: node.id, steps: 1 }; } });
    assert.deepEqual(calls, ['a', 'b']);
    assert.equal(resumed.status, 'complete');
  } finally { fs.rmSync(workspaceDir, { recursive: true, force: true }); }
});

test('team: dependencies receive verified artifacts and text; budgets reach the worker', async () => {
  const workspaceDir = tempHome();
  try {
    const store = new TeamStore({ workspaceDir });
    store.ensureTeam('context');
    store.addMember('context', { id: 'worker', role: 'test', maxSteps: 2 });
    const calls = [];
    const artifact = { fileName: 'result.txt', acceptanceId: 'artifact:result.txt', evidence: { verified: true } };
    const tool = createTeamTools({ workspaceDir, runSubtask: async (args) => {
      calls.push(args);
      return { answer: 'dependency-fact', calls: 1, tools: [], artifacts: calls.length === 1 ? [artifact] : [] };
    } }).find((tool) => tool.name === 'team_run');
    const result = await runInTurn({ depth: 0 }, () => tool.execute({ team: 'context', goals: [
      { id: 'a', member: 'worker', input: 'research' },
      { id: 'b', member: 'worker', input: 'combine', deps: ['a'] },
    ] }));
    assert.equal(result.ok, true);
    assert.match(calls[1].task, /\[a\] dependency-fact/);
    assert.equal(calls[0].maxCalls, 2);
    assert.deepEqual(result.artifacts, [artifact]);
  } finally { fs.rmSync(workspaceDir, { recursive: true, force: true }); }
});

test('team: cancellation prevents dependent work and never checkpoints cancelled work as done', async () => {
  const workspaceDir = tempHome();
  try {
    const store = new TeamStore({ workspaceDir });
    store.ensureTeam('cancel');
    store.addMember('cancel', { id: 'worker', role: 'test' });
    const controller = new AbortController();
    const calls = [];
    const result = await runTeam({ store, team: 'cancel', signal: controller.signal, goals: [
      { id: 'a', member: 'worker', input: 'first' }, { id: 'b', member: 'worker', input: 'second', deps: ['a'] },
    ], makeWorker: () => async (node, { signal }) => {
      assert.equal(signal, controller.signal);
      calls.push(node.id); controller.abort(); return { ok: true, steps: 1 };
    } });
    assert.deepEqual(calls, ['a']);
    assert.deepEqual(store.loadCheckpoint('cancel', result.runId).done, {});
    assert.notEqual(result.status, 'complete');
  } finally { fs.rmSync(workspaceDir, { recursive: true, force: true }); }
});

test('graph: explanatory text cannot turn a failed tool action into success', async () => {
  const tool = createGraphTool({ runSubtask: async () => ({ answer: 'I tried', failure: 'write denied', tools: [] }) });
  const result = await runInTurn({ depth: 0 }, () => tool.execute({ steps: [
    { id: 'a', task: 'write the file' }, { id: 'b', task: 'publish the file', deps: ['a'] },
  ] }));
  assert.equal(result.ok, false);
  assert.equal(result.failed, 1);
  assert.equal(result.blocked, 1);
});
