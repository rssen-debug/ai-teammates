#!/usr/bin/env node
/**
 * MAJIN V4 — read the telemetry ledger.
 *
 *   node scripts/v4/logs.mjs            summary of the last 7 days
 *   node scripts/v4/logs.mjs --days 30  wider window
 *   node scripts/v4/logs.mjs --raw 20   the last 20 raw rows
 *   node scripts/v4/logs.mjs --json     machine output
 *
 * Aggregation is V2's (`src/v2/telemetry/aggregate.js`); the presentation is
 * V4's own, because V2's renderer titles the report for V2.
 *
 * What is NOT in these logs, by construction: message text, file contents,
 * absolute paths, provider keys. V2's ledger serializer drops any field outside
 * its per-event allowlist, so this command cannot print what was never written.
 */
import path from 'node:path';
import { loadConfig } from '../../src/v4/config.js';
import { aggregate } from '../../src/v2/telemetry/aggregate.js';
import { readShards, shardFiles } from '../../src/v2/telemetry/aggregate.js';

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(name);

const config = loadConfig();
const dir = path.join(config.paths.root, 'telemetry');
const days = Number(value('--days', 7)) || 7;

function line(text = '') {
  process.stdout.write(`${text}\n`);
}

if (flag('--raw')) {
  const n = Number(value('--raw', 20)) || 20;
  const rows = readShards(shardFiles(dir, { lastDays: days }));
  for (const row of rows.slice(-n)) line(JSON.stringify(row));
  line('');
  line(`  ${Math.min(n, rows.length)} of ${rows.length} row(s) from ${dir}`);
  line('');
  process.exit(0);
}

const report = aggregate(dir, { lastDays: days });

if (flag('--json')) {
  process.stdout.write(`${JSON.stringify({ dir, days, ...report }, null, 2)}\n`);
  process.exit(0);
}

const pct = (n) => `${Math.round((n || 0) * 1000) / 10}%`;
line('');
line(`MAJIN V4 telemetry — ${report.from || 'no data'}..${report.to || '-'} (${report.events} events)`);
line('='.repeat(64));
if (!report.events) {
  line('  No events yet. Run the host and send one message.');
  line(`  Ledger: ${dir}`);
  line('');
  process.exit(0);
}
line(`  goals      ${report.goals.count} finished, ${report.goals.completed} completed (${pct(report.goals.completedRate)})`);
line(`  duration   p50 ${report.goals.durationMsP50 ?? '-'}ms  p75 ${report.goals.durationMsP75 ?? '-'}ms  p95 ${report.goals.durationMsP95 ?? '-'}ms`);
line(`  receipts   ${Math.round(report.goals.verifiedReceiptsAvg * 10) / 10} verified per goal on average`);
line(`  models     ${report.models.callCount} call(s), ${report.models.tokenTotal} tokens`);
for (const [name, v] of Object.entries(report.models.byProvider)) {
  line(`             ${name}: ${v.calls} call(s), ${v.tokens} tokens`);
}
line(`  verify     ${report.verification.count} check(s), ${pct(report.verification.successRate)} passed`);
const classes = Object.entries(report.failureClasses);
if (classes.length) {
  line('  failures');
  for (const [cls, n] of classes.sort((a, b) => b[1] - a[1])) line(`             ${cls}: ${n}`);
}
line('');
line(`  ledger: ${dir}`);
line('  contains no message text, file contents, paths or keys (by construction)');
line('');
