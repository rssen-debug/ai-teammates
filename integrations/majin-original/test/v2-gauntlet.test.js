/**
 * GAUNTLET contract: default scenario set completes with 100% verified success,
 * zero false successes, honest FAILED-state for the blocking scenario, and the
 * report carries its own murder-chain metrics (brief 42).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runGauntlet } from '../src/v2/gauntlet/gauntlet.js';
import { defaultScenarios } from '../src/v2/gauntlet/scenarios.js';

test('default gauntlet: all pass, zero false success, receipts prove outcomes', async () => {
  const report = await runGauntlet({ scenarios: defaultScenarios() });
  assert.equal(report.scenarios, 5);
  assert.equal(report.failed, 0);
  assert.equal(report.verifiedSuccessRate, 1);
  assert.equal(report.falseSuccessCount, 0);
  const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));
  assert.equal(byId.G1.completed, true);
  assert.equal(byId.G2.completed, true);
  assert.equal(byId.G3.verifiedReceipts >= 1, true, 'pixel proof verified');
  assert.equal(byId.G4.completed, true);
  assert.ok(byId.G4.graphSummary.done === 1, 'G4 recovered exactly the one task');
  assert.equal(byId.G5.goalState, 'FAILED', 'blocking scenario must end honestly failed');
  assert.equal(byId.G5.graphSummary.blocked, 1);
  assert.equal(byId.G5.completed, false, 'never "done" without evidence');
  for (const r of report.results) assert.ok(r.receipts > 0, `${r.id} must leave receipts`);
});
