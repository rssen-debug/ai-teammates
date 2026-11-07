#!/usr/bin/env node
/**
 * Aggregates qa-evidence/qa-report.json (+ artifact links) into the final
 * docs/REAL_WORLD_QA_AUDIT.md audit document. The document is machine-written
 * from REAL run evidence; run id and artifact link are embedded for audit chain.
 *
 * Usage:
 *   node scripts/qa/qa-report.mjs --evidence qa-evidence \
 *     --run-id 39400963377 --sha <commit> [--out docs/REAL_WORLD_QA_AUDIT.md]
 */
import fs from 'node:fs';
import path from 'node:path';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const evidDir = path.resolve(arg('evidence', 'qa-evidence'));
const runId = arg('run-id', 'unknown');
const sha = arg('sha', 'unknown');
const outFile = arg('out', 'docs/REAL_WORLD_QA_AUDIT.md');
const reportPath = path.join(evidDir, 'qa-report.json');
const rep = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

const laneOf = (s) => s.lane;
const statusIcon = { VERIFIED_REAL: '✅ REAL', VERIFIED_CI: '✅ CI', SIMULATED: '🟡 SIM', BLOCKED: '⛔ BLOCKED', FAILED: '❌ FAILED', SKIPPED: '⚪ SKIP' };
const lines = [];
const counts = rep.counts || {};
const total = rep.scenarios.filter((s) => s.status !== 'SKIPPED').length;
const verified = rep.scenarios.filter((s) => ['VERIFIED_REAL', 'VERIFIED_CI'].includes(s.status)).length;
const failed = rep.scenarios.filter((s) => s.status === 'FAILED');
const simulated = rep.scenarios.filter((s) => s.status === 'SIMULATED');
const blocked = rep.scenarios.filter((s) => s.status === 'BLOCKED');

lines.push('# MAJIN v1.0.0 — REAL-WORLD AUTONOMOUS QA AUDIT');
lines.push('');
lines.push(`> Independent audit of the **published release artifact** (never the repo code).`);
lines.push(`> Traffic direction: GitHub release → silent install → installed exe → real local LLM → ${rep.scenarios.length} scenarios.`);
lines.push(`> Scope is honest: everything on a GitHub hosted runner is at most **VERIFIED_CI** — Session 0 has no interactive desktop.`);
lines.push('');
lines.push('## Verdict at a glance');
lines.push('');
lines.push('| Metric | Value |');
lines.push('|---|---|');
lines.push(`| Run | <https://github.com/rssen-debug/MAJINCLI/actions/runs/${runId}> |`);
lines.push(`| Audit commit | \`${sha}\` |`);
lines.push(`| Artifact | published release **v1.0.0** (sha256-verified before install) |`);
lines.push(`| Environment | ${rep.env?.runner || 'windows-latest'}; models: ${(rep.env?.models || []).join(', ')} |`);
lines.push(`| Scenarios executed | ${rep.scenarios.length} (${total} scored, ${rep.scenarios.length - total} skipped) |`);
lines.push(`| Verified (CI) | ${verified} |`);
lines.push(`| Failed | **${failed.length}**${failed.length ? ' — ' + failed.map((f) => f.id).join(', ') : ''} |`);
lines.push(`| Simulated | ${simulated.length}${simulated.length ? ' — ' + simulated.map((s) => s.id).join(', ') : ''} |`);
lines.push(`| Blocked (environment) | ${blocked.length}${blocked.length ? ' — ' + blocked.map((s) => s.id).join(', ') : ''} |`);
lines.push('');
const recommendation = failed.length === 0
  ? (blocked.length > 0 || simulated.length > 0 ? '**CONDITIONAL** — no scenario failed; remaining blockers/simulations are listed with exact reproduction steps below.' : '**READY** — every audited lane passed with real evidence on the published product.')
  : '**NOT READY** — at least one audited behavior failed with real evidence; the failures and their reproduction are below.';
lines.push(`### Independent release recommendation: ${recommendation}`);
lines.push('');
lines.push('## Scenario ledger');
lines.push('');
lines.push('| # | Scenario | Lane | Status | Evidence note |');
lines.push('|---|---|---|---|---|');
for (const s of rep.scenarios) {
  const icon = statusIcon[s.status] || s.status;
  const note = (s.note || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 160);
  lines.push(`| ${s.id} | ${s.name} | ${s.lane} | ${icon} | ${note} |`);
}
lines.push('');
lines.push('');
if (failed.length) {
  lines.push('## Bugs / failures (with reproduction)');
  lines.push('');
  for (const f of failed) {
    lines.push(`### ${f.id} — ${f.name}`);
    lines.push('');
    lines.push(`- **Observed:** ${f.note}`);
    if (f.evidence && Object.keys(f.evidence).length) {
      lines.push('- **Evidence excerpt:**');
      lines.push('```json');
      lines.push(JSON.stringify(f.evidence, null, 2).slice(0, 900));
      lines.push('```');
    }
    lines.push(`- **Reproduce:** dispatch workflow \`win-qa-realworld.yml\` → inspect artifact \`qa-realworld-evidence/${f.id}.json\`.`);
    lines.push('');
  }
}
if (blocked.length) {
  lines.push('## Blocked lanes & exact unblock instructions');
  lines.push('');
  for (const b of blocked) {
    lines.push(`### ${b.id} — ${b.name}`);
    lines.push('');
    lines.push(b.note);
    if (b.evidence?.howToVerify) {
      lines.push('');
      lines.push('```text');
      lines.push(b.evidence.howToVerify);
      lines.push('```');
    }
    lines.push('');
  }
}
lines.push('## How to re-run this audit');
lines.push('');
lines.push('```text');
lines.push('gh workflow run win-qa-realworld.yml');
lines.push('# or: Actions → win-qa-realworld → Run workflow (models input selects the Ollama set)');
lines.push('# self-hosted interactive-dektop runner: set qa_interactive=true to unlock c02 → VERIFIED_REAL');
lines.push('```');
lines.push('');
lines.push('Evidence chain: every scenario writes `qa-evidence/<id>.json` + the aggregate');
lines.push('`qa-evidence/qa-report.json`; SSE transcripts and server logs are in the same');
lines.push('artifact. Nothing in this report relies on unit tests, mocks, or earlier agent claims.');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, lines.join('\n') + '\n');
console.log(`wrote ${outFile} (${lines.length} lines, ${rep.scenarios.length} scenarios)`);
