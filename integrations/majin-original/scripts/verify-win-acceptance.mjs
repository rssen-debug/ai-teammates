#!/usr/bin/env node
/**
 * Validates a W12 win-runner acceptance OUT.json (produced by
 * qa/win-acceptance/run-all.ps1) against the DoD contract:
 *  - exact schema { suite, machine, os, at, interactive, steps[] }
 *  - every step status in PASS|FAIL|NOT TESTED
 *  - PASS steps MUST carry an artifact or a measurable evidence string
 *  - DoD-required steps (A1 cursor, A5 computer.use smoke) must be present
 * Exit 0 + verdict text; non-zero on contract violations (loud, never silent).
 */
import fs from 'node:fs';
import path from 'node:path';

export const RULES = Object.freeze({
  requiredSteps: ['A1', 'A5'],
  statuses: ['PASS', 'FAIL', 'NOT TESTED'],
});

export function validateAcceptance(doc, { requireAllPass = false } = {}) {
  const problems = [];
  if (!doc || typeof doc !== 'object') return ['document is not an object'];
  if (doc.suite !== 'win-acceptance/1') problems.push(`suite must be "win-acceptance/1", got ${JSON.stringify(doc.suite)}`);
  if (!doc.machine || !String(doc.machine).trim()) problems.push('machine missing');
  if (!doc.at || Number.isNaN(Date.parse(doc.at))) problems.push('at missing/unparseable');
  if (typeof doc.interactive !== 'boolean') problems.push('interactive must be a boolean — guessing interactivity is exactly what this pack forbids');
  if (!Array.isArray(doc.steps) || !doc.steps.length) problems.push('steps must be a non-empty array');
  const ids = new Set();
  for (const s of doc.steps || []) {
    if (!s || typeof s !== 'object') { problems.push('step entry is not an object'); continue; }
    if (!s.step || !s.title) problems.push(`step missing id/title: ${JSON.stringify(s).slice(0, 80)}`);
    if (ids.has(s.step)) problems.push(`duplicate step id ${s.step}`);
    ids.add(s.step);
    if (!RULES.statuses.includes(s.status)) problems.push(`${s.step}: status must be one of ${RULES.statuses.join('|')}, got ${JSON.stringify(s.status)}`);
    if (s.status === 'PASS' && !s.artifact && !(s.evidence && String(s.evidence).trim().length >= 10)) {
      problems.push(`${s.step}: PASS without artifact or concrete evidence (≥10 chars) violates the DoD`);
    }
    if (s.status === 'FAIL' && !s.evidence) problems.push(`${s.step}: FAIL must state what happened`);
  }
  for (const req of RULES.requiredSteps) if (!ids.has(req)) problems.push(`DoD-required step ${req} missing from the report`);
  if (requireAllPass) {
    const bad = (doc.steps || []).filter((s) => RULES.requiredSteps.includes(s.step) && s.status !== 'PASS');
    for (const b of bad) problems.push(`${b.step} is ${b.status} — release gate requires PASS (or an honest NOT TESTED note accepted by the maintainer)`);
  }
  return problems;
}

export function verdict(doc) {
  const by = { PASS: 0, FAIL: 0, 'NOT TESTED': 0 };
  for (const s of doc?.steps || []) by[s.status] = (by[s.status] || 0) + 1;
  const fail = by.FAIL > 0 ? `FAIL ${by.FAIL}` : null;
  const nt = by['NOT TESTED'] ? `NOT TESTED ${by['NOT TESTED']}` : null;
  return [fail, nt].filter(Boolean).length ? `BLOCKED (${[fail, nt].filter(Boolean).join(', ')})` : 'ACCEPTED';
}

/* CLI */
if (process.argv[1] && process.argv[1].endsWith('verify-win-acceptance.mjs')) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/verify-win-acceptance.mjs <out.json> [--gate]'); process.exit(2); }
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8').replace(/^\uFEFF/, '')); } catch (e) { console.error('cannot read evidence file: ' + e.message); process.exit(2); }
  const problems = validateAcceptance(doc, { requireAllPass: process.argv.includes('--gate') });
  console.log(`verdict: ${verdict(doc)}`);
  for (const s of doc.steps || []) console.log(`  ${s.step}  ${s.status.padEnd(10)} ${s.title}`);
  if (problems.length) { console.log('contract violations:'); problems.forEach((p) => console.log('  - ' + p)); process.exit(1); }
  console.log('evidence file conforms to win-acceptance/1');
}
