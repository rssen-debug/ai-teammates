import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureAdaptiveState, chooseAdaptiveMode, createAdaptiveTools, markAdaptiveSteering, recordAdaptiveTransition } from '../../src/v5/adaptive-policy.js';

function fixture() {
  const goal = { goal_id: 'adaptive-test', status: 'RUNNING', criteria: [{ kind: 'file', path: 'report.txt', contains: 'verified' }],
    tool_results: [{ tool: 'fs_read', operationId: 'observed-read', ok: true }, { tool: 'fs_write', operationId: 'observed-write', ok: true },
      { tool: 'fs_read', operationId: 'failed-read', ok: false }, { tool: 'agent_plan', operationId: 'plan-only', ok: true }] };
  let saves = 0;
  const tools = createAdaptiveTools({ goal, onCheckpoint: () => { saves++; } });
  return { goal, plan: args => tools.get('agent_plan').run(args), checkpoint: args => tools.get('agent_checkpoint').run(args), saves: () => saves };
}

test('adaptive policy uses observed signals without treating unrelated procedural memory as a match', () => {
  assert.equal(chooseAdaptiveMode({ objective: 'Read the file' }).mode, 'direct');
  assert.equal(chooseAdaptiveMode({ objective: 'Prepare a report', criteria: [{}, {}] }).mode, 'plan');
  assert.equal(chooseAdaptiveMode({ objective: 'Read inputs then compile a report' }).mode, 'plan');
  const procedures = [{ name: 'report-procedure', summary: 'Compile research comparison', verifiedUses: 2 }];
  assert.equal(chooseAdaptiveMode({ objective: 'Compile a research comparison', procedures }).mode, 'skill');
  assert.equal(chooseAdaptiveMode({ objective: 'Create a new image', procedures }).mode, 'direct');
  assert.equal(chooseAdaptiveMode({ objective: 'Compile a research comparison', procedures: [{ ...procedures[0], verifiedUses: 0 }] }).mode, 'direct');
  assert.equal(chooseAdaptiveMode({ adaptiveState: { recoveryPending: true } }).mode, 'recover');
  assert.equal(chooseAdaptiveMode({ adaptiveState: { unresolvedVerificationFailures: 1 } }).mode, 'recover');
  assert.equal(chooseAdaptiveMode({ adaptiveState: { verificationFailures: 4, unresolvedVerificationFailures: 0 } }).mode, 'direct');
});

test('dependency plans accept unordered DAGs and reject duplicate, unknown and cyclic edges without changing persisted state', () => {
  const f = fixture();
  f.plan({ steps: [{ id: 'write', task: 'Write report', dependsOn: ['read'] }, { id: 'read', task: 'Read inputs' }] });
  assert.deepEqual(chooseAdaptiveMode({ adaptiveState: f.goal.adaptive }).readyStepIds, ['read']);
  const before = JSON.stringify(f.goal.adaptive);
  for (const steps of [
    [{ id: 'a', task: 'A', dependsOn: ['missing'] }],
    [{ id: 'a', task: 'A', dependsOn: ['b'] }, { id: 'b', task: 'B', dependsOn: ['a'] }],
    [{ id: 'a', task: 'A' }, { id: 'a', task: 'B' }],
  ]) assert.throws(() => f.plan({ steps }));
  assert.equal(JSON.stringify(f.goal.adaptive), before);
  assert.equal(f.saves(), 1);
});

test('checkpoints require actual work observations and cannot declare acceptance or bypass dependencies', () => {
  const f = fixture(); f.plan({ steps: [{ id: 'read', task: 'Read inputs' }, { id: 'write', task: 'Write report', dependsOn: ['read'] }] });
  assert.throws(() => f.checkpoint({ stepId: 'write', state: 'RUNNING' }), /dependencies/);
  for (const operationIds of [[], ['invented'], ['failed-read'], ['plan-only']])
    assert.throws(() => f.checkpoint({ stepId: 'read', state: 'OBSERVED', operationIds }));
  assert.throws(() => f.checkpoint({ stepId: 'read', state: 'OBSERVED', operationIds: ['observed-read'], verified: true }));
  const result = f.checkpoint({ stepId: 'read', state: 'OBSERVED', operationIds: ['observed-read'] });
  assert.equal(result.independentlyVerified, false); assert.deepEqual(result.readyStepIds, ['write']);
  assert.equal(f.goal.status, 'RUNNING'); assert.equal(f.goal.verification_evidence, undefined);
  assert.throws(() => f.checkpoint({ stepId: 'read', state: 'PENDING' }), /cannot be reset/);
  assert.equal(f.checkpoint({ stepId: 'read', state: 'OBSERVED', operationIds: ['observed-read'] }).step.attempts, 1);
});

test('delegation requires two ready steps declaring both independence and delegation, and stops on failure', () => {
  const f = fixture();
  const steps = [{ id: 'a', task: 'Inspect source A', independent: true, delegateable: true }, { id: 'b', task: 'Inspect source B', independent: true, delegateable: false }];
  f.plan({ steps }); assert.equal(chooseAdaptiveMode({ adaptiveState: f.goal.adaptive }).mode, 'plan');
  steps[1].delegateable = true; steps[1].dependsOn = ['a'];
  f.plan({ steps }); assert.equal(chooseAdaptiveMode({ adaptiveState: f.goal.adaptive }).mode, 'plan');
  steps[1].dependsOn = []; f.plan({ steps });
  const result = chooseAdaptiveMode({ adaptiveState: f.goal.adaptive });
  assert.equal(result.mode, 'delegate'); assert.deepEqual(result.delegateStepIds, ['a', 'b']);
  f.checkpoint({ stepId: 'a', state: 'FAILED', operationIds: ['failed-read'] });
  assert.equal(chooseAdaptiveMode({ adaptiveState: f.goal.adaptive }).mode, 'recover');
});

test('restart and steering preserve observed work but changed dependencies invalidate descendant completion', () => {
  const f = fixture(); const steps = [{ id: 'read', task: 'Read inputs' }, { id: 'write', task: 'Write report', dependsOn: ['read'] }];
  f.plan({ steps }); f.checkpoint({ stepId: 'read', state: 'OBSERVED', operationIds: ['observed-read'] });
  f.checkpoint({ stepId: 'write', state: 'OBSERVED', operationIds: ['observed-write'] });
  const reconstructed = JSON.parse(JSON.stringify(f.goal));
  reconstructed.adaptive.failureFingerprints = ['host-owned-fingerprint'];
  const tools = createAdaptiveTools({ goal: reconstructed });
  markAdaptiveSteering(reconstructed);
  assert.equal(chooseAdaptiveMode({ adaptiveState: reconstructed.adaptive }).mode, 'plan');
  assert.throws(() => tools.get('agent_checkpoint').run({ stepId: 'read', state: 'OBSERVED', operationIds: ['observed-read'] }), /steering/);
  tools.get('agent_plan').run({ steps: [...steps, { id: 'publish', task: 'Prepare final delivery', dependsOn: ['write'] }] });
  assert.deepEqual(reconstructed.adaptive.plan.map(step => step.state), ['OBSERVED', 'OBSERVED', 'PENDING']);
  assert.deepEqual(ensureAdaptiveState(reconstructed).failureFingerprints, ['host-owned-fingerprint']);
  tools.get('agent_plan').run({ steps: [{ ...steps[0], task: 'Read different inputs' }, steps[1]] });
  assert.deepEqual(reconstructed.adaptive.plan.map(step => step.state), ['PENDING', 'PENDING']);
  assert.equal(reconstructed.adaptive.observedHistory.length, 2);
  assert.equal(reconstructed.adaptive.observedHistory[1].operationIds[0], 'observed-write');
});

test('failed-step retries remain bounded across plan refreshes and policy transition logs are bounded', () => {
  const f = fixture(); const steps = [{ id: 'read', task: 'Read inputs' }]; f.plan({ steps });
  for (let attempt = 0; attempt < 3; attempt++) {
    f.checkpoint({ stepId: 'read', state: 'FAILED', operationIds: ['failed-read'] });
    f.checkpoint({ stepId: 'read', state: 'PENDING' });
  }
  f.plan({ steps });
  assert.throws(() => f.checkpoint({ stepId: 'read', state: 'RUNNING' }), /retry limit/);
  recordAdaptiveTransition(f.goal, { mode: 'recover', reason: 'Observed failure' });
  recordAdaptiveTransition(f.goal, { mode: 'recover', reason: 'Observed failure' });
  assert.equal(f.goal.adaptive.transitions.length, 1);
  for (let i = 0; i < 70; i++) recordAdaptiveTransition(f.goal, { mode: 'plan', reason: 'Decision ' + i });
  assert.equal(f.goal.adaptive.transitions.length, 64);
  assert.equal(f.goal.adaptive.reason, 'Decision 69');
});

test('multiple checks on the same artifact do not create a needless dependency plan', () => {
  assert.equal(chooseAdaptiveMode({ objective: 'Draft an application', criteria: [
    { kind: 'file', path: 'letter.md', contains: 'Applicant' },
    { kind: 'file', path: 'letter.md', contains: 'Technical Consultant' },
  ] }).mode, 'direct');
  assert.equal(chooseAdaptiveMode({ objective: 'Prepare outputs', criteria: [
    { kind: 'file', path: 'letter.md' }, { kind: 'file', path: 'cv.md' },
  ] }).mode, 'plan');
});
