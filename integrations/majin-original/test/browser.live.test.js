/**
 * MAJIN — browser-use LIVE end-to-end. Skipped everywhere except when
 * MAJIN_BROWSER_LIVE=1 on a node ≥22 runtime with a real Chrome/Edge nearby
 * (the GitHub windows runner provides both: this is the wire-under-traffic
 * proof the unit tests cannot provide).
 *
 * Everything asserted here is observable from OUTSIDE the module too: the
 * local HTTP server logs the form submission, the page's own words come back
 * through browser.read, the upload is confirmed by the input element itself
 * and the screenshot is a file on disk. Nothing reports ok on faith.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-blive-'));
process.env.MAJIN_HOME = home;

const LIVE =
  process.env.MAJIN_BROWSER_LIVE === '1' &&
  typeof globalThis.WebSocket === 'function';

const WHY_SKIP =
  'live browser e2e only runs where MAJIN_BROWSER_LIVE=1 and the runtime has WebSocket (node >= 22) — CI Windows sets this up';

const PAGE_FORM = `<!doctype html><title>majin live form</title>
  <h1 id="h1">mini application</h1>
  <form id="job" action="/thanks" method="get">
    <label>name <input id="name" name="name" value=""></label>
    <button id="go" type="submit">Send application</button>
  </form>
  <div class="upload">cv: <input id="cv" type="file"></div>`;
const thanks = (name) =>
  `<!doctype html><title>majin live thanks</title><h1 id="ok">Thanks, ${name} — application received</h1>`;

const SUBMIT = { name: null, hits: 0 };

test('live: open → read → fill → click-submit (server saw it) → read result → upload → shot → close', { skip: !LIVE && WHY_SKIP, timeout: 90000 }, async () => {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/thanks') {
      SUBMIT.hits += 1;
      SUBMIT.name = decodeURIComponent(u.searchParams.get('name') || '');
      res.setHeader('content-type', 'text/html');
      res.end(thanks(SUBMIT.name));
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(PAGE_FORM);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const cfg = {
    get: (k) => (k === 'workspace' ? path.join(home, 'ws') : k === 'browser.maxInstances' ? 2 : 0),
  };
  const { openFor, isOpen, closeFor, _resetBrowser } = await import('../src/core/browser.js');
  const { webTools } = await import('../src/core/tools/web.js');
  const T = Object.fromEntries(webTools.filter((t) => t.name.startsWith('browser.')).map((t) => [t.name, t]));
  const session = 'live-e2e';
  const ctx = { session, cfg };

  let debuggerUrl;
  try {
    /* 1 — open through the same tool the agent sees */
    const open = await T['browser.open'].run({ url: `http://127.0.0.1:${port}/`, headless: true }, ctx);
    assert.ok(open.ok, `open failed: ${JSON.stringify(open)}`);
    assert.match(open.meta.title, /majin live form/, 'the page is named from its own words');
    assert.ok(isOpen(session), 'the session owns a browser now');
    debuggerUrl = (await openFor({ session })).debuggerUrl;

    /* 2 — read: the page's own text, not our assumption */
    const read = await T['browser.read'].run({ selector: 'h1' }, ctx);
    assert.ok(read.ok && read.result && read.result.includes('mini application'), `read mismatch: ${JSON.stringify(read)}`);

    /* 3 — fill: the page must KEEP the value */
    fs.mkdirSync(path.join(home, 'ws'), { recursive: true });
    const fill = await T['browser.fill'].run({ selector: '#name', value: 'E2E Testmaskin' }, ctx);
    assert.ok(fill.ok, `fill failed: ${JSON.stringify(fill)}`);

    /* 4 — click submit: the SERVER must see the form arrive */
    const click = await T['browser.click'].run({ selector: 'button#go' }, ctx);
    assert.ok(click.ok, `click failed: ${JSON.stringify(click)}`);
    assert.ok(SUBMIT.hits >= 1, 'server-side evidence: the form really reached the page server');
    assert.equal(SUBMIT.name, 'E2E Testmaskin', 'the filled value arrived at the server');
    assert.match(click.meta.urlAfter, /\/thanks/, 'the url also tells the story');

    /* 5 — read the result page from the browser's own view */
    const confirmed = await T['browser.read'].run({ selector: '#ok' }, ctx);
    assert.ok(confirmed.ok && confirmed.result.includes('application received'), 'the thanks page greets us back');

    /* 6 — upload: the INPUT element itself confirms the file */
    fs.writeFileSync(path.join(home, 'ws', 'cv.txt'), 'this is a tiny cv for the live test\n');
    const up = await T['browser.upload'].run({ selector: '#cv', path: 'cv.txt' }, ctx);
    /* back on the form page for the upload? — no: upload works on the CURRENT tab's input.
       If /thanks lacks the input we navigate back first, being explicit about the model. */
    let uploadReport = up;
    if (!up.ok && up.error && up.error.code === 'no_such_element') {
      const back = await openFor({ session, url: `http://127.0.0.1:${port}/` });
      assert.ok(back, 'navigated back to the form');
      uploadReport = await T['browser.upload'].run({ selector: '#cv', path: 'cv.txt' }, ctx);
    }
    assert.ok(uploadReport.ok, `upload failed: ${JSON.stringify(uploadReport)}`);
    assert.equal(uploadReport.meta.name, 'cv.txt', 'the page sees the right file');
    if (SUBMIT.name !== 'E2E Testmaskin') {
      const refill = await T['browser.fill'].run({ selector: '#name', value: 'E2E Testmaskin' }, ctx);
      assert.ok(refill.ok, 're-filled after navigation');
    }

    /* 7 — screenshot: a real PNG exists on disk */
    const shot = await T['browser.shot'].run({}, ctx);
    assert.ok(shot.ok, 'shot failed');
    assert.ok(fs.statSync(shot.meta.path).size > 1000, 'the PNG is not empty');
  } finally {
    /* 8 — close: the slot goes back to the fleet */
    if (isOpen(session)) {
      const c = await T['browser.close'].run({}, ctx);
      assert.ok(c.ok && c.meta.closed === true, 'the browser was actually open and now is not');
      let closed = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        try { await fetch(`http://${new URL(debuggerUrl).host}/json/version`, { signal: AbortSignal.timeout(250) }); }
        catch { closed = true; break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(closed, true, 'browser.close shuts down the real debug endpoint, including a relaunched Edge process');
    }
    _resetBrowser();
    srv.close();
  }
});
