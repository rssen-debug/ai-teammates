#!/usr/bin/env node
/**
 * MAJIN V4 — set the approval policy from the terminal.
 *
 *   npm run v4:approvals                 show the current policy
 *   npm run v4:approvals -- auto         full permission: never ask
 *   npm run v4:approvals -- ask          ask before a held tool runs
 *
 * The same stored decision the app's Godkännanden panel writes, so the two can
 * never disagree. This exists because finding a checkbox on a phone is a poor
 * prerequisite for a setting the owner already decided he wants.
 */
import path from 'node:path';
import { loadConfig } from '../../src/v4/config.js';
import {
  APPROVAL_POLICIES, readApprovalPolicy, writeApprovalPolicy,
} from '../../src/v4/approval-policy.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const wanted = args[0] ? String(args[0]).toLowerCase() : null;
const config = loadConfig({ argv: process.argv.slice(2) });
const file = path.join(config.paths.root, 'approvals.json');

function line(text = '') {
  process.stdout.write(`${text}\n`);
}

if (!wanted) {
  const current = readApprovalPolicy(file);
  line('');
  line('MAJIN V4 — godkännanden');
  line('='.repeat(52));
  line(`  läge: ${current === APPROVAL_POLICIES.AUTO ? 'FULL BEHÖRIGHET (frågar aldrig)' : 'frågar innan känsliga verktyg'}`);
  line(`  fil:  ${file}`);
  line('');
  line('  Ändra:');
  line('    npm run v4:approvals -- auto    full behörighet, frågar aldrig');
  line('    npm run v4:approvals -- ask     fråga innan hållna verktyg körs');
  line('');
  process.exit(0);
}

if (wanted !== APPROVAL_POLICIES.AUTO && wanted !== APPROVAL_POLICIES.ASK) {
  process.stderr.write(`okänt läge "${wanted}" — använd "auto" eller "ask"\n`);
  process.exit(2);
}

writeApprovalPolicy(file, wanted);
line('');
if (wanted === APPROVAL_POLICIES.AUTO) {
  line('  FULL BEHÖRIGHET på.');
  line('  MAJIN frågar inte längre innan den använder ett verktyg du gett behörighet för.');
  line('  Varje automatiskt godkänt anrop loggas fortfarande.');
  line('');
  line('  Viktigt: MAJIN kan nu använda allt du godkänt utan att fråga — även om det blir fel.');
  line('  Stäng av med: npm run v4:approvals -- ask');
} else {
  line('  MAJIN frågar igen innan ett hållet verktyg körs.');
}
line('');
line('  En värld som redan kör plockar upp ändringen vid nästa verktygsanrop —');
line('  ingen omstart behövs.');
line('');
