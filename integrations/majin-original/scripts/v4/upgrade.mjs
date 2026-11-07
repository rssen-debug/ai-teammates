#!/usr/bin/env node
/**
 * MAJIN V4 — upgrade this checkout to origin/v4/main with automatic rollback.
 *
 *   npm run v4:upgrade            real run
 *   npm run v4:upgrade -- --dry   show the plan, touch nothing
 *
 * Gates: install -> doctor -> tests -> matrix. If any gate fails the checkout is
 * returned to the previous commit and dependencies are reinstalled.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upgrade, GATES, UpgradeError } from '../../src/v4/upgrade.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dry = process.argv.includes('--dry');

function line(text = '') {
  process.stdout.write(`${text}\n`);
}

if (dry) {
  line('');
  line('  MAJIN V4 upgrade — plan only');
  line(`  repo    ${repo}`);
  line('  steps   git fetch -> checkout origin/v4/main -> ' + GATES.map((g) => g.id).join(' -> '));
  line('  failure any step -> checkout the previous commit -> npm ci');
  line('');
  line('  nothing was changed.');
  line('');
  process.exit(0);
}

const runner = (argv, opts = {}) => {
  line(`  $ ${argv.join(' ')}`);
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd: opts.cwd || repo,
    timeout: opts.timeoutMs || 120_000,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.status !== 0) {
    const err = (res.stderr || '').trim().split('\n').slice(-3).join(' ');
    if (err) line(`      ! ${err.slice(0, 200)}`);
  }
  return { code: res.status ?? 1, stdout: res.stdout || '', stderr: res.stderr || '' };
};

line('');
line('  MAJIN V4 upgrade');
line(`  repo ${repo}`);
line('');

let result;
try {
  result = await upgrade({
    repo,
    target: 'origin/v4/main',
    run: runner,
    log: (event, detail) => line(`  [${event}] ${JSON.stringify(detail)}`),
  });
} catch (err) {
  line('');
  if (err instanceof UpgradeError) {
    line(`  STOPPED (${err.code})`);
    for (const detail of String(err.message).split('\n')) line(`  ${detail}`);
    line('');
    line('  Nothing was changed by this run.');
    line('');
    process.exitCode = 1;
  } else {
    throw err;
  }
  process.exit(process.exitCode ?? 1);
}

line('');
switch (result.status) {
  case 'UP_TO_DATE':
    line(`  Already at ${result.previousSha.slice(0, 7)}. Nothing to do.`);
    break;
  case 'UPGRADED':
    line(`  Upgraded ${result.previousSha.slice(0, 7)} -> ${result.newSha.slice(0, 7)}.`);
    line(`  To undo: ${result.rollbackCommand}`);
    line('  The checkout is detached at that commit on purpose: an upgrade must not');
    line('  move a branch pointer, and a failed gate can then be undone exactly.');
    line('  To work on the branch again: git checkout v4/main && git reset --hard ' + result.newSha.slice(0, 7));
    break;
  case 'ROLLED_BACK':
    line(`  Gate "${result.failedGate}" failed. Rolled back to ${result.previousSha.slice(0, 7)}.`);
    line(`  Dependencies reinstalled: ${result.restored ? 'yes' : 'NO — run npm ci'}`);
    if (result.reason) line(`  ${result.reason}`);
    line('  The host is on the last commit that passed. Start it again when ready.');
    break;
  case 'ESCALATE':
  default:
    line(`  ROLLBACK FAILED. The working tree is on ${result.newSha?.slice(0, 7)} with a failing gate.`);
    line('  Intervene by hand before starting the host again.');
    break;
}
line('');
process.exitCode = ['UP_TO_DATE', 'UPGRADED', 'ROLLED_BACK'].includes(result.status) ? 0 : 1;
