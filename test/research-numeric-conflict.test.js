import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { crossCheck, run } from '../src/core/research.js';

test('W2/LIMIT-FIX: 1,240 vs 340 with shared anchors is a flagged conflict (was measured-missing before)', () => {
  const cc = crossCheck({
    S1: [{ sentence: 'The Widget X processed 1,240 orders in March 2026.', anchors: ['orders', 'widget', 'march', '2026'] }],
    S2: [{ sentence: 'The Widget X handled 340 orders in March 2026.', anchors: ['orders', 'widget', 'march', '2026'] }],
  });
  /* divergent claims merge into one cluster (semantic near-duplicates); the
     correct contract is that THAT cluster is marked conflicts:true while
     keeping both sources — no silent single-truth smoothing */
  assert.ok(cc.clusters.some((c) => c.support >= 2), 'both sources stay attached: ' + JSON.stringify(cc.clusters));
  assert.ok(cc.clusters.some((c) => c.conflicts === true), 'divergent merged cluster must be marked conflicts:true: ' + JSON.stringify(cc.clusters));
});

test('W2/LIMIT-FIX: matching figures do NOT conflict (positive-control)', () => {
  const cc = crossCheck({
    S1: [{ sentence: 'Widget X processed 1,240 orders in March 2026.', anchors: ['orders', 'widget', 'march'] }],
    S2: [{ sentence: 'In March the Widget handled 1240 orders per the report.', anchors: ['orders', 'widget', 'march'] }],
  });
  assert.equal(cc.clusters.filter((c) => c.conflicts).length, 0, 'same magnitude must not flag: ' + JSON.stringify(cc.clusters));
});

test('W2/LIMIT-FIX: difference in years ALONE is not a numeric conflict', () => {
  const cc = crossCheck({
    S1: [{ sentence: 'Feedback began with the 2024 rollout.', anchors: ['rollout', 'widget'] }],
    S2: [{ sentence: 'The rollout finished in 2026.', anchors: ['rollout', 'widget'] }],
  });
  assert.equal(cc.clusters.filter((c) => c.conflicts).length, 0, 'year tokens are context, never quantity: ' + JSON.stringify(cc.clusters));
});

test('W2/LIMIT-FIX: full pipeline over real socket now REPORTS the numeric divergence in verify stats + verdict', async () => {
  const pad = ' Third paragraph padding for minimum content length. Extra sentences keep the extractor at work across the whole document body of the quarterly operations report for Widget X.';
  const server = http.createServer((req, res) => {
    if (req.url === '/alpha') res.end('<html><body><h1>Widget X benchmark</h1><p>The Widget X processed 1,240 orders in March 2026, up from 980 in February 2026.</p><p>Stable delivery window reported.' + pad + '</p></body></html>');
    else if (req.url === '/beta') res.end('<html><body><h1>Widget X concerns</h1><p>The Widget X handled 340 orders in March 2026 — a sharp decline.</p><p>Delivery window doubled.' + pad + '</p></body></html>');
    else { res.statusCode = 404; res.end('x'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const fetchR = (url) => new Promise((res, rej) => http.get(url, (r) => {
    if (r.statusCode !== 200) { rej(new Error('HTTP ' + r.statusCode)); r.resume(); return; }
    let d = ''; r.setEncoding('utf8'); r.on('data', (c) => d += c); r.on('end', () => res(d.slice(0, 60000)));
  }).on('error', rej));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2-num'));
  const r = await run('how many orders did Widget X handle in March 2026?', {
    searchFn: async () => ([{ url: `http://127.0.0.1:${port}/alpha` }, { url: `http://127.0.0.1:${port}/beta` }]),
    fetchFn: fetchR, artifactsDir: dir,
  });
  await new Promise((res) => server.close(res));
  assert.equal(r.ok, true, JSON.stringify(r.error || null));
  const stats = (r.progress || []).find((p) => p.step === 'verify');
  assert.ok(stats.conflicted >= 1, 'verify must now measure the numeric conflict: ' + JSON.stringify(stats));
  assert.match(String(stats.verdict), /conflicted claim\(s\) flagged/);
  fs.rmSync(dir, { recursive: true, force: true });
}, 30000);
