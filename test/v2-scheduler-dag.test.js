/**
 * V2 DAG + scheduler contract: dependency order, bounded concurrency,
 * retries within class policy, failure propagation, and JSON round-trip.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskGraph, CycleError, TASK_STATES } from '../src/v2/runtime/dag.js';
import { runGraph } from '../src/v2/runtime/scheduler.js';
import { Goal } from '../src/v2/runtime/goal.js';
import { normalizeError, FAILURE_CLASSES } from '../src/v2/runtime/errors.js';

const mkGoal = () => {
  const g = new Goal({ objective: 'build site', acceptance: [{ id: 'ok', description: 'graph done' }] });
  g.transition('PLANNING'); g.transition('READY'); g.transition('RUNNING');
  return g;
};

test('dag: cycle detection and unknown deps are build-time failures', () => {
  const g = new TaskGraph({ goalId: 'goal_x' });
  g.addTask({ id: 'a', action: 'x' });
  assert.throws(() => g.addTask({ id: 'b', action: 'x', deps: ['missing'] }), /unknown task/);
  g.addTask({ id: 'b', action: 'x', deps: ['a'] });
  assert.throws(() => g.addTask({ id: 'a2', action: 'x', deps: ['a2'] }), CycleError);
});

test('dag: readySet follows DONE deps; block-policy stops descendants', () => {
  const g = new TaskGraph({ goalId: 'goal_x' });
  g.addTask({ id: 'root', action: 'r' });
  g.addTask({ id: 'mid', action: 'm', deps: ['root'] });
  g.addTask({ id: 'leaf', action: 'l', deps: ['mid'] });
  assert.deepEqual(g.readySet(), ['root']);
  g.markState('root', TASK_STATES.FAILED);
  assert.deepEqual(g.propagateFailure('root'), ['mid', 'leaf']);
  assert.ok(g.isExhausted());
});

test('dag: JSON round-trip preserves task states (resume)', () => {
  const g = new TaskGraph({ goalId: 'goal_x' });
  g.addTask({ id: 'a', action: 'x' });
  g.markState('a', TASK_STATES.DONE);
  const back = TaskGraph.fromJSON(g.toJSON());
  assert.equal(back.tasks.get('a').state, TASK_STATES.DONE);
  assert.deepEqual(back.readySet(), []);
});

test('scheduler: dependencies order, all tasks receipted on the goal', async () => {
  const goal = mkGoal();
  const graph = new TaskGraph({ goalId: goal.id });
  graph.addTask({ id: 'research', action: 'research' });
  graph.addTask({ id: 'build', action: 'build', deps: ['research'] });
  graph.addTask({ id: 'test', action: 'test', deps: ['build'] });
  const order = [];
  const { summary } = await runGraph({
    goal, graph, concurrency: 4,
    execute: async (t) => { order.push(t.id); return { result: 'success', evidence: { ok: true } }; },
  });
  assert.deepEqual(order, ['research', 'build', 'test']);
  assert.equal(summary.done, 3);
  assert.equal(goal.receipts.length, 3, 'one receipt per executed task');
  assert.equal(goal.receipts[0].result, 'success');
});

test('scheduler: concurrency never exceeds its ceiling', async () => {
  const goal = mkGoal();
  const graph = new TaskGraph({ goalId: goal.id });
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) graph.addTask({ id, action: 'w' });
  let active = 0; let maxActive = 0;
  await runGraph({
    goal, graph, concurrency: 2,
    execute: async () => {
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 25));
      active -= 1;
      return { result: 'success' };
    },
  });
  assert.ok(maxActive <= 2, `max active was ${maxActive}`);
});

test('scheduler: transient failure retries once to DONE (classification-driven)', async () => {
  const goal = mkGoal();
  const graph = new TaskGraph({ goalId: goal.id });
  graph.addTask({ id: 'flaky', action: 'net-op', maxAttempts: 2 });
  let seen = 0;
  const { summary } = await runGraph({
    goal, graph,
    execute: async () => {
      seen += 1;
      if (seen === 1) { const e = new Error('ECONNRESET broken'); e.code = 'ECONNRESET'; throw e; }
      return { result: 'success' };
    },
  });
  assert.equal(seen, 2, 'retried exactly once');
  assert.equal(summary.done, 1);
  assert.equal(summary.failed, 0);
  assert.equal(goal.receipts.length, 2);
  assert.equal(goal.receipts[0].errorClass, 'NETWORK_FAILURE');
});

test('scheduler: permanent class blocks dependents without retry storm', async () => {
  const goal = mkGoal();
  const graph = new TaskGraph({ goalId: goal.id });
  graph.addTask({ id: 'build', action: 'build', maxAttempts: 5 });
  graph.addTask({ id: 'deploy', action: 'deploy', deps: ['build'] });
  let attempts = 0;
  const { summary } = await runGraph({
    goal, graph,
    execute: async (t) => {
      if (t.id === 'build') {
        attempts += 1;
        const e = new Error('SyntaxError in index.js'); e.cls = 'BUILD_FAILURE'; throw e;
      }
      return { result: 'success' };
    },
  });
  assert.equal(attempts, 1, 'BUILD_FAILURE policy = no retry');
  assert.equal(summary.failed, 1);
  assert.equal(summary.blocked, 1, 'deploy blocked');
  assert.equal(goal.receipts.length, 1, 'deploy never ran, no receipt');
});

test('errors: normalizeError collapses real error shapes to classes', () => {
  assert.equal(normalizeError(Object.assign(new Error('boom'), { code: 'ETIMEDOUT' })).detail.cls, 'TIMEOUT');
  assert.equal(normalizeError(new Error('HTTP 429 too many')).detail.cls, 'MODEL_RATE_LIMIT');
  assert.equal(normalizeError(new Error('EACCES: permission denied')).detail.cls, 'PERMISSION_DENIED');
  assert.ok(FAILURE_CLASSES.includes(normalizeError(new Error('???')).detail.cls));
});
