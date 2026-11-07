/**
 * A crash can land the goal in any state a turn passes through.
 *
 * `reconcileOnBoot` only handled RUNNING and VERIFYING. A host that died while a
 * tool was executing left the goal in WAITING_FOR_TOOL, and one that died while
 * waiting for the owner's approval left WAITING_FOR_APPROVAL. Neither was
 * touched on boot, and `resumeGoal` only accepts BLOCKED/RECOVERING — so those
 * goals were unreachable forever: not running, not failed, not resumable.
 *
 * The reconciliation must also respect the V2 state machine: WAITING_FOR_TOOL
 * has no direct exit to BLOCKED, so it is routed through RECOVERING.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Goal } from '../../src/v2/runtime/goal.js';
import { STATES } from '../../src/v2/runtime/states.js';
import { GoalStore, ConversationStore } from '../../src/v4/store.js';
import { tempHome } from './helpers.mjs';

/** Save a goal that died in `state`, the way a crash would leave it. */
function goalIn(dir, state) {
  const goal = new Goal({ objective: `dog i ${state}`, acceptance: [{ id: 'a1', description: 'x' }] });
  goal.transition('PLANNING', 'setup');
  goal.transition('READY', 'setup');
  goal.transition('RUNNING', 'setup');
  if (state === STATES.WAITING_FOR_TOOL) goal.transition(STATES.WAITING_FOR_TOOL, 'tool');
  if (state === STATES.WAITING_FOR_APPROVAL) {
    goal.transition(STATES.WAITING_FOR_TOOL, 'tool');
    goal.transition(STATES.RUNNING, 'consent');
    goal.transition(STATES.WAITING_FOR_APPROVAL, 'consent');
  }
  if (state === STATES.VERIFYING) {
    goal.transition(STATES.WAITING_FOR_TOOL, 'tool');
    goal.transition(STATES.RUNNING, 'done');
    goal.transition(STATES.VERIFYING, 'check');
  }
  goal.save(dir);
  return goal;
}

test('crash: a goal stuck in WAITING_FOR_TOOL becomes BLOCKED on boot', () => {
  const home = tempHome();
  const dir = path.join(home, 'goals');
  const goal = goalIn(dir, STATES.WAITING_FOR_TOOL);
  const store = new GoalStore({ dir });
  const reconciled = store.reconcileOnBoot();
  assert.ok(reconciled.includes(goal.id), `not reconciled: ${JSON.stringify(reconciled)}`);
  assert.equal(store.get(goal.id).state, STATES.BLOCKED);
  fs.rmSync(home, { recursive: true, force: true });
});

test('crash: a goal stuck in WAITING_FOR_APPROVAL becomes BLOCKED on boot', () => {
  const home = tempHome();
  const dir = path.join(home, 'goals');
  const goal = goalIn(dir, STATES.WAITING_FOR_APPROVAL);
  const store = new GoalStore({ dir });
  const reconciled = store.reconcileOnBoot();
  assert.ok(reconciled.includes(goal.id));
  assert.equal(store.get(goal.id).state, STATES.BLOCKED);
  fs.rmSync(home, { recursive: true, force: true });
});

test('crash: RUNNING and VERIFYING still become BLOCKED (the original contract)', () => {
  const home = tempHome();
  const dir = path.join(home, 'goals');
  const running = goalIn(dir, STATES.RUNNING);
  const verifying = goalIn(dir, STATES.VERIFYING);
  const store = new GoalStore({ dir });
  const reconciled = store.reconcileOnBoot();
  assert.ok(reconciled.includes(running.id));
  assert.ok(reconciled.includes(verifying.id));
  assert.equal(store.get(running.id).state, STATES.BLOCKED);
  assert.equal(store.get(verifying.id).state, STATES.BLOCKED);
  fs.rmSync(home, { recursive: true, force: true });
});

test('crash: a pre-execution goal is cancelled, because no work had started', () => {
  const home = tempHome();
  const dir = path.join(home, 'goals');
  const goal = new Goal({ objective: 'dog i PLANNING', acceptance: [] });
  goal.transition('PLANNING', 'setup');
  goal.save(dir);
  const store = new GoalStore({ dir });
  store.reconcileOnBoot();
  const after = store.get(goal.id).state;
  // PLANNING has a legal exit to BLOCKED; either terminal-ish state is honest,
  // but it must not stay PLANNING forever.
  assert.ok([STATES.BLOCKED, STATES.CANCELLED].includes(after), `still ${after}`);
  fs.rmSync(home, { recursive: true, force: true });
});

test('crash: a finished goal is left exactly as it was', () => {
  const home = tempHome();
  const dir = path.join(home, 'goals');
  const goal = new Goal({ objective: 'klar', acceptance: [] });
  goal.transition('PLANNING', 'x');
  goal.transition('READY', 'x');
  goal.transition('RUNNING', 'x');
  goal.transition('VERIFYING', 'x');
  goal.complete();
  goal.save(dir);
  const store = new GoalStore({ dir });
  store.reconcileOnBoot();
  assert.equal(store.get(goal.id).state, STATES.COMPLETED);
  fs.rmSync(home, { recursive: true, force: true });
});

test('crash: a pending approval for a dead turn is cleared, so the UI stops asking', () => {
  const home = tempHome();
  const goalsDir = path.join(home, 'goals');
  const convDir = path.join(home, 'conversations');
  const goal = goalIn(goalsDir, STATES.WAITING_FOR_APPROVAL);

  const conversations = new ConversationStore({ dir: convDir });
  const conv = conversations.create({ title: 'dog' });
  conv.pendingApproval = { turnId: 'turn_x', goalId: goal.id, tool: 'workspace_write', input: {}, scope: 'tool:workspace_write' };
  conversations.save(conv);

  const store = new GoalStore({ dir: goalsDir });
  const result = store.reconcileOnBoot({ conversations });
  assert.equal(result.clearedApprovals, 1, 'one orphaned approval was cleared');

  const cleared = new ConversationStore({ dir: convDir }).get(conv.id);
  assert.equal(cleared.pendingApproval, null, 'a prompt for a turn that no longer exists must not survive a restart');
  fs.rmSync(home, { recursive: true, force: true });
});

test('crash: a reconciled goal can be resumed afterwards', async () => {
  const home = tempHome();
  const dir = path.join(home, 'goals');
  const goal = goalIn(dir, STATES.WAITING_FOR_TOOL);
  const store = new GoalStore({ dir });
  store.reconcileOnBoot();
  const reconciled = store.get(goal.id);
  // the whole point of BLOCKED is that resume accepts it
  assert.doesNotThrow(() => reconciled.transition(STATES.RUNNING, 'owner requested resume'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('crash: a boot with interrupted goals announces them on the console', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const home = tempHome();
  goalIn(path.join(home, 'v4', 'goals'), STATES.WAITING_FOR_TOOL);

  const out = spawnSync(process.execPath, [path.join(root, 'src/v4/main.js'), '--port', '39871'], {
    cwd: root,
    env: { ...process.env, MAJIN_HOME: home, MAJIN_V4_PROVIDER: 'demo' },
    encoding: 'utf8',
    timeout: 12_000,
  });
  const all = `${out.stdout}${out.stderr}`;
  assert.match(all, /BLOCKED efter omstart|marked BLOCKED/i, `boot did not report the reconciled goal:\n${all.slice(0, 800)}`);
  fs.rmSync(home, { recursive: true, force: true });
});
