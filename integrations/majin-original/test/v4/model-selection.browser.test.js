// Controlled local browser regression, NOT physical iPhone or live Go acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startTestServer, tempHome } from './helpers.mjs';

for (const engine of ['chromium', 'webkit']) test(`model selector ${engine}: mobile touch, billing consent, search and desktop synchronization`, async (t) => {
  const browsers = await import('playwright');
  let browser;
  const explicit = engine === 'chromium' && process.env.MAJIN_E2E_CHROMIUM;
  try { browser = await browsers[engine].launch(explicit ? { executablePath: explicit } : {}); }
  catch (error) { if (explicit) throw error; t.skip(`${engine} unavailable: ${error.message.split('\n')[0]}`); return; }
  const home = tempHome();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ providers: { test: { label: 'Test catalogue', kind: 'openai', baseUrl: 'https://controlled.invalid/v1', apiKey: 'test-secret', models: ['one', 'two'] } }, models: { routes: { chat: 'test/one' } } }));
  const s = await startTestServer({ home });
  t.after(async () => { await browser.close(); await s.close(); });
  async function client(mobile) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 }, isMobile: mobile, hasTouch: mobile });
    const { cookie } = await s.pair(); const eq = cookie.indexOf('=');
    await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url: s.base }]);
    const page = await context.newPage();
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(s.base);
    await page.waitForFunction(() => document.querySelector('#gate').hidden && document.querySelectorAll('[data-model-id]').length === 2);
    await page.locator('#menu-btn').click();
    return { page, errors };
  }
  const mobile = await client(true), desktop = await client(false);
  const choice = mobile.page.locator('[data-model-id="test/two"]');
  assert.match(await choice.textContent(), /Cost unknown — verify with provider/);
  await mobile.page.locator('#model-search').fill('two');
  assert.equal(await mobile.page.locator('[data-model-id]').count(), 1);
  await mobile.page.locator('#model-included').check();
  assert.equal(await mobile.page.locator('[data-model-id]').count(), 0, 'unknown models never appear as subscription-included');
  await mobile.page.locator('#model-included').uncheck();
  let allow = false, dialogs = 0;
  mobile.page.on('dialog', async (dialog) => { dialogs++; assert.match(dialog.message(), /Cost unknown/); if (allow) await dialog.accept(); else await dialog.dismiss(); });
  await choice.tap();
  assert.equal(await mobile.page.evaluate(async () => (await (await fetch('/api/models')).json()).selection.version), 0);
  allow = true;
  await choice.tap();
  await mobile.page.waitForFunction(() => document.querySelector('[data-model-id="test/two"]')?.getAttribute('aria-checked') === 'true');
  await desktop.page.waitForFunction(() => document.querySelector('[data-model-id="test/two"]')?.getAttribute('aria-checked') === 'true', { timeout: 15000 });
  assert.equal(await desktop.page.locator('#model-label').textContent(), 'two');
  assert.equal(dialogs, 2);
  const overflow = await mobile.page.locator('#sheet').evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  assert.equal(overflow, false, 'cost labels and model identifiers fit mobile sheet');
  assert.deepEqual([...mobile.errors, ...desktop.errors], []);
  t.diagnostic('Local controlled catalogue only; neither Go subscription inclusion nor physical iPhone acceptance is claimed.');
});
