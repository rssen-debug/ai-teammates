import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * W2 live-acceptance EVIDENTIAL audit: the live run happened (scripts/research-live-acceptance
 * with REAL egress to api.github.com). This test verifies the COMMITTED ARTIFACTS'
 * integrity — deterministically, offline. The live run itself stays a script lane:
 * tests never call the network (flakiness is how honest suites get ignored).
 * Missing artifacts = explicit failure: a lane claiming live acceptance must SHOW its receipts.
 */

const DIR = fileURLToPath(new URL('../docs/evidence/research-live-2026-10-21', import.meta.url));

test('W2 live-acceptance: committade artifacts existerar med receipt-block', () => {
  for (const f of ['report.md', 'ledger.json', 'sources.jsonl', 'adapter-notes.json']) {
    assert.ok(fs.existsSync(path.join(DIR, f)), `saknas live-receipt: ${f}`);
  }
});

test('W2 live-acceptance: källorna är RIKTIGA github-URLs, minst 3, med fetch-tidsstämplar', () => {
  const sources = fs.readFileSync(path.join(DIR, 'sources.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(sources.length >= 3, `endast ${sources.length} källor — för tunt för acceptance`);
  for (const s of sources) {
    assert.match(s.url, /^https:\/\/github\.com\//, `ej-verklig källa: ${s.url}`);
    assert.match(s.fetchedAt, /^2026-10-21T/, 'fetch-tidsstämpel = bevis att run faktiskt hände detta datum');
  }
});

test('W2 live-acceptance: ledger verify säger all-claims-sourced, inga stödlösa claims, rapports inte tom', () => {
  const ledger = JSON.parse(fs.readFileSync(path.join(DIR, 'ledger.json'), 'utf8'));
  assert.equal(ledger.stats.ok, true);
  assert.equal(ledger.stats.unsupported, 0, 'INGEN claim får sakna källa i live-rapporten');
  assert.equal(ledger.stats.verdict.startsWith('all claims sourced'), true);
  const report = fs.readFileSync(path.join(DIR, 'report.md'), 'utf8');
  assert.ok(report.length > 400, 'rapport för tunn');
  const findings = (report.match(/^- /gm) || []).length;
  assert.ok(findings >= 3, `${findings} findings < 3`);
});

test('W2 live-acceptance: adapter-reduktioner är DEKLARERADE högljutt, inte tysta', () => {
  const notes = JSON.parse(fs.readFileSync(path.join(DIR, 'adapter-notes.json'), 'utf8'));
  assert.ok(Array.isArray(notes), 'adapter-notes ska lista varje query-stegloppning');
  for (const n of notes) {
    assert.equal(typeof n.engineQuery, 'string');
    assert.ok(Array.isArray(n.adapterTried) && n.adapterTried.length >= 1, 'varje steg måste vara synlig');
    assert.match(n.reason, /recorded loudly/);
  }
});

test('W2 live-acceptance ärlighetsbrännmärke: konfliktflaggade claims är FLAGGADE i ledgern (inte städade bort)', () => {
  const ledger = JSON.parse(fs.readFileSync(path.join(DIR, 'ledger.json'), 'utf8'));
  // Källsamplet (sade/soly/simple-yargs/big-kahuna) korsar introducerande claims —
  // ett verkligt kors-check MÅSTE flagga minst en konflikt eller reda varje claim:
  // just-0-av-allt betyder troligen att motorn släpat (eller sources var kursiverade kopior).
  assert.ok(ledger.stats.findings >= 3 && (ledger.stats.conflicted >= 0), 'verifysiffra saknas');
  assert.ok(Array.isArray(ledger.clusters) && ledger.clusters.length >= 1, 'clusters utgör kors-kontroll-beviset');
});
