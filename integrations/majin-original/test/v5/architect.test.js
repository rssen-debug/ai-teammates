import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GrandArchitect, TASK_STATUS } from '../../src/v5/architect.js';
import { computeDotMatrixState } from '../../src/v5/ui/dot-matrix.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v5-arch-'));
}

test('GrandArchitect vertical chain: provider selection -> goal -> file -> skill -> tool -> independent verification -> XP -> 99-dot matrix state', async () => {
  const dir = tmpDir();
  const architect = new GrandArchitect({
    dataDir: dir,
    completeImpl: async () => ({
      content: 'Sidan är byggd och verifierad.', // input vocabulary, never rendered
      usage: { prompt_tokens: 120, completion_tokens: 45, costUsd: 0.0012 },
    }),
  });

  // 1. Configure OpenCode Go provider & select model
  await architect.providers.configureProvider({
    providerId: 'opencode-go',
    apiKey: 'oc_sk_vertical_test',
    discover: false,
  });
  architect.providers.selectModel({
    providerId: 'opencode-go',
    modelId: 'glm-5.3-flash',
    allowManualFallback: true,
  });

  // 2. Enable Owner Mode for files
  architect.files.enableOwnerMode({
    lanes: ['files'],
    folders: [dir, architect.workspaceDir],
  });

  // 3. Create an input brief file
  const briefPath = path.join(architect.workspaceDir, 'brief.txt');
  fs.writeFileSync(briefPath, 'Bygg en landningssida med rubrik MAJIN V5.', 'utf8'); // input vocabulary, never rendered

  // 4. Execute goal through the full vertical chain
  const goalState = await architect.executeGoal({
    goalText: 'Bygg och verifiera en landningssida från brief.txt', // input vocabulary, never rendered
    files: [{ path: briefPath }],
    actions: [
      {
        id: 'build-html',
        tool: 'workspace_write',
        args: {
          file: 'index.html',
          content: '<!doctype html><html><body><h1>MAJIN V5</h1></body></html>',
        },
      },
    ],
    useDag: true,
  });

  assert.equal(goalState.status, TASK_STATUS.COMPLETED);
  assert.ok(goalState.verification_evidence.length >= 2, 'Must have file read + file write verified receipts');
  assert.equal(goalState.xp_award.awarded, true);
  assert.ok(goalState.xp_award.totalXpAwarded > 0);
  assert.equal(goalState.cost.modelCalls, 1);
  assert.equal(goalState.cost.inputTokens, 120);

  // 5. Verify 99-dot matrix state updates from real skill progression
  const updatedSkill = architect.skillTree.get(goalState.used_skills.primary_skill);
  assert.ok(updatedSkill.xp > 0);
  assert.ok(['TRAINING', 'VERIFIED', 'REUSABLE'].includes(updatedSkill.maturity_status));

  const dotState = computeDotMatrixState({
    skillId: updatedSkill.canonical_id,
    displayName: updatedSkill.display_name,
    level: updatedSkill.level,
    xp: updatedSkill.xp,
    lastXpGain: goalState.xp_award.totalXpAwarded,
    freshness: updatedSkill.freshness,
    maturityStatus: updatedSkill.maturity_status,
  });
  assert.equal(dotState.totalDots, 99);
  assert.equal(dotState.learningVerifiedSignal, true);
  assert.match(dotState.tickerText, /\+\d+ XP/);
});

test('GrandArchitect strictly separates COMPLETED, PARTIAL, FAILED, BLOCKED, CANCELLED, and WAITING_USER and never treats unverified prose as COMPLETED', async () => {
  const dir = tmpDir();
  const architect = new GrandArchitect({
    dataDir: dir,
    completeImpl: async () => ({
      content: 'Jag lovar att allt är helt klart!', // input vocabulary, never rendered
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    }),
  });
  architect.providers.selectModel({
    providerId: 'opencode-go',
    modelId: 'glm-5.3-flash',
    allowManualFallback: true,
  });

  // 1. Model claims "klart!" and a tool returns ok:true, but ZERO verified outcome receipts exist -> PARTIAL, never COMPLETED!
  const unverifiedGoal = await architect.executeGoal({
    goalText: 'Gör något utan verifieringskvitto', // input vocabulary, never rendered
    actions: [
      {
        id: 'step-unverified',
        tool: 'unverified.echo',
        result: { text: 'unverified output' },
      },
    ],
  });
  assert.equal(unverifiedGoal.status, TASK_STATUS.PARTIAL, 'Unverified tool/model output must NEVER be marked COMPLETED');
  assert.equal(unverifiedGoal.xp_award.awarded, false);

  // 2. BLOCKED status (e.g. CAPTCHA or MFA)
  const blockedGoal = await architect.executeGoal({
    goalText: 'Skicka in ansökan bakom BankID', // input vocabulary, never rendered
    blocker: { kind: 'MFA', message: 'BankID signering krävs av användaren' }, // input vocabulary, never rendered
  });
  assert.equal(blockedGoal.status, TASK_STATUS.BLOCKED);

  // 3. WAITING_USER status
  const waitingGoal = await architect.executeGoal({
    goalText: 'Radera gamla utkast', // input vocabulary, never rendered
    requireUserConfirmation: { question: 'Vill du radera 3 filer?' }, // input vocabulary, never rendered
  });
  assert.equal(waitingGoal.status, TASK_STATUS.WAITING_USER);

  // 4. FAILED status
  const failedGoal = await architect.executeGoal({
    goalText: 'Kör trasigt verktyg', // input vocabulary, never rendered
    actions: [
      {
        id: 'step-fail',
        tool: 'broken.tool',
        failWith: { code: 'TOOL_CRASH', message: 'Connection refused' },
      },
    ],
  });
  assert.equal(failedGoal.status, TASK_STATUS.FAILED);

  // 5. CANCELLED status & late-response epoch fencing
  const oldEpoch = architect.runEpoch;
  const cancelledGoal = architect.cancelGoal(failedGoal.goal_id);
  assert.equal(cancelledGoal.status, TASK_STATUS.CANCELLED);

  let callbackRan = false;
  const lateRes = architect.receiveAsyncCallback({
    epoch: oldEpoch,
    goalId: failedGoal.goal_id,
    callback: () => { callbackRan = true; },
  });
  assert.equal(lateRes.accepted, false);
  assert.equal(lateRes.staleRunIgnored, true);
  assert.equal(callbackRan, false, 'Late response from aborted epoch must be fenced out');
});

test('GrandArchitect synthesizes a missing skill on the fly via SkillBuilder and supports checkpoint resume without repeating completed steps', async () => {
  const dir = tmpDir();
  const architect = new GrandArchitect({ dataDir: dir });

  const goalWithSynthesis = await architect.executeGoal({
    goalText: 'Normalisera konsultarvode med en ny Python-skill', // input vocabulary, never rendered
    synthesizeMissingSkill: {
      force: true,
      name: 'rate-calculator',
      displayName: 'Arvodeskalkylator', // input vocabulary, never rendered
      domain: 'career',
      purpose: 'Beräkna timpris och månadsarvode via Python', // input vocabulary, never rendered
      runtime: 'python',
      testInput: { operation: 'calc_rate', data: { hourlySek: 1150, hours: 160 } },
    },
  });

  assert.equal(goalWithSynthesis.status, TASK_STATUS.COMPLETED, goalWithSynthesis.error);
  assert.equal(goalWithSynthesis.used_skills.primary_skill, 'career.rate-calculator');
  assert.equal(goalWithSynthesis.xp_award.awarded, true);

  // Checkpoint resume test: step 1 already verified in checkpoint is skipped on resume!
  const g1 = await architect.executeGoal({
    goalText: 'Tvåstegsjobb med checkpoint', // input vocabulary, never rendered
    actions: [
      {
        id: 'step-1',
        tool: 'workspace_write',
        args: { file: 'step1.txt', content: 'step 1 verified' },
      },
    ],
  });
  assert.equal(g1.status, TASK_STATUS.COMPLETED);
  assert.equal(g1.checkpoints.length, 1);

  // Now resume the same goal with step-1 (already checkpointed) + step-2 (new)
  const resumed = await architect.resumeGoal({
    goalId: g1.goal_id,
    actions: [
      {
        id: 'step-1',
        tool: 'workspace_write',
        args: { file: 'step1.txt', content: 'step 1 verified' },
      },
      {
        id: 'step-2',
        tool: 'workspace_write',
        args: { file: 'step2.txt', content: 'step 2 verified' },
      },
    ],
  });
  assert.equal(resumed.queued_steps[0].status, 'SKIPPED_CHECKPOINTED');
  assert.equal(resumed.queued_steps[1].status, 'COMPLETED');
});
