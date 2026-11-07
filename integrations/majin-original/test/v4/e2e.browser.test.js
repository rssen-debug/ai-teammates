/**
 * MAJIN V4 — real browser acceptance (phone viewports).
 *
 * This is the test that answers the question screenshots cannot: does the app
 * actually work on a phone-sized screen, end to end, in a real layout engine?
 *
 * It SKIPS (never fakes) when no browser binary is available. Three ways to run it:
 *
 *   1. Playwright's own browser:  npx playwright install chromium
 *   2. Lambda-style chromium:     npm i --no-save @sparticuz/chromium
 *   3. Any Chromium/Chrome:       MAJIN_E2E_CHROMIUM=C:\path\to\chrome.exe
 *
 * Command: npm run v4:e2e
 * Artifacts: docs/v4/evidence/<viewport>-*.png
 *
 * The distinction that matters: this proves layout, flow and streaming in a
 * real engine. It does NOT prove iPhone Safari or Android Chrome — that is a
 * physical-device walkthrough and stays unearned until someone does it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startTestServer } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(here, '../../docs/v4/evidence');

const VIEWPORTS = [
  { name: 'iphone-13', width: 390, height: 844, dpr: 3, mobile: true },
  { name: 'pixel-7', width: 412, height: 915, dpr: 2.6, mobile: true },
  { name: 'iphone-se', width: 375, height: 667, dpr: 2, mobile: true },
  { name: 'ipad', width: 820, height: 1180, dpr: 2, mobile: true },
  { name: 'desktop', width: 1280, height: 800, dpr: 1, mobile: false },
];

async function launchBrowser() {
  const explicit = process.env.MAJIN_E2E_CHROMIUM;
  try {
    const { chromium } = await import('playwright-core');
    if (explicit && fs.existsSync(explicit)) {
      return { browser: await chromium.launch({ executablePath: explicit, args: ['--no-sandbox'] }), engine: explicit };
    }
    try {
      const sparticuz = (await import('@sparticuz/chromium')).default;
      const exe = await sparticuz.executablePath();
      const browser = await chromium.launch({ executablePath: exe, args: [...sparticuz.args, '--no-sandbox'] });
      return { browser, engine: `sparticuz ${sparticuz.args.length} args` };
    } catch { /* not installed: try playwright's own */ }
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    return { browser, engine: 'playwright chromium' };
  } catch (err) {
    return { skip: `no browser available (${String(err.message).split('\n')[0].slice(0, 120)})` };
  }
}

const launched = await launchBrowser();

test('e2e: real browser acceptance on phone viewports', { skip: launched.skip || false }, async (t) => {
  const { browser } = launched;
  const s = await startTestServer();
  fs.mkdirSync(EVIDENCE, { recursive: true });
  try {
    const results = [];
    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: Math.min(vp.dpr, 2),
        isMobile: vp.mobile,
        hasTouch: vp.mobile,
      });
      const page = await context.newPage();
      const consoleErrors = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });

      await page.goto(s.base, { waitUntil: 'load' });
      await page.waitForSelector('#gate', { state: 'visible', timeout: 10_000 });

      // ---- layout invariants that break on real phones -------------------
      const layout = await page.evaluate(() => {
        const rect = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom };
        };
        return {
          scrollW: document.scrollingElement.scrollWidth,
          clientW: document.scrollingElement.clientWidth,
          innerH: window.innerHeight,
          composer: rect('#composer'),
          gateCard: rect('.gate-card'),
          input: rect('#input'),
          send: rect('#send-btn'),
          mic: rect('#mic-btn'),
          manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href') || null,
          themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') || null,
          title: document.title,
        };
      });

      // no horizontal overflow (the classic mobile killer)
      assert.ok(
        layout.scrollW <= layout.clientW + 1,
        `${vp.name}: horizontal overflow ${layout.scrollW} > ${layout.clientW}`,
      );
      // composer is on screen, not pushed below the fold
      assert.ok(layout.composer && layout.composer.bottom <= layout.innerH + 1, `${vp.name}: composer off-screen`);
      assert.ok(layout.composer.y > 0, `${vp.name}: composer above the top`);
      // touch targets are big enough to hit
      for (const [name, box] of [['send', layout.send], ['mic', layout.mic]]) {
        assert.ok(box, `${vp.name}: ${name} missing`);
        assert.ok(box.w >= 40 && box.h >= 40, `${vp.name}: ${name} target ${box.w}x${box.h} too small`);
      }
      assert.equal(layout.manifest, '/manifest.webmanifest');
      assert.ok(layout.themeColor);
      await page.screenshot({ path: path.join(EVIDENCE, `${vp.name}-gate.png`) });

      // ---- pair, send a real message, see a verified result ---------------
      await page.fill('#gate-code', s.context.pairingFresh);
      await page.click('#gate-submit');
      await page.waitForSelector('#gate', { state: 'hidden', timeout: 10_000 });
      await page.waitForSelector('#hero', { state: 'visible' });

      await page.fill('#input', 'Skriv filen e2e-' + vp.name + '.txt med innehåll: klart');
      await page.click('#send-btn');

      // the tool card must reach the verified state, driven by the server
      // Read state and summary in one browser task. An incremental history
      // refresh may replace the transcript between two separate locator calls.
      const verified = await page.waitForFunction(() => {
        const text = document.querySelector('.tool[data-state="verified"] .tool-summary')?.textContent;
        return text?.trim() || false;
      }, null, { timeout: 15_000 });
      const toolText = await verified.jsonValue();
      assert.ok(toolText && toolText.length > 0, `${vp.name}: tool summary empty`);
      assert.equal(fs.readFileSync(path.join(s.home, 'workspace', `e2e-${vp.name}.txt`), 'utf8'), 'klart',
        `${vp.name}: verified tool card must correspond to actual saved bytes`);

      // the answer arrives as text, and the conversation id survives a reload
      await page.waitForFunction(() => {
        const msgs = document.querySelectorAll('.msg[data-role="assistant"] .msg-body');
        return msgs.length > 0 && msgs[msgs.length - 1].textContent.trim().length > 10;
      }, { timeout: 15_000 });

      // Reload the actual browser context, not just the message list. Durable
      // receipts must be available in the same way on another PWA client.
      await page.waitForSelector('#stop-btn', { state: 'hidden', timeout: 15_000 });
      await page.reload({ waitUntil: 'load' });
      try {
        await page.waitForSelector('.tool[data-state="verified"][data-historical="true"]', { timeout: 15_000 });
      } catch (error) {
        t.diagnostic(JSON.stringify({ viewport: vp.name, consoleErrors,
          thread: await page.textContent('#thread'), bookmark: await page.evaluate(() => localStorage.getItem('majin.conversationId')) }));
        throw error;
      }
      assert.match(await page.textContent('.tool[data-historical="true"] .tool-summary'), new RegExp(`e2e-${vp.name}\\.txt`));

      const overflowAfter = await page.evaluate(() => ({
        scrollW: document.scrollingElement.scrollWidth,
        clientW: document.scrollingElement.clientWidth,
      }));
      assert.ok(overflowAfter.scrollW <= overflowAfter.clientW + 1, `${vp.name}: overflow after chat`);

      await page.screenshot({ path: path.join(EVIDENCE, `${vp.name}-chat.png`), fullPage: false });

      // no uncaught script errors in the console
      const realErrors = consoleErrors.filter((e) => !/favicon|manifest/i.test(e));
      assert.deepEqual(realErrors, [], `${vp.name}: console errors`);

      results.push({ viewport: vp.name, w: vp.width, h: vp.height, verifiedTool: true, historicalReceipts: true });
      await context.close();
    }

    fs.writeFileSync(
      path.join(EVIDENCE, 'browser-run.json'),
      `${JSON.stringify({ at: new Date().toISOString(), engine: launched.engine, node: process.versions.node, results }, null, 2)}\n`,
    );
    t.diagnostic(`verified ${results.length} viewports with ${launched.engine}`);
  } finally {
    await browser.close();
    await s.close();
  }
});
