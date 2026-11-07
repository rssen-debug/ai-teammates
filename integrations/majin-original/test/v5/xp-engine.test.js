import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MAX_LEVEL,
  MAX_TASK_XP_BUDGET,
  MIN_LEVEL,
  XP_TABLE,
  XpLedger,
  computeTaskXpAllocation,
  effectiveLevelForSkill,
  evaluateLevel99Gates,
  isVerifiedOutcomeReceipt,
  rawLevelForXp,
  variationMultiplier,
  xpForLevel,
} from '../../src/v5/xp-engine.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v5-xp-'));
}

test('XP_TABLE follows deterministic RuneScape-inspired curve from Level 1 (0 XP) to Level 99', () => {
  assert.equal(MIN_LEVEL, 1);
  assert.equal(MAX_LEVEL, 99);
  assert.equal(xpForLevel(1), 0);
  assert.ok(xpForLevel(2) > 0);
  assert.ok(xpForLevel(18) > xpForLevel(10));
  assert.ok(xpForLevel(50) > xpForLevel(18));
  assert.equal(xpForLevel(99), XP_TABLE[99]);

  for (let lvl = 1; lvl < 99; lvl += 1) {
    assert.ok(XP_TABLE[lvl + 1] > XP_TABLE[lvl], `Level ${lvl + 1} must require more XP than ${lvl}`);
    assert.equal(rawLevelForXp(XP_TABLE[lvl]), lvl);
  }
  assert.equal(rawLevelForXp(0), 1);
  assert.equal(rawLevelForXp(XP_TABLE[99] + 500_000), 99);
});

test('Level 99 quality gates cap effective level at 98 until all 5 gates are satisfied', () => {
  const recentIso = '2026-10-24T12:00:00Z';

  // Enough XP for 99, but missing quality gates -> capped at 98
  const incompleteSkill = {
    version: '1.0.0',
    xp: XP_TABLE[99] + 1000,
    qualityGates: { versionedTestSuitePassed: true, testSuiteVersion: '1.0.0' },
    distinctScenariosCount: 2, // < 5 distinct scenarios
    verifiedRecoveryCount: 0,
    lastVerifiedAt: recentIso,
    reliability: 1.0,
    freshness: 'FRESH',
  };
  const gateCheck1 = evaluateLevel99Gates(incompleteSkill);
  assert.equal(gateCheck1.passed, false);
  const eff1 = effectiveLevelForSkill(incompleteSkill);
  assert.equal(eff1.rawLevel, 99);
  assert.equal(eff1.level, 98);
  assert.equal(eff1.gatedAt98, true);

  // All 5 gates satisfied -> unlocks Level 99!
  const masteredSkill = {
    version: '1.0.0',
    xp: XP_TABLE[99],
    qualityGates: { versionedTestSuitePassed: true, testSuiteVersion: '1.0.0' },
    distinctScenariosCount: 5,
    verifiedRecoveryCount: 2,
    lastVerifiedAt: recentIso,
    reliability: 0.96,
    freshness: 'FRESH',
    masteryScope: {
      mastered: 'Semantic form filling with verified confirmation receipts.',
      limitations: 'Applies only to v1.0.0 requirements; never guarantees future unknown portals.',
    },
  };
  const eff2 = effectiveLevelForSkill(masteredSkill);
  assert.equal(eff2.gatedAt98, false);
  assert.equal(eff2.level, 99);
});

test('Anti-farming repetition decay and bounded primary/support XP allocation', () => {
  assert.equal(variationMultiplier(0), 1.0);
  assert.equal(variationMultiplier(1), 0.5);
  assert.equal(variationMultiplier(2), 0.25);
  assert.equal(variationMultiplier(3), 0.0);

  const alloc = computeTaskXpAllocation({
    receipts: [{ id: 'r1', kind: 'file', verified: true }],
    difficulty: 'standard',
    primarySkillId: 'browser.forms',
    supportSkillIds: ['documents.read', 'documents.upload'],
    priorSignatureCount: 0,
  });
  assert.equal(alloc.eligible, true);
  assert.ok(alloc.totalBudget <= MAX_TASK_XP_BUDGET, 'Must never exceed task XP budget cap');
  assert.ok(alloc.primaryXp > alloc.supportXpBySkill['documents.read']);
});

test('XpLedger rejects unverified receipts, enforces idempotency per receiptId, and survives restart & parallel writes', async () => {
  const dir = tmpDir();
  const ledger = new XpLedger({ dir });

  // 1. Rejects unverified claim
  const unverified = await ledger.recordVerifiedAward({
    receipts: [{ id: 'r-fake', kind: 'prose', verified: false }],
    goalId: 'g-1',
    primarySkillId: 'browser.forms',
  });
  assert.equal(unverified.awarded, false);
  assert.equal(unverified.reason, 'NO_VERIFIED_OUTCOME_RECEIPT');

  // 2. Awards XP once for a real verified receipt
  const validReceipt = {
    id: 'rcpt-real-1',
    receiptId: 'rcpt-real-1',
    kind: 'file',
    verifier: 'file',
    verified: true,
    sha256: 'abc123456789',
  };
  assert.equal(isVerifiedOutcomeReceipt(validReceipt), true);

  const firstAward = await ledger.recordVerifiedAward({
    receipts: [validReceipt],
    goalId: 'g-1',
    primarySkillId: 'browser.forms',
    supportSkillIds: ['documents.read'],
    difficulty: 'standard',
    taskSignature: 'form-fill-job-1',
  });
  assert.equal(firstAward.awarded, true);
  assert.ok(firstAward.totalXpAwarded > 0);

  // 3. Duplicate receiptId is strictly idempotent (0 additional XP)
  const duplicateAward = await ledger.recordVerifiedAward({
    receipts: [validReceipt],
    goalId: 'g-1',
    primarySkillId: 'browser.forms',
    supportSkillIds: ['documents.read'],
    difficulty: 'standard',
    taskSignature: 'form-fill-job-1',
  });
  assert.equal(duplicateAward.awarded, false);
  assert.equal(duplicateAward.reason, 'DUPLICATE_RECEIPT');
  assert.equal(duplicateAward.totalXpAwarded, 0);

  // 4. Parallel writes and restart safety
  await Promise.all(
    Array.from({ length: 6 }, (_, idx) =>
      ledger.recordVerifiedAward({
        receipts: [
          {
            id: `rcpt-parallel-${idx}`,
            receiptId: `rcpt-parallel-${idx}`,
            kind: 'file',
            verifier: 'file',
            verified: true,
            sha256: `sha-${idx}`,
          },
        ],
        goalId: `g-par-${idx}`,
        primarySkillId: 'browser.forms',
        difficulty: 'standard',
        taskSignature: `unique-sig-${idx}`,
      }),
    ),
  );

  // Reload from disk to verify persistence after restart
  const reloaded = new XpLedger({ dir });
  const entries = reloaded.readEntries();
  const seenIds = new Set(entries.map((e) => e.receiptId));
  assert.equal(seenIds.has('rcpt-real-1'), true);
  for (let idx = 0; idx < 6; idx += 1) {
    assert.equal(seenIds.has(`rcpt-parallel-${idx}`), true);
  }
});
