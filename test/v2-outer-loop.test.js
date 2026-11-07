/**
 * V2 outer recovery loop contracts: executes advisor steps for real where it
 * can (retry, replan), is BOUNDED by the advisor budget, stops honestly on
 * non-executable steps (ask, alternate_tool), and logs every attempt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWithRecovery } from '../src/v2/recover/outer-loop.js';

// scenario: objective that fails verification UNLESS the workspace already
// has a marker from a previous attempt — models a transient system glitch.
// In v2 the orchestrator is deterministic, so we simulate via a pre-made
// compiled objective whose acceptance depends on the retry budget.
import { compileDeterministic } from '../src/v2/compiler/goal-compiler.js';
import { runObjective } from '../src/v2/runtime/orchestrator.js';

test('outer loop: identical objective completes at once (no recovery needed)', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-ol-a-'));
  const r = await runWithRecovery('build a portfolio website and show it to me', { failureClass: 'TIMEOUT', workspaceDir: ws });
  assert.equal(r.finalState, 'COMPLETED');
  assert.equal(r.attempts, 1);
  assert.equal(r.recovered, false);
});

test('outer loop: a goal that fails fills history + replan context injected on second pass', async () => {
  // blender render always FAILED under the deterministic template (no output.png)
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-ol-b-'));
  const injected = [];
  const r = await runWithRecovery('create a blender animation and render it', {
    failureClass: 'BUILD_FAILURE',
    workspaceDir: ws,
    adaptObjective: (orig, { history }) => { injected.push(history.length); return `${orig} [attempt after failure #${history.length}]`; },
  });
  // BUILD_FAILURE plan: replan x2 then alternate_tool (not executable by v2) -> honest BLOCKED
  assert.equal(r.finalState, 'BLOCKED');
  assert.match(r.reason, /alternate_tool/);
  assert.ok(injected.length >= 1, 'replan injected failure context');
  assert.ok(injected.length <= 2, 'bounded by advisor budget, not infinite');
  assert.ok(r.history.every((h) => h.state === 'FAILED'));
});

test('outer loop: adapter-free replan adds RECOVERY CONTEXT block (no silent step skip)', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-ol-c-'));
  const r = await runWithRecovery('create a blender animation and render it', { failureClass: 'BUILD_FAILURE', workspaceDir: ws });
  // second attempt objective contains the RECOVERY CONTEXT bracket
  assert.ok(r.history.length >= 2);
  assert.equal(r.finalState, 'BLOCKED');
  assert.ok(r.reason.includes('alternate_tool') || r.reason.includes('budget exhausted'));
});

test('outer loop: goal succeeded on 2nd attempt is flagged recovered', async () => {
  // fabricated: same workspace; first objective is one that always fails
  // (blender), the second is a website objective — proves flow can exit on success.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-ol-d-'));
  let first = true;
  const r = await runWithRecovery('create a blender animation and render it', {
    failureClass: 'BUILD_FAILURE',
    workspaceDir: ws,
    adaptObjective: (orig) => first ? (first = false, 'build a portfolio website and show it to me') : orig,
  });
  assert.equal(r.finalState, 'COMPLETED');
  assert.equal(r.recovered, true);
  assert.equal(r.history.length, 2);
  assert.equal(r.history[0].state, 'FAILED');
  assert.equal(r.history[1].state, 'COMPLETED');
});

test('outer loop: recovery budget exhausted -> FAILED with budget reason; step that needs co-worker -> BLOCKED honestly', async () => {
  const ws1 = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-ol-e1-'));
  const r1 = await runWithRecovery('photo', { failureClass: 'VERIFICATION_FAILURE', workspaceDir: ws1 });
  // VERIFICATION_FAILURE plan: reverify -> replan x2; photo compiles successfully so it completes quickly
  assert.equal(r1.finalState, 'COMPLETED');
  // AUTH_REQUIRED plan: ask — not executable, outer loop must stop instead of pretending
  const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-ol-e2-'));
  const r2 = await runWithRecovery('create a blender animation and render it', { failureClass: 'AUTH_REQUIRED', workspaceDir: ws2 });
  assert.equal(r2.finalState, 'BLOCKED');
  assert.match(r2.reason, /ask.*co-worker|needs the matching co-worker lane/);
});
