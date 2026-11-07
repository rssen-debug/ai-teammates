#!/usr/bin/env node
/**
 * W14 rollback CLI: the honest gate against an already-recorded install manifest.
 *   node scripts/rollback.mjs --check                     # dry plan, refuses loudly without a usable target
 *   node scripts/rollback.mjs --apply --restorer=<none>   # requires an injected platform restorer; without one it REFUSES
 * (The windows installer flow calls into this module with a real restorer.)
 */
import path from 'node:path';
import { planRollback, rollbackLedger } from '../src/core/update-rollback.js';

const dir = path.resolve(process.argv.find((a) => a.startsWith('--dir='))?.split('=')[1] || process.cwd());
const mode = process.argv.includes('--apply') ? 'apply' : 'check';
try {
  const plan = planRollback(dir, { currentVersion: process.argv.find((a) => a.startsWith('--from='))?.split('=')[1] || null });
  process.stdout.write(`rollback plan: ${plan.from} -> ${plan.to}\n  artifact: ${plan.backupFile}\n  sha256:   ${plan.sha256.slice(0, 20)}… (${plan.bytes} bytes)\n  refused candidates: ${plan.refused.map((r) => `${r.version}:${r.reason}`).join(', ') || 'none'}\n`);
  if (mode === 'apply') {
    process.stderr.write(`apply REFUSES here: no platform restorer injected (windows installer flow owns that hook). The plan above is proven; executing it without the platform hook would be a story, not a rollback.\n`);
    process.exitCode = 3;
  }
  const ev = rollbackLedger(dir);
  if (ev.length) process.stdout.write(`ledger: ${ev.length} rollback event(s), last at ${ev.at(-1).at}\n`);
} catch (e) {
  process.stderr.write(`rollback ${mode} refused: ${e.message}\n`);
  process.exitCode = 1;
}
