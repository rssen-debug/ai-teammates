/**
 * Del 5A + 5B + 5E — REAL browser domains proven against deterministic local
 * fake sites, observed end-to-end, no unverified claims:
 *   5A forms & interactive controls — text/select/radio/checkbox + required
 *      validation, values observed AT THE SERVER, thanks-words proven.
 *   5B dynamic navigation, tabs, iframes — target=_blank followed into the new
 *      tab, SPA-style hash navigation content changes; iframes honestly:
 *      host detected + iframe source page reachable & verified the straight way
 *      (claiming the frame's internals are bridged would be unproven).
 *   5E multi-step real workflow — search → product → cart → checkout → confirm,
 *      every step cross-checked against SERVER state; the final claim carries
 *      only what the server actually recorded.
 * Same gate shape as browser.live/jobs.live: runs live in exe-CI on the
 * Windows runner (MAJIN_BROWSER_LIVE=1, node>=22), skips elsewhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIVE = process.env.MAJIN_BROWSER_LIVE === '1' && typeof globalThis.WebSocket === 'function';
const WHY_SKIP = 'needs MAJIN_BROWSER_LIVE=1 and node>=22 — runs live in exe-CI (Windows runner Edge)';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-domains-live-'));
process.env.MAJIN_HOME = home;

const WAIT = (ms) => new Promise((r) => setTimeout(r, ms));

async function serve(pages, saw) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const params = Object.fromEntries(new URLSearchParams(body));
        (saw.posts ??= []).push({ path: u.pathname, params });
        if (u.pathname === '/cart') saw.cart.push(params);
        if (u.pathname === '/apply') Object.assign(saw.form, params);
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(pages.thanks || '<h1>OK-BEKRAFTELSE-4242</h1>');
      });
      return;
    }
    const page = pages[u.pathname];
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(page ?? '<h1>404</h1>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return srv;
}

async function mkReg() {
  const cfg = {
    get: (k) => (k === 'workspace' ? path.join(home, 'ws')
      : k === 'browser.maxInstances' ? 3
      : k === 'guard.autoApprove' ? ['browser.open', 'browser.click', 'browser.fill', 'browser.upload', 'browser.close']
      : 0),
  };
  const { buildRegistry } = await import('../src/core/tools/index.js');
  return buildRegistry({ cfg });
}

test('5A forms & interactive controls: text+select+radio+consent reach the server verbatim', { skip: !LIVE && WHY_SKIP, timeout: 150000 }, async (t) => {
  const saw = { form: {} };
  const srv = await serve({
    '/': `<title>careers</title><h1>Apply</h1><form action="/apply" method="post">
      <input id="f1" name="name" required>
      <input id="f2" name="mail" type="email" required>
      <select id="f3" name="stack"><option value="">—</option><option value="node">Node</option><option value="go">Go</option></select>
      <label><input type="radio" name="level" id="r1" value="junior"> junior</label>
      <label><input type="radio" name="level" id="r2" value="senior"> senior</label>
      <label><input type="checkbox" id="gdpr" name="consent" required> jag godkanner</label>
      <button type="submit">send</button></form>`,
    thanks: '<h1>TACK-MARKOR-77: ansokan mottagen</h1>',
  }, saw);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const reg = await mkReg();
  try {
    const run = (n, a) => reg.exec(n, a, { session: 'd5a' });
    const o = await run('browser.open', { url: base + '/' });
    assert.equal(o.ok, true, `open: ${JSON.stringify(o).slice(0, 160)}`);
    assert.equal((await run('browser.fill', { selector: '#f1', value: 'Siri Testsson' })).ok, true, 'name fill');
    assert.equal((await run('browser.fill', { selector: '#f2', value: 'siri@test.dev' })).ok, true, 'email fill');
    assert.equal((await run('browser.fill', { selector: '#f3', value: 'node' })).ok, true, 'SELECT filled via real setter');
    assert.equal((await run('browser.click', { selector: '#r2' })).ok, true, 'radio senior clicked');
    assert.equal((await run('browser.click', { selector: '#gdpr' })).ok, true, 'consent checkbox clicked');
    const c = await run('browser.click', { selector: 'button[type=submit]' });
    assert.equal(c.ok, true, 'submit click');
    await WAIT(1200);
    const rd = await run('browser.read', {});
    assert.match(String(rd.result || ''), /TACK-MARKOR-77/, 'thanks-words proven on screen');
    /* server-side truth: what did the browser ACTUALLY post? */
    assert.equal(saw.form.name, 'Siri Testsson', 'name arrived verbatim');
    assert.equal(saw.form.mail, 'siri@test.dev', 'email arrived verbatim');
    assert.equal(saw.form.stack, 'node', 'select value arrived');
    assert.equal(saw.form.level, 'senior', 'radio value arrived');
    assert.equal(saw.form.consent, 'on', 'consent arrived checked');
    console.log('5A server-observed:', JSON.stringify(saw.form));
  } finally {
    srv.close();
    await reg.exec('browser.close', {}, { session: 'd5a' }).catch(() => {});
  }
});

test('5B dynamic navigation, tabs, iframes: new-target followed, hash-nav content proven, iframe host + straight-path verify', { skip: !LIVE && WHY_SKIP, timeout: 150000 }, async (t) => {
  const srv = await serve({
    '/': `<title>portal</title><h1>portal</h1>
      <a id="lnk-new" href="/newtab" target="_blank">open in new tab</a><br>
      <a id="lnk-hash" href="#/dashboard">dashboard</a>
      <div id="dyn"></div>
      <iframe id="if1" src="/framevictim" width="320" height="120"></iframe>
      <script>
        window.addEventListener('hashchange', () => {
          document.getElementById('dyn').innerText = location.hash === '#/dashboard' ? 'DASH-LIVE-99 rendered' : '(back to portal)';
        });
      </script>`,
    '/newtab': '<title>arityp</title><h1>NEW-TAB-MARKOR-31</h1>',
    '/framevictim': '<title>framepage</title><p>FRAME-MARKOR-55 insidan</p>',
  }, {});
  const base = `http://127.0.0.1:${srv.address().port}`;
  const reg = await mkReg();
  try {
    const run = (n, a) => reg.exec(n, a, { session: 'd5b' });
    assert.equal((await run('browser.open', { url: base + '/' })).ok, true);
    /* a — dynamic navigation: hash route re-renders WITHOUT reload */
    assert.equal((await run('browser.click', { selector: '#lnk-hash' })).ok, true);
    await WAIT(600);
    const dyn = await run('browser.read', { selector: '#dyn' });
    assert.match(String(dyn.result || ''), /DASH-LIVE-99 rendered/, 'hash-navigation content is proven on screen');
    /* b — target=_blank: click FOLLOWS the new tab (engine meta) */
    const c = await run('browser.click', { selector: '#lnk-new' });
    assert.equal(c.ok, true);
    assert.equal(c.meta?.openedNewTab, true, `engine says it followed the new tab: ${JSON.stringify(c.meta)}`);
    await WAIT(800);
    const nt = await run('browser.read', {});
    assert.match(String(nt.result || ''), /NEW-TAB-MARKOR-31/, 'new-tab content proven');
    /* c — iframe honesty: FIRST navigate the session back to the main page
       (the click above legitimately moved us onto the new tab — reading #if1
       there would be reading the wrong document) */
    const back = await run('browser.open', { url: base + '/' });
    assert.equal(back.ok, true, 'open returns to the main page session');
    const host = await run('browser.read', { selector: '#if1' });
    assert.equal(host.ok, true, 'iframe host element is detected');
    const fr = await run('browser.open', { url: base + '/framevictim' });
    assert.equal(fr.ok, true, 'iframe source page reachable directly');
    const fi = await run('browser.read', {});
    assert.match(String(fi.result || ''), /FRAME-MARKOR-55/, 'frame content PROVEN via the straight path (host open of the frame URL)');
    console.log('5B evidence: newTab followed, hash content, frame via straight path');
  } finally {
    srv.close();
    await reg.exec('browser.close', {}, { session: 'd5b' }).catch(() => {});
  }
});

test('5E multi-step webshop: search→product→cart→checkout→confirm — every step cross-checked against server state', { skip: !LIVE && WHY_SKIP, timeout: 150000 }, async (t) => {
  const shop = { cart: [], orders: 0 };
  const srv = await serve({
    '/': `<title>shop</title><h1>MAJIN shop</h1>
      <form action="/search" method="get"><input id="q" name="q"><button>search</button></form>`,
    '/search': `<title>results</title><h1>results for widget</h1>
      <a id="p1" href="/product/1">Widget X-900</a>`,
    '/product/1': `<title>Widget X-900</title><h1>Widget X-900 - 899 kr</h1>
      <button id="buy" onclick="fetch('/cart', {method:'POST', body:'sku=X900&qty=1'}).then(()=>{location='/cart'})">add to cart</button>`,
    '/cart': `<title>cart</title><h1>cart</h1><div id="items">X900 x1</div>
      <button id="co" onclick="fetch('/order', {method:'POST', body:'cart=X900'}).then(()=>{location='/done'})">checkout</button>`,
    '/done': '<title>done</title><h1>ORDERBEKRÄFTELSE-8: tack for ditt kop X900</h1>',
    thanks: '<h1>posted</h1>',
  }, shop);
  /* /cart and /order arrive as POSTs — count them server-side */
  const base = `http://127.0.0.1:${srv.address().port}`;
  const reg = await mkReg();
  try {
    const run = (n, a) => reg.exec(n, a, { session: 'd5e' });
    const opened = await run('browser.open', { url: base + '/' });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const filled = await run('browser.fill', { selector: '#q', value: 'widget' });
    assert.equal(filled.ok, true, JSON.stringify({ opened: opened.meta, filled }));
    assert.equal((await run('browser.click', { selector: 'button' })).ok, true, 'search submitted');
    await WAIT(900);
    assert.equal((await run('browser.click', { selector: '#p1' })).ok, true, 'product clicked');
    await WAIT(600);
    assert.equal((await run('browser.click', { selector: '#buy' })).ok, true, 'add-to-cart clicked');
    await WAIT(1200);
    /* CROSS-CHECK against SERVER state — the page may lie, the recorder cannot */
    assert.equal(shop.cart.length, 1, `server saw exactly one cart POST: ${JSON.stringify(shop.cart)}`);
    assert.equal(shop.cart[0].sku, 'X900', 'the cart really contains the X900');
    assert.equal((await run('browser.click', { selector: '#co' })).ok, true, 'checkout clicked');
    await WAIT(1300);
    const done = await run('browser.read', {});
    assert.match(String(done.result || ''), /ORDERBEKRÄFTELSE-8/, 'final confirmation on screen');
    /* the ORDER post too — cross-checked in the generic collector */
    assert.ok((shop.posts || []).some((x) => x.path === '/order' && x.params.cart === 'X900'), `order posted with the same cart: ${JSON.stringify(shop.posts)}`);
    console.log('5E server-state: cart=', JSON.stringify(shop.cart), 'orders=', JSON.stringify((shop.posts || []).filter((x) => x.path === '/order')));
  } finally {
    srv.close();
    await reg.exec('browser.close', {}, { session: 'd5e' }).catch(() => {});
  }
});
