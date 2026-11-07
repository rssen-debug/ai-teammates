#!/usr/bin/env node
/**
 * MAJIN W13 live-provider chaos — kör sviten MOT RIKTIG opencode zen/go.
 *   OPENCODE_KEY=oc_sk_... node scripts/live-provider-chaos.mjs [--model=glm-5.3-flash] [--json] [--save]
 *
 * Nyckeln läses UR MILJÖRADELET och skrivs ALDRIG in i artifacts. Saknas nyckel:
 * högljudd exit 2 (lane kan inte bevisas här — aldrig fabrikerade-rader).
 * Exit != 0 om stuck > 0 eller inga rader går att avgöra.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLiveChaos, openCodeGoChat, renderLiveChaosMarkdown, LIVE_CHAOS_VERSION } from '../src/core/live-provider-chaos.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const f = (n, d) => { const e = argv.find((a) => a.startsWith(`--${n}=`)); return e ? e.split('=').slice(1).join('=') : (argv.includes(`--${n}`) ? true : d); };

const KEY = process.env.OPENCODE_KEY || process.env.OPENCODE_API_KEY || null;
if (!KEY) {
  console.error('OPENCODE_KEY missing from environment — the live lane cannot be proven here (never fabricated chaos rows).');
  process.exit(2);
}

const model = String(f('model', 'glm-5.3-flash'));
const sessionId = `majin-live-chaos-${new Date().toISOString().slice(0, 10)}`;
const call = (opts) => openCodeGoChat({
  ...opts,
  apiKey: opts.__forceBadKey ? 'oc_sk_DELIBERATELY_INVALID_KEY_for_chaos_row' : KEY,
  sessionId,
});

process.stdout.write(`live-provider chaos: provider=opencode zen/go · model=${model} · session=${sessionId}\n`);
const report = await runLiveChaos({
  call, model,
  onRow: (r) => process.stdout.write(`  ${r.verdict === 'STUCK' ? '✗' : r.verdict === 'recovered' ? '✓' : '◦'} ${r.id.padEnd(50)} ${r.verdict} (${r.wallMs}/${r.boundMs}ms)\n`),
});

if (f('json', false)) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (f('save', false)) {
  const d = new Date().toISOString().slice(0, 10);
  const outJ = path.join(ROOT, 'docs', 'evidence', `live-provider-chaos-${d}.json`);
  const outM = path.join(ROOT, 'docs', 'evidence', `live-provider-chaos-${d}.md`);
  fs.writeFileSync(outJ, JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(outM, renderLiveChaosMarkdown(report));
  process.stdout.write(`json: ${outJ}\nmd:   ${outM}\n`);
}
process.stdout.write(`\nrate=${Math.round(report.recoveryRate * 100)}% (${report.totals.recovered}+${report.totals.controlled}/${report.totals.rows}) · stuck=${report.totals.stuck} · unhandled=${report.unhandledRejections} · harness=${LIVE_CHAOS_VERSION}\n`);
process.exitCode = report.totals.stuck === 0 && report.totals.recovered + report.totals.controlled >= 5 ? 0 : 1;
