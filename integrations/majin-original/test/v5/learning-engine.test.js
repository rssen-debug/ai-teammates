import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SkillTree } from '../../src/v5/skill-tree.js';
import { LearningEngine, parameterizeStep } from '../../src/v5/learning-engine.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v5-learning-'));
}

test('duplicate receipt delivery persists a prior failed save without increasing verified uses', async t => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tree = new SkillTree({ dir });
  const engine = new LearningEngine({ dataDir: dir, skillTree: tree });
  const payload = { goalId: 'durable-goal', goalText: 'Write verified output',
    trace: [{ tool: 'fs_write', ok: true, argKeys: ['path', 'content'] }],
    receipts: [{ id: 'durable-receipt', kind: 'file', verifier: 'file', verified: true, sha256: 'abc123' }] };
  const save = engine.save.bind(engine);
  engine.save = () => { throw new Error('disk failure'); };
  await assert.rejects(engine.learnFromVerifiedGoal(payload), /disk failure/);
  engine.save = save;
  await engine.learnFromVerifiedGoal(payload);
  const reloaded = new LearningEngine({ dataDir: dir, skillTree: tree });
  assert.equal(reloaded.state.procedures.length, 1);
  assert.equal(reloaded.state.procedures[0].verifiedUses, 1);
  assert.equal((await reloaded.learnFromVerifiedGoal(payload)).duplicate, true);
  assert.equal(reloaded.state.procedures[0].provenance.length, 1);
});

test('LearningEngine sanitizes secrets and personal CV data, parameterizes procedures, and never escalates permissions', async () => {
  const dir = tmpDir();
  const tree = new SkillTree({ dir });
  const engine = new LearningEngine({ dataDir: dir, skillTree: tree });

  // 1. Parameterized procedure step extraction replaces concrete values with typed slots
  const step1 = parameterizeStep({
    tool: 'document_read',
    ok: true,
    args: { path: '/home/user/cv-anna.pdf', query: 'senior engineer' },
  });
  assert.equal(step1.parameters.path, '{{file_path}}');
  assert.equal(step1.parameters.query, '{{search_query}}');

  // 2. Learn from a verified goal and verify permission intersection (no privilege escalation)
  const learned = await engine.learnFromVerifiedGoal({
    goalId: 'goal-learn-1',
    goalText: 'Fill job application for anna@example.com with key sk-1234567890abcdefghijklmnop',
    trace: [
      { tool: 'document_read', ok: true, argKeys: ['path'], args: { path: '/tmp/cv.pdf' } },
      { tool: 'browser.fill', ok: true, argKeys: ['selector', 'value'], args: { selector: '#name', value: 'Anna' } },
    ],
    receipts: [
      {
        id: 'rcpt-learn-1',
        receiptId: 'rcpt-learn-1',
        kind: 'file',
        verifier: 'file',
        verified: true,
        sha256: 'deadbeef1234',
      },
    ],
    primarySkillId: 'browser.forms',
    supportSkillIds: ['documents.read'],
    grantedLanes: ['files'], // 'system_admin' NOT granted
    usedLanes: ['files', 'system_admin'], // attempted to claim 'system_admin'
  });

  assert.equal(learned.learned, true);
  assert.deepEqual(learned.requiredLanes, ['files'], 'Learned skill must never escalate beyond grantedLanes');

  // Verify raw learned-procedures.json on disk contains zero secrets or PII
  const rawLearnedDisk = fs.readFileSync(path.join(dir, 'learned-procedures.json'), 'utf8');
  assert.doesNotMatch(rawLearnedDisk, /sk-1234567890/);
  assert.doesNotMatch(rawLearnedDisk, /anna@example\.com/);
});

test('LearningEngine attributes failures to the specific step/arg fingerprint and NEVER blocks an entire tool for bad arguments', () => {
  const dir = tmpDir();
  const tree = new SkillTree({ dir });
  const engine = new LearningEngine({ dataDir: dir, skillTree: tree });

  const badArgs = { path: '/nonexistent/broken/path.pdf', mode: 'strict' };
  const goodArgs = { path: '/workspace/valid-cv.pdf', mode: 'normal' };

  // Record a step failure caused by bad arguments on `document_read`
  const recorded = engine.recordStepFailure({
    goalId: 'goal-fail-1',
    skillId: 'documents.read',
    stepIndex: 0,
    tool: 'document_read',
    args: badArgs,
    failureClass: 'INVALID_ARGUMENT',
    penalizeSkill: false,
  });

  assert.equal(recorded.toolBlocked, false, 'Whole tool must NEVER be blocked for bad arguments');
  assert.equal(recorded.scopedAvoidRecorded, true);

  // Calling `document_read` with the exact same bad args is avoided
  const checkBad = engine.checkToolCallAllowed('document_read', badArgs);
  assert.equal(checkBad.allowed, false);
  assert.equal(checkBad.code, 'LEARNED_SCOPED_AVOID');
  assert.equal(checkBad.rule.entireToolBlocked, false);

  // Calling `document_read` with different (valid) args MUST still be allowed!
  const checkGood = engine.checkToolCallAllowed('document_read', goodArgs);
  assert.equal(checkGood.allowed, true, 'Tool must remain usable with valid arguments');

  // Verify 4-layer separation (procedural learning, user memory, verification history, model training)
  const layers = engine.describeKnowledgeSeparation();
  assert.equal(layers.proceduralLearning.kind, 'procedural_learning');
  assert.equal(layers.userMemory.kind, 'user_memory');
  assert.equal(layers.verificationHistory.kind, 'verification_history');
  assert.equal(layers.modelTraining.weightsTrained, false);
});
