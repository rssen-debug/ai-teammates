#!/usr/bin/env node
/**
 * W13 never-stuck recovery matrix — kör och spara ärkeevidens.
 * Usage: node scripts/w13-recovery-matrix.mjs [--out docs/evidence/....json] [--md docs/evidence/....md]
 */
import fs from 'node:fs';
import path from 'node:path';
import { runMatrix, renderMarkdownReport } from '../src/core/recovery-metrics.js';

const args = process.argv.slice(2);
const date = new Date().toISOString().slice(0, 10);
const outJson = args[args.indexOf('--out') + 1] || path.join('docs', 'evidence', `w13-recovery-matrix-${date}.json`);
const outMd = args[args.indexOf('--md') + 1] || path.join('docs', 'evidence', `w13-recovery-matrix-${date}.md`);
const ws = process.env.MAJIN_WORKSPACE || path.resolve('.majin-matrix-ws' + '-' + Date.now());

fs.mkdirSync(ws, { recursive: true });
let printed = 0;
const m = await runMatrix({
  workspaceDir: ws,
  onRow: (r) => {
    printed += 1;
    process.stdout.write(`[${printed}] ${r.verdict.padEnd(10)} ${r.wallMs ?? '—'}ms  ${r.id}${r.reason ? `  — ${r.reason}` : ''}\n`);
  },
});

fs.mkdirSync(path.dirname(outJson), { recursive: true });
fs.writeFileSync(outJson, JSON.stringify(m, null, 2) + '\n');
fs.writeFileSync(outMd, renderMarkdownReport(m));
process.stdout.write(`\nrecovery rate: ${(m.recoveryRate * 100).toFixed(1)}% (${m.totals.recovered}r + ${m.totals.controlled}c / ${m.totals.executed}); stuck=${m.totals.stuck}; unhandled=${m.unhandledRejections}\n`);
process.stdout.write(`json: ${outJson}\nmd:   ${outMd}\n`);
process.exitCode = m.invariants.I1_no_stuck_in_deterministic_suite && m.invariants.I2_zero_unhandled_rejections ? 0 : 1;
