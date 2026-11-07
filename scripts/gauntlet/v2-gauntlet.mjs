#!/usr/bin/env node
/**
 * MAJIN GAUNTLET CLI — runs the deterministic local scenario set, writes the
 * report under docs/v2/gauntlet/ and exits nonzero when any scenario fails or
 * a false success slips through (brief 42: false success must be zero).
 */
import { runGauntlet } from '../../src/v2/gauntlet/gauntlet.js';
import { defaultScenarios } from '../../src/v2/gauntlet/scenarios.js';
import { objectiveScenarios } from '../../src/v2/gauntlet/scenarios-objectives.js';

const OUT = new URL('../../docs/v2/gauntlet/', import.meta.url).pathname;
const report = await runGauntlet({ scenarios: [...defaultScenarios(), ...objectiveScenarios()], outDir: OUT });

console.log('MAJIN GAUNTLET');
console.log(`  scenarios:        ${report.scenarios}`);
console.log(`  passed:           ${report.passed}`);
console.log(`  failed:           ${report.failed}`);
console.log(`  verified success: ${(report.verifiedSuccessRate * 100).toFixed(0)}%`);
console.log(`  false successes:  ${report.falseSuccessCount}`);
for (const r of report.results) {
  console.log(`  - ${r.id} ${r.title}: ${r.pass ? 'PASS' : 'FAIL'} (${r.goalState}${r.reason ? ', ' + r.reason : ''})`);
}

process.exit(report.failed === 0 && report.falseSuccessCount === 0 ? 0 : 1);
