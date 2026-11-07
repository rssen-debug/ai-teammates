import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { plan, extractClaims, crossCheck, synthesize, verify, reliability, run } from '../src/core/research.js';

const QUESTION = 'What is the Anderssen discovery in the Helida climate algorithm?';

/* ------------------------------- fixtures ---------------------------------- */
const corpus = {
  'https://helida-research.edu/algorithms': `The Anderssen discovery as part of the Helida climate algorithm was published in 2024. According to the methodology section the discovery reduced prediction error by 18 percent across 42 weather stations. The team around Anderssen called the method chain-of-gaps.`,
  'https://climateblog.blog/anderssen': 'Anderssen worked on climate. The error reduction of 18 percent is accepted but the number of stations was 42 according to the published data. Subscribe to our blog now.',
  'https://news.se/helida': `Helida climate algorithm update 2026: the Anderssen chain-of-gaps method is now the default in all European weather prediction. The error rate fell from 24 percent to 19 percent over three years.`,
  'https://invalid-lazy.example/notes': 'ok',
};

const searchFn = async (q, { count = 5 } = {}) => Object.keys(corpus).slice(0, count).map((u) => ({ url: u, title: u.split('/').slice(2).join('/'), snippet: 'mocked' }));
const fetchFn = async (url) => corpus[url] || '';

test('W2 plan: multiple independent queries, none fabricated', () => {
  const p = plan(QUESTION);
  assert.ok(p.ok);
  assert.ok(p.queries.length >= 2 && p.queries.length <= 4, `expected 2-4 queries, got ${p.queries.length}`);
  assert.equal(p.queries[0], QUESTION);
  for (const q of p.queries) assert.ok(q.length > 8);
  const fp = plan('   ');
  assert.equal(fp.ok, false);
});

test('W2 extract: question-anchored sentences with scores (fixtures)', () => {
  const claims = extractClaims(corpus['https://helida-research.edu/algorithms'], { questionTerms: ['anderssen', 'helida', 'climate', 'algorithm'] });
  assert.ok(claims.length >= 2, `expected >=2 claims, got ${claims.length}`);
  assert.ok(claims[0].score >= 1);
  for (const c of claims) assert.ok(c.sentence.length >= 25);
});

test('W2 cross-check: clusters similar claims across sources + counts support', () => {
  const bySource = {
    S1: extractClaims(corpus['https://helida-research.edu/algorithms'], { questionTerms: ['anderssen', 'error', 'stations'] }),
    S2: extractClaims(corpus['https://climateblog.blog/anderssen'], { questionTerms: ['anderssen', 'error', 'stations'] }),
  };
  const cc = crossCheck(bySource);
  const clustered = cc.clusters.find((c) => c.support > 1);
  assert.ok(clustered, 'expected at least one multi-source claim');
  assert.ok(clustered.sources.includes('S1') && clustered.sources.includes('S2'));
});

test('W2 cross-check: contradiction detection (never vs requires)', () => {
  const cc = crossCheck({
    S1: [{ sentence: 'The system never requires a restart of the model daemon for cache updates across fleets.', anchors: ['restart'], score: 2 }],
    S2: [{ sentence: 'The system always requires a restart of the model daemon for cache updates across fleets.', anchors: ['restart'], score: 2 }],
  });
  assert.ok(cc.clusters.some((c) => c.conflicts), 'polarity conflict should be flagged');
});

test('W2 reliability: https + authority tld > plain blog', () => {
  const a = reliability('https://helida-research.edu/x');
  const b = reliability('http://climateblog.blog/x');
  assert.ok(a.score > b.score, `${a.score} should be > ${b.score}`);
});

test('W2 synthesize + verify: findings count, no unsupported silently included', () => {
  const sources = [
    { id: 'S1', url: 'https://helida-research.edu/algorithms', reliability: reliability('https://helida-research.edu/algorithms'), fetchedAt: new Date().toISOString() },
    { id: 'S2', url: 'https://news.se/helida', reliability: reliability('https://news.se/helida'), fetchedAt: new Date().toISOString() },
  ];
  const clusters = [
    { sentence: 'The Anderssen discovery reduced prediction error by 18 percent.', anchors: ['anderssen'], support: 2, sources: ['S1', 'S2'], conflicts: false },
    { sentence: 'Synthetic unsupported claim surface.', anchors: [], support: 0, sources: [], conflicts: false },
  ];
  const report = synthesize({ question: QUESTION, clusters, sources, ledger: { sourcesByIds: ['S1', 'S2'] } });
  assert.match(report, /Research report/);
  assert.match(report, /Six parts|Anderssen discovery/);
  const v = verify(report, { clusters });
  assert.ok(v.findings >= 1);
  assert.equal(v.conflicted, 0);
});

test('W2 run (end-to-end offline): plan→search→fetch→extract→cross-check→synthesize→verify with artifacts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-art-'));
  const out = await run(QUESTION, { searchFn, fetchFn, artifactsDir: dir });
  assert.equal(out.ok, true, JSON.stringify(out.error || {}));
  assert.ok(out.stats.findings >= 3, JSON.stringify(out.stats));
  assert.ok(fs.existsSync(out.paths.report));
  assert.ok(fs.existsSync(out.paths.ledger));
  const ledger = JSON.parse(fs.readFileSync(out.paths.ledger, 'utf8'));
  assert.ok(ledger.stats.findings >= 1);
  for (const s of out.sources) assert.ok(s.url.startsWith('https://'), 'ledger may only list fetched sources');
});

test('W2 run: zero reachable sources = honest error, no fabricated report', async () => {
  const out = await run(QUESTION, { searchFn: async () => [{ url: 'https://dead.example/x' }], fetchFn: async () => '' });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'no_sources');
});
