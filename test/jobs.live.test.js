/**
 * jobs.live — the submit slice against a REAL browser + a deterministic fake
 * employer form on 127.0.0.1 (same gate shape as browser.live: it runs in CI
 * on Windows with Edge, skips politely elsewhere).
 * Chain under test, all observed, none assumed:
 *   seed pipeline → jobs.prepare (fields filled, CV attached, status waiting)
 *   → jobs.send (guard-destructive, auto-approved HERE only) → server saw the
 *   POST → thanks-page words → status submitted + proof in history.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIVE = process.env.MAJIN_BROWSER_LIVE === '1' && typeof globalThis.WebSocket === 'function';
const WHY_SKIP = 'needs MAJIN_BROWSER_LIVE=1 and node>=22 (built-in WebSocket) — runs in CI on the Windows runner';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-jobs-live-'));
process.env.MAJIN_HOME = home;

const PAGE_FORM = `<!doctype html><title>acme careers</title>
<meta charset="utf-8">
<h1>Apply: Frontend developer</h1>
<form id="apply" action="/apply" method="post">
  <label>Full name <input id="fname" name="name"></label>
  <label>E-post <input id="femail" name="email" type="email" required></label>
  <label>Telefonnummer <input id="fphone" name="phone" type="tel"></label>
  <label>Portfolio <input id="fsite" name="site" type="url"></label>
  <label>Personligt brev <textarea id="fletter" name="letter"></textarea></label>
  <label>CV (pdf/docx) <input id="fcv" type="file" name="cv"></label>
  <button id="send" type="submit">Skicka ansökan</button>
</form>`;
const PAGE_THANKS = `<!doctype html><title>tack!</title><main><h1>Tack för din ansökan!</h1><p>Vi återkommer inom två veckor. Referens LIVE-42.</p></main>`;

const SAW = { posts: 0, fields: {} };

test('live: prepare fills + send submits + proof lands in history', { skip: !LIVE && WHY_SKIP, timeout: 120000 }, async (t) => {
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && new URL(req.url, 'http://x').pathname === '/apply') {
      SAW.posts += 1;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        SAW.fields = Object.fromEntries(new URLSearchParams(body));
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(PAGE_THANKS);
      });
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGE_FORM);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  try {
    /* seed: CV + one 'matched' application pointing at our fake employer */
    const { saveCv, upsertApplication } = await import('../src/core/jobs/store.js');
    const { createApplication } = await import('../src/core/jobs/model.js');
    await saveCv('Test Kandidat\ntest.kandidat@example.se\n070-111 22 33\ngithub.com/testkandidat');
    const app = createApplication({ site: 'local-test', title: 'Frontend developer', company: 'ACME Test AB', url: 'http://127.0.0.1/annons/1', apply: { url: `http://127.0.0.1:${port}/` } });
    await upsertApplication(app);

    const cfg = {
      get: (k) => (k === 'workspace' ? path.join(home, 'ws')
        : k === 'browser.maxInstances' ? 2
        : k === 'guard.autoApprove' ? ['jobs.prepare', 'jobs.send']  // deterministic HERE — prod asks a human
        : 0),
    };
    const { buildRegistry } = await import('../src/core/tools/index.js');
    const reg = buildRegistry({ cfg });
    const run = (name, args) => reg.exec(name, args, { session: 'jobs-live' }).then((r) => (r.result ? JSON.parse(r.result) : r));

    /* 1 — prepare: form filled, status waiting, preview honest */
    const pre = await run('jobs.prepare', { fp: app.fp, name: 'Test Kandidat', coverLetter: 'Jag vill bygga fina grejer hos er.', city: 'Stockholm' });
    assert.equal(pre.ok, true, JSON.stringify(pre));
    assert.equal(pre.status, 'waiting');
    const filled = Object.fromEntries(pre.preview.filter((x) => x.filled).map((x) => [x.role, x.value]));
    assert.ok(filled.email === 'test.kandidat@example.se', 'email came from the CV');
    assert.ok(filled.name === 'Test Kandidat', 'name came from the answer, never from a CV guess');
    assert.ok(String(filled.github || '').includes('github.com'), 'github link came from the CV');
    assert.ok(String(filled.coverletter || '').includes('fina grejer'), 'cover letter landed');
    assert.ok(String(filled.cv || '').startsWith('file:'), 'the CV file is attached to the file input (' + JSON.stringify(pre.preview) + ')');

    /* 2 — send before approval-capable still needs 'waiting' discipline: wrong fp is refused */
    const wrong = await run('jobs.send', { fp: 'deadbeef00000000' });
    assert.equal(wrong.ok, false);

    /* 3 — send: click, proof, status, history */
    const sent = await run('jobs.send', { fp: app.fp });
    assert.equal(sent.ok, true, JSON.stringify({ sent, saw: SAW }).slice(0, 900));
    assert.equal(sent.status, 'submitted');
    assert.ok(sent.proof.accepted && sent.proof.words.length >= 1, 'confirmation words seen');
    assert.ok(sent.proof.shot && fs.existsSync(sent.proof.shot), 'the screenshot exists on disk');

    /* the employer SAW it — browser-side lies cannot forge this */
    assert.ok(SAW.posts >= 1, 'the fake employer received a POST');
    assert.equal(SAW.fields.name, 'Test Kandidat');
    assert.equal(SAW.fields.email, 'test.kandidat@example.se');
    assert.ok((SAW.fields.letter || '').includes('fina grejer'), 'the letter text was posted');
    assert.ok((SAW.fields.cv || '').length > 0, 'the file field was part of the POST (' + JSON.stringify(SAW.fields) + ')');

    /* history carries the proof */
    const { loadApplications } = await import('../src/core/jobs/store.js');
    const stored = (await loadApplications())[app.fp];
    assert.equal(stored.status, 'submitted');
    assert.equal(stored.history.at(-1).status, 'submitted');
    assert.ok(stored.history.at(-1).evidence.proof.accepted, 'proof persisted in the pipeline file');

    /* resend of a done application is refused by the machine itself */
    const again = await reg.exec('jobs.send', { fp: app.fp }, { session: 'jobs-live' });
    const againOut = again.result ? JSON.parse(again.result) : again;
    assert.equal(againOut.ok, false, 'submitted stays submitted');

    const { _resetBrowser } = await import('../src/core/browser.js');
    _resetBrowser();
  } finally {
    srv.close();
    const { _resetBrowser } = await import('../src/core/browser.js');
    _resetBrowser();
  }
});
