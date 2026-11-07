import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GrandArchitect } from '../../src/v5/architect.js';
import { createDelegationTool } from '../../src/v5/adaptive-delegation.js';

const tasks = [
  { id: 'alpha', task: 'Read alpha.txt and report its observed content.' },
  { id: 'beta', task: 'Read beta.txt and report its observed content.' },
  { id: 'gamma', task: 'Read gamma.txt and report its observed content.' },
];
const reason = 'Each independent source can be read without any result from another worker.';

async function fixture(t, completeImpl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-adaptive-delegation-'));
  const architect = new GrandArchitect({ dataDir: root, completeImpl });
  await architect.providers.configureProvider({ providerId: 'opencode-go', apiKey: 'local-test-key', discover: false });
  architect.providers.selectModel({ providerId: 'opencode-go', modelId: 'deepseek-v4-pro', allowManualFallback: true });
  architect.files.enableOwnerMode({ lanes: ['files', 'shell', 'browser'], folders: [architect.workspaceDir] });
  for (const name of ['alpha', 'beta', 'gamma']) fs.writeFileSync(path.join(architect.workspaceDir, `${name}.txt`), `${name}-independent-proof`);
  const goal = { goal_id: 'fixture-goal', cost: { modelCalls: 0, inputTokens: 0, outputTokens: 0 } };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = (extra = {}) => ({ architect, goal, grantedLanes: architect.files.describeAccessState().grantedLanes,
    allowedFolders: architect.files.describeAccessState().grantedFolders, ...extra });
  return { root, architect, goal, options };
}

const sourceName = messages => /Read (\w+)\.txt/.exec(messages.find(message => message.role === 'user').content)[1];
const readCall = name => ({ content: '', toolCalls: [{ id: 'read', name: 'fs_read', args: { path: `${name}.txt` } }], usage: { input: 10, output: 5 } });

test('independent workers use real confined file tools, separate sessions and bounded concurrency; persisted completed observations resume without calls', async t => {
  let active = 0; let maxActive = 0; const sessions = new Set(); const sourceSessions = new Map(); const calls = [];
  const { root, goal, architect, options } = await fixture(t, async ({ messages, tools, provider }) => {
    active++; maxActive = Math.max(maxActive, active);
    const name = sourceName(messages);
    const session = provider.headers['x-opencode-session']; sessions.add(session);
    assert.equal(sourceSessions.get(name) || session, session); sourceSessions.set(name, session);
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['documents_extract', 'fs_list', 'fs_read', 'fs_search']);
    calls.push(name);
    await new Promise(resolve => setTimeout(resolve, 30)); active--;
    const observation = messages.find(message => message.role === 'tool');
    if (!observation) return readCall(name);
    assert.match(observation.content, new RegExp(`${name}-independent-proof`));
    return { content: `Observed ${name}-independent-proof`, usage: { input: 20, output: 10, costUsd: 0.01 } };
  });
  const checkpointFile = path.join(root, 'goal-checkpoint.json');
  const tool = createDelegationTool(options({ onCheckpoint: () => fs.writeFileSync(checkpointFile, JSON.stringify(goal)) }));
  const result = await tool.run({ tasks, reason });
  assert.equal(result.status, 'COMPLETED'); assert.equal(result.verified, false); assert.equal(result.trusted, false);
  assert.ok(maxActive >= 2 && maxActive <= 3, `workers must overlap but never exceed the cap of three, saw ${maxActive}`); assert.equal(sessions.size, 3);
  assert.equal(goal.cost.modelCalls, 6); assert.equal(goal.cost.toolCalls, 3);
  assert.equal(goal.cost.inputTokens, 90); assert.equal(goal.cost.outputTokens, 45); assert.equal(goal.cost.reportedUsd, 0.03);
  assert.equal(goal.tool_results.length, 3);
  assert.deepEqual(goal.tool_results.map(row => row.delegatedTaskId).sort(), ['alpha', 'beta', 'gamma']);
  assert(goal.tool_results.every(row => row.delegated && row.status === 'completed' && row.argKeys.join() === 'path' && !('args' in row)));
  for (const outcome of result.tasks) {
    assert.equal(outcome.tools.length, 1); assert.equal(outcome.tools[0].ok, true); assert.equal(outcome.verified, false);
    assert.equal(outcome.cost.modelCalls, 2); assert(outcome.elapsedMs >= 0);
  }
  const restored = JSON.parse(fs.readFileSync(checkpointFile));
  const cached = await createDelegationTool({ ...options(), goal: restored }).run({ tasks, reason });
  assert.equal(calls.length, 6); assert(cached.tasks.every(task => task.cached)); assert.equal(restored.cost.modelCalls, 6);
  assert.equal(restored.tool_results.length, 3, 'cached results do not create duplicate tool evidence');
  assert.equal(fs.readFileSync(path.join(architect.workspaceDir, 'alpha.txt'), 'utf8'), 'alpha-independent-proof');
});

test('worker host refuses unadvertised writes and recursion even with owner grants, without treating a failure as verified', async t => {
  const { architect, goal, options } = await fixture(t, async ({ messages }) => ({ content: '', toolCalls: [{ id: 'escape',
    name: sourceName(messages) === 'alpha' ? 'fs_write' : 'agent_delegate', args: { path: 'forbidden.txt', content: 'bad' } }] }));
  const result = await createDelegationTool(options()).run({ tasks: tasks.slice(0, 2), reason });
  assert.equal(result.status, 'PARTIAL'); assert.equal(result.verified, false);
  assert(result.tasks.every(task => task.status === 'FAILED' && task.errorCode === 'DELEGATION_TOOL_DENIED'));
  assert.equal(fs.existsSync(path.join(architect.workspaceDir, 'forbidden.txt')), false);
  assert.equal(goal.cost.toolCalls || 0, 0);
  await assert.rejects(createDelegationTool(options()).run({ tasks: [tasks[0], tasks[0]], reason }), /unique/);
  await assert.rejects(createDelegationTool(options()).run({ tasks, reason, grant: ['shell'] }));
});

test('abort joins workers, caches completed observations and resumes only interrupted read tasks from fresh sessions', async t => {
  const controller = new AbortController(); let interrupt = true; const calls = { alpha: 0, beta: 0 };
  const { goal, options } = await fixture(t, async ({ messages, signal }) => {
    const name = sourceName(messages); calls[name]++;
    if (name === 'beta' && interrupt) {
      await new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new Error('aborted'));
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    const observation = messages.find(message => message.role === 'tool');
    return observation ? { content: `Observed ${name}`, usage: { input: 1, output: 1 } } : readCall(name);
  });
  const result = await createDelegationTool(options({ signal: controller.signal, onCheckpoint: () => {
    if (Object.values(goal.delegation?.tasks || {}).some(task => task.id === 'alpha' && task.status === 'COMPLETED')) controller.abort();
  } })).run({ tasks: tasks.slice(0, 2), reason });
  assert.equal(result.status, 'CANCELLED');
  assert.equal(result.tasks.find(task => task.id === 'alpha').status, 'COMPLETED');
  assert.equal(result.tasks.find(task => task.id === 'beta').status, 'CANCELLED');
  const snapshot = JSON.stringify(goal); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(JSON.stringify(goal), snapshot, 'no late worker mutates checkpoints after cancellation returns');
  const alphaCalls = calls.alpha;
  interrupt = false;
  const resumed = await createDelegationTool(options()).run({ tasks: tasks.slice(0, 2), reason });
  assert.equal(resumed.status, 'COMPLETED'); assert.equal(calls.alpha, alphaCalls);
  assert(resumed.tasks.find(task => task.id === 'alpha').cached);
  assert.notEqual(resumed.tasks.find(task => task.id === 'beta').sessionId, result.tasks.find(task => task.id === 'beta').sessionId);
});

test('three workers truly overlap on a barrier, six tasks complete in waves, and lifecycle events stream', async t => {
  let active = 0; let maxActive = 0; let barrierHit = false; let release;
  const streamFlags = [];
  const barrier = new Promise((resolve) => { release = resolve; });
  const { architect, options } = await fixture(t, async ({ messages, stream, onEvent }) => {
    streamFlags.push(stream === true && typeof onEvent === 'function');
    const name = sourceName(messages);
    if (messages.find((message) => message.role === 'tool')) {
      onEvent?.({ type: 'delta', text: `Observed ${name} part one\n` });
      onEvent?.({ type: 'delta', text: `Observed ${name} part two` });
      return { content: `Observed ${name}`, usage: { input: 1, output: 1 } };
    }
    active += 1; maxActive = Math.max(maxActive, active);
    if (active === 3) { barrierHit = true; release(); }
    await Promise.race([barrier, new Promise((resolve) => setTimeout(resolve, 8000))]);
    active -= 1;
    return readCall(name);
  });
  for (const name of ['delta', 'epsilon', 'zeta']) {
    fs.writeFileSync(path.join(architect.workspaceDir, `${name}.txt`), `${name}-independent-proof`);
  }
  const six = [...tasks,
    { id: 'delta', task: 'Read delta.txt and report its observed content.' },
    { id: 'epsilon', task: 'Read epsilon.txt and report its observed content.' },
    { id: 'zeta', task: 'Read zeta.txt and report its observed content.' }];
  const events = [];
  const tool = createDelegationTool(options({ onEvent: (type, fields) => events.push({ type, ...fields }) }));
  const result = await tool.run({ tasks: six, reason });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(barrierHit, true, 'three workers must be inside provider calls at the same time');
  assert.equal(maxActive, 3);
  assert.equal(result.concurrency, 3);
  assert.equal(events[0].type, 'delegate_batch_started');
  assert.deepEqual(events[0].tasks, six.map((task) => task.id));
  assert.ok(streamFlags.length > 0 && streamFlags.every(Boolean), 'every worker provider call must opt into streaming events');
  assert.equal(events.filter((event) => event.type === 'delegate_task_started').length, 6);
  const deltas = events.filter((event) => event.type === 'delegate_model_output_delta');
  assert.equal(deltas.length, 12);
  assert.deepEqual([...new Set(deltas.map((event) => event.taskId))].sort(), six.map((task) => task.id).sort());
  assert.ok(deltas.every((event) => event.text.includes(`Observed ${event.taskId}`)));
  assert.equal(events.filter((event) => event.type === 'delegate_task_finished' && event.status === 'COMPLETED').length, 6);
  assert.equal(events.at(-1).type, 'delegate_batch_finished');
  await assert.rejects(tool.run({ tasks: [...six, { id: 'eta', task: 'Read eta.txt and report its observed content.' }], reason }));
});

test('delegates advertise only granted read-only tools, including sys, re and jobs observers', async t => {
  let advertised = [];
  const { architect, options } = await fixture(t, async ({ tools }) => {
    advertised = tools.map((tool) => tool.name);
    return { content: 'Observed without needing tools', usage: { input: 1, output: 1 } };
  });
  architect.files.enableOwnerMode({ lanes: ['files', 'sys', 're', 'jobs'], folders: [architect.workspaceDir] });
  const result = await createDelegationTool(options()).run({ tasks: tasks.slice(0, 2), reason });
  assert.equal(result.status, 'COMPLETED');
  for (const name of ['fs_read', 'sys_info', 're_hash', 'jobs_match']) {
    assert.ok(advertised.includes(name), `${name} must be offered to granted read-only workers: ${advertised}`);
  }
  for (const name of ['fs_write', 'shell_run', 'jobs_search', 'jobs_send', 'browser_open', 'agent_delegate']) {
    assert.ok(!advertised.includes(name), `${name} must never be offered to read-only workers`);
  }
});

test('revoked permissions prevent any worker call, and six-round limits stop unresolved subtasks', async t => {
  let calls = 0;
  const { architect, options } = await fixture(t, async ({ messages }) => {
    calls++;
    return { toolCalls: [{ id: `read-${calls}`, name: 'fs_read', args: { path: `${sourceName(messages)}.txt` } }] };
  });
  const saved = options();
  architect.files.revokePermissions({ lanes: ['shell', 'browser'] });
  await assert.rejects(createDelegationTool(saved).run({ tasks: tasks.slice(0, 2), reason }), /permissions changed/);
  assert.equal(calls, 0);
  const result = await createDelegationTool(options()).run({ tasks: tasks.slice(0, 2), reason });
  assert.equal(calls, 12); assert(result.tasks.every(task => task.status === 'FAILED' && /six-round/.test(task.summary)));
});
