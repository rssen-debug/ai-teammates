import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { startTestServer } from './helpers.mjs';

const ui = path.resolve(import.meta.dirname, '../../src/v4/ui');
const engines = process.env.MAJIN_TOUCH_WEBKIT === '1' ? ['chromium', 'webkit'] : ['chromium'];
const legacyWorker = `
self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (new URL(e.request.url).pathname === '/app.css')
    e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request)));
});`;

for (const engine of engines) test(`mobile touch ${engine}: recover from legacy PWA CSS without invisible input blockers`, async (t) => {
  const { chromium, webkit } = await import('playwright');
  let browser;
  try {
    browser = await (engine === 'webkit' ? webkit : chromium).launch({
      ...(engine === 'chromium' && process.env.MAJIN_E2E_CHROMIUM ? { executablePath: process.env.MAJIN_E2E_CHROMIUM } : {}),
    });
  } catch (error) {
    if (engine === 'webkit' || process.env.MAJIN_E2E_CHROMIUM) throw error;
    t.skip(`Chromium unavailable: ${String(error.message).split('\n')[0]}`);
    return;
  }
  const s = await startTestServer();
  let unversioned = true;
  const proxy = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/__legacy-sw.js') {
      res.writeHead(200, { 'content-type': 'text/javascript', 'service-worker-allowed': '/', 'cache-control': 'no-store' });
      return res.end(legacyWorker);
    }
    if (pathname === '/__seed') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><title>Legacy cache fixture</title>');
    }
    if (pathname === '/' && unversioned) {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(path.join(ui, 'index.html'), 'utf8').replace(/\/app\.css\?[^"']+/g, '/app.css'));
    }
    const upstream = http.request(new URL(req.url, s.base), { method: req.method, headers: req.headers }, (incoming) => {
      res.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${proxy.address().port}`;
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => { proxy.close(resolve); proxy.closeAllConnections(); });
    await s.close();
  });
  // Reproduce the original author-display-vs-hidden defect in a stale cache.
  const brokenCss = fs.readFileSync(path.join(ui, 'app.css'), 'utf8')
    .replace(/^\[hidden\]\s*\{[^}]*\}/gm, '')
    .replace(/:(?:not\(\[hidden\]\))/g, '');
  async function device() {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__voiceStarts = 0;
      window.SpeechRecognition = class {
        start() { window.__voiceStarts += 1; this.onstart?.(); }
        stop() { this.onend?.(); }
        abort() { this.onend?.(); }
      };
    });
    const paired = await s.pair();
    assert.equal(paired.res.status, 200);
    const eq = paired.cookie.indexOf('=');
    await context.addCookies([{ name: paired.cookie.slice(0, eq), value: paired.cookie.slice(eq + 1), url: base }]);
    await page.goto(base + '/__seed');
    await page.evaluate(async (css) => {
      await (await caches.open('majin-v4-shell-obsolete')).put('/app.css', new Response(css, { headers: { 'content-type': 'text/css' } }));
      await navigator.serviceWorker.register('/__legacy-sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
    }, brokenCss);
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    return { context, page };
  }
  const old = await device();
  await old.page.goto(base);
  await old.page.waitForFunction(() => document.querySelector('#gate').hidden);
  const blockingId = await old.page.evaluate(() => {
    const r = document.querySelector('#input').getBoundingClientRect();
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('[id]')?.id;
  });
  if (engine === 'chromium') assert.equal(blockingId, 'lightbox', 'counterfactual must detect the actual stale-CSS blocker');
  // WebKit versions can give their UA hidden rule higher priority. Record
  // that outcome honestly; the fixed-page touch checks below remain required.
  t.diagnostic(`legacy stylesheet hit target in ${engine}: ${blockingId}`);
  await old.context.close();
  unversioned = false;
  const { context, page } = await device();
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#gate').hidden);
  async function assertTouchable(selector) {
    const hit = await page.locator(selector).evaluate((target) => {
      const r = target.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { ok: target === top || target.contains(top), hit: top?.closest('[id]')?.id, bottom: r.bottom, viewport: window.visualViewport?.height || innerHeight };
    });
    assert.ok(hit.ok, `${selector} intercepted by ${hit.hit}`);
    assert.ok(hit.bottom <= hit.viewport + 1, `${selector} below the visible viewport`);
  }
  await assertTouchable('#input');
  await assertTouchable('#send-btn');
  await assertTouchable('#mic-btn');
  await page.locator('#input').tap();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'input', 'trusted touchscreen tap focuses the composer');
  await page.keyboard.type('Skriv filen touch-proof.txt med innehåll: touch works');
  await page.locator('#send-btn').tap();
  await page.waitForSelector('.tool[data-state="verified"]');
  await page.waitForFunction(() => document.querySelector('#stop-btn').hidden);
  assert.equal(fs.readFileSync(path.join(s.home, 'workspace/touch-proof.txt'), 'utf8'), 'touch works');
  await page.locator('#mic-btn').tap();
  await page.waitForFunction(() => window.__voiceStarts === 1);
  await page.locator('#mic-btn').tap();
  await page.locator('#file-input').setInputFiles({ name: 'touch-image.png', mimeType: 'image/png', buffer: fs.readFileSync(path.join(ui, 'icons/icon-192.png')) });
  await page.locator('.attach-card img').last().tap();
  await page.waitForSelector('#lightbox:not([hidden])');
  await page.locator('#lightbox-x').tap();
  await page.waitForSelector('#lightbox', { state: 'hidden' });
  await page.locator('#history-btn').tap();
  await page.waitForSelector('#history:not([hidden])');
  await page.locator('#history-close').tap();
  await page.locator('#menu-btn').tap();
  await page.waitForSelector('#sheet:not([hidden])');
  await page.locator('#sheet-backdrop').tap({ position: { x: 10, y: 10 } });
  await page.waitForSelector('#sheet', { state: 'hidden' });
  await assertTouchable('#input');
  // Desktop browser engines do not open iOS's physical keyboard. Exercise its
  // viewport-resize contract explicitly and keep physical acceptance separate.
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => 480 });
    visualViewport.dispatchEvent(new Event('resize'));
  });
  await page.waitForFunction(() => document.querySelector('#composer').getBoundingClientRect().bottom <= 481);
  await assertTouchable('#input');
  await page.locator('#input').tap();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'input');
  await page.evaluate(() => { delete visualViewport.height; visualViewport.dispatchEvent(new Event('resize')); });
  const hiddenBlockers = await page.evaluate(() => [...document.querySelectorAll('[hidden]')].filter((el) => {
    const style = getComputedStyle(el); const r = el.getBoundingClientRect();
    return style.display !== 'none' && style.pointerEvents !== 'none' && r.width > 0 && r.height > 0;
  }).map((el) => el.id));
  assert.deepEqual(hiddenBlockers, []);
  const out = process.env.MAJIN_TOUCH_EVIDENCE;
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    await page.screenshot({ path: path.join(out, `${engine}-iphone13-touch.png`) });
    fs.writeFileSync(path.join(out, `${engine}-iphone13-touch.json`), JSON.stringify({ at: new Date().toISOString(), engine, viewport: '390x844', trustedTouchFocus: true, verifiedFileBytes: true, legacyCacheHitTarget: blockingId, hiddenBlockers, imageModalOpenAndClose: true, voiceButtonHandlerWithStub: true, keyboardViewportSimulation: true, physicalIphoneAcceptance: false }, null, 2));
  }
  await context.close();
});
