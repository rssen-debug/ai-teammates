/**
 * V2 runtime foundation contract.
 * The point: a goal can only reach COMPLETED with verified evidence;
 * state transitions are strict; saved goals resume after a crash.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Goal, EvidenceRequired, IllegalTransitionSatisfied } from '../src/v2/runtime/goal.js';
import { STATES, canTransition } from '../src/v2/runtime/states.js';

const mkGoal = () => new Goal({
  objective: 'create index.html and preview it',
  acceptance: [
    { id: 'file', description: 'index.html' },
    { id: 'preview', description: 'http preview responds 200' },
  ],
  risk: 'low',
  permissions: ['workspace_write', 'process_launch'],
});

function driveToRunning(g) {
  g.transition('PLANNING', 'goal compiled');
  g.transition('READY', 'plan accepted');
  g.transition('RUNNING', 'executor started');
}

test('state machine: legal path CREATED -> PLANNING -> READY -> RUNNING; illegal hop rejected', () => {
  const g = mkGoal();
  assert.equal(g.state, 'CREATED');
  assert.throws(() => g.transition('RUNNING', 'skip planning'), /illegal transition CREATED -> RUNNING/);
  driveToRunning(g);
  assert.equal(g.state, 'RUNNING');
  assert.ok(canTransition('RUNNING', 'VERIFYING'));
  assert.ok(!canTransition('COMPLETED', 'RUNNING'));
});

test('terminal states are locked forever', () => {
  const g = mkGoal();
  g.transition('CANCELLED', 'owner said stop');
  assert.equal(g.state, 'CANCELLED');
  assert.throws(() => g.transition('RUNNING', 'try again'), /terminal state CANCELLED/);
});

test('actions only execute while RUNNING/RECOVERING/VERIFYING', () => {
  const g = mkGoal();
  assert.throws(() => g.addReceipt({ action: 'write_file', target: 'index.html', result: 'success' }), IllegalTransitionSatisfied);
  driveToRunning(g);
  const r = g.addReceipt({ action: 'write_file', target: 'index.html', result: 'success', acceptanceId: 'file' });
  assert.equal(r.verified, false, 'executor receipts never self-verify');
});

test('COMPLETED requires VERIFYING plus verified evidence for every acceptance item', () => {
  const g = mkGoal();
  driveToRunning(g);
  g.addReceipt({ action: 'write_file', target: 'index.html', result: 'success', acceptanceId: 'file' });
  const serve = g.addReceipt({ action: 'run_preview', target: 'http://127.0.0.1', result: 'success', acceptanceId: 'preview' });
  g.transition('WAITING_FOR_TOOL', 'preview started');
  g.transition('RUNNING', 'preview alive');
  assert.throws(() => g.complete(), /illegal transition/);
  g.transition('VERIFYING', 'system verifies');
  // Nothing verified yet -> EvidenceRequired, never silent completion
  assert.throws(() => g.complete(), EvidenceRequired);
  g.verifyReceipt(serve.id, { kind: 'http-check', status: 200 });
  g.uncoveredAcceptance(); // still 'file' untouched
  assert.throws(() => g.complete(), /acceptance without verified evidence: file/);
  return g;
});

test('verification replaces hash and preserves prevHash (tamper-evident chain)', () => {
  const g = mkGoal();
  driveToRunning(g);
  const r = g.addReceipt({ action: 'write_file', target: 'index.html', result: 'success' });
  const v = g.verifyReceipt(r.id, { kind: 'fs.readFileSync', size: 512 });
  assert.equal(v.verified, true);
  assert.equal(v.prevHash, r.hash);
  assert.notEqual(v.hash, r.hash);
  assert.equal(v.id, r.id, 'same action, same receipt id');
});

test('save -> crash -> resume restores goal, and work continues legally', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-goals-'));
  const g = mkGoal();
  driveToRunning(g);
  g.addReceipt({ action: 'write_file', target: 'index.html', result: 'success', acceptanceId: 'file' });
  const file = g.save(dir);
  // simulate total process death: fresh load from disk only
  const back = Goal.load(file);
  assert.equal(back.id, g.id);
  assert.equal(back.state, 'RUNNING');
  assert.equal(back.receipts.length, 1);
  back.transition('VERIFYING', 'resume: re-verify before completing');
  assert.equal(back.state, 'VERIFYING');
  const listed = Goal.list(dir);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, g.id);
});

test('a resumed terminal goal stays terminally locked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-goals-'));
  const g = mkGoal();
  g.transition('CANCELLED', 'owner stop');
  const back = Goal.load(g.save(dir));
  assert.throws(() => back.transition('RUNNING', 'revive'), /terminal state CANCELLED/);
});

test('full honest lifecycle: all acceptance verified, then complete', () => {
  const g = mkGoal();
  driveToRunning(g);
  const w = g.addReceipt({ action: 'write_file', target: 'index.html', result: 'success', acceptanceId: 'file' });
  const p = g.addReceipt({ action: 'run_preview', target: 'http://127.0.0.1/index.html', result: 'success', acceptanceId: 'preview' });
  g.verifyReceipt(w.id, { kind: 'fs.readFileSync', size: 9800 });
  g.verifyReceipt(p.id, { kind: 'http-check', status: 200 });
  g.transition('VERIFYING', 'verifier pass');
  assert.equal(g.uncoveredAcceptance().length, 0);
  g.complete();
  assert.equal(g.state, STATES.COMPLETED);
  assert.throws(() => g.transition('RUNNING', 'whoops'), /terminal state COMPLETED/);
});
