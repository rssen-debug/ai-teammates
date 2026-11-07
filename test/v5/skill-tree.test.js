import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MATURITY_STATUS, SkillTree, assertAcyclicDependencies } from '../../src/v5/skill-tree.js';
import { SkillBuilder, validateSynthesizedCode } from '../../src/v5/skill-builder.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v5-skills-'));
}

test('SkillTree initializes canonical taxonomy starting untrained at Level 1 (0 XP) and validates cycle-free DAG', () => {
  const dir = tmpDir();
  const tree = new SkillTree({ dir });
  const skills = tree.list();

  assert.ok(skills.length >= 6);
  const kinds = new Set(skills.map((s) => s.kind));
  assert.equal(kinds.has('skill'), true);
  assert.equal(kinds.has('workflow'), true);

  for (const sk of skills) {
    assert.equal(sk.level, 1, `Built-in skill ${sk.canonical_id} must start at Level 1`);
    assert.equal(sk.xp, 0, `Built-in skill ${sk.canonical_id} must start at 0 XP`);
    assert.equal(sk.maturity_status, MATURITY_STATUS.UNTRAINED);
  }

  // Cycle-free dependency DAG validation
  assert.throws(() => {
    const depMap = new Map([
      ['a.one', ['b.two']],
      ['b.two', ['a.one']],
    ]);
    assertAcyclicDependencies(depMap);
  }, /Dependency cycle detected/i);

  assert.throws(() => {
    tree.resolveOrRegisterSkill({
      canonical_id: 'cycle.self',
      display_name: 'Self Cycle',
      dependencies: ['cycle.self'],
    });
  }, /Dependency cycle detected/i);
});

test('SkillTree deduplicates candidates, merges skills without double-counting XP, and tracks STALE state separately from historical level', async () => {
  const dir = tmpDir();
  const tree = new SkillTree({ dir });

  // 1. Candidate evaluation detects alias / intent / contract match and reuses existing skill
  const evalDup = tree.resolveOrRegisterSkill({
    display_name: 'upload-cv',
    purpose: 'Upload a verified local document (such as a CV) to an external portal',
    required_tools: ['browser.upload'],
    verification_method: 'http_or_dom_receipt',
  });
  assert.equal(evalDup.action, 'reused');
  assert.equal(evalDup.skill.canonical_id, 'documents.upload');

  // 2. Register a secondary skill, award verified XP to both with one shared receipt and one unique receipt
  const createdAlt = tree.resolveOrRegisterSkill({
    canonical_id: 'browser.forms-alt',
    display_name: 'Unique Custom Form Handler',
    domain: 'browser',
    purpose: 'Specialized custom handler for legacy forms',
    required_tools: ['browser.open', 'browser.form_fill', 'browser.custom_legacy'],
    verification_method: 'dom_state',
  });
  assert.equal(createdAlt.action, 'created');

  const sharedReceipt = {
    id: 'rcpt-shared-1',
    receiptId: 'rcpt-shared-1',
    kind: 'http',
    verifier: 'http',
    verified: true,
    sha256: 'sha-shared-1',
  };

  await tree.recordVerifiedSuccess({
    goalId: 'g-1',
    receipts: [sharedReceipt],
    primarySkillId: 'browser.forms',
    difficulty: 'complex',
    taskSignature: 'sig-1',
    envFingerprint: 'env-v1',
  });
  const xpBeforeMerge = tree.get('browser.forms').xp;
  assert.ok(xpBeforeMerge > 0);

  // Add the same sharedReceipt + 1 new unique receipt to `browser.forms-alt` and merge
  const altSkill = tree.get('browser.forms-alt');
  altSkill.verification_history.push(
    { eventId: 'ev-shared', receiptId: 'rcpt-shared-1', goalId: 'g-1', xp: 36, at: new Date().toISOString() },
    { eventId: 'ev-unique', receiptId: 'rcpt-unique-2', goalId: 'g-2', xp: 24, at: new Date().toISOString() },
  );

  const proposal = tree.proposeMerge('browser.forms', 'browser.forms-alt');
  assert.equal(proposal.canMerge, true);

  const merged = tree.mergeSkills('browser.forms', 'browser.forms-alt', { force: true });
  assert.equal(merged.xp, xpBeforeMerge + 24, 'Shared receipt must never be double-counted on merge');
  assert.equal(tree.skills.has('browser.forms-alt'), false, 'Merged source skill is removed from canonical map');
  assert.equal(tree.get('browser.forms-alt').canonical_id, 'browser.forms', 'Source ID is preserved as an alias on target');

  // 3. Environment or origin change marks skill STALE without erasing XP or level
  const affected = tree.checkEnvironmentFreshness({ currentEnvFingerprint: 'env-v2-changed' });
  assert.ok(affected.includes('browser.forms'));
  const afterStale = tree.get('browser.forms');
  assert.equal(afterStale.freshness, 'STALE');
  assert.equal(afterStale.maturity_status, MATURITY_STATUS.STALE);
  assert.equal(afterStale.xp, merged.xp, 'Historical XP must be preserved when STALE');
});

test('SkillBuilder synthesizes, validates, sandbox-tests, and registers a new Python 3 skill and blocks unsafe code', async () => {
  const dir = tmpDir();
  const tree = new SkillTree({ dir });
  const builder = new SkillBuilder({ dataDir: dir, skillTree: tree });

  // 1. Unsafe code is rejected before execution
  const unsafeCheck = validateSynthesizedCode('import os\nos.system("rm -rf /")');
  assert.equal(unsafeCheck.valid, false);

  // 2. Synthesize a real Python 3 salary normalizer skill
  const builtPy = await builder.synthesizeSkill({
    name: 'salary-normalizer-py',
    displayName: 'Lönenormaliserare (Python)', // input vocabulary, never rendered
    domain: 'career',
    purpose: 'Normalisera löneintervall och valuta med Python 3', // input vocabulary, never rendered
    runtime: 'python',
    testInput: {
      operation: 'normalize_salary',
      data: { monthlySek: 48000, currency: 'SEK' },
    },
  });

  assert.equal(builtPy.ok, true, `Python skill synthesis failed: ${builtPy.reason}`);
  assert.equal(fs.existsSync(builtPy.scriptPath), true);
  assert.equal(builtPy.selfTestReceipt.verified, true);
  assert.equal(builtPy.skill.level, 1, 'Newly synthesized skill must start at Level 1 (0 XP)');
  assert.equal(builtPy.skill.xp, 0);
});
