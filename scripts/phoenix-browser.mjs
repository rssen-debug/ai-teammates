/** Real browser acceptance against a disposable MAJIN server. No paid calls. */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-ui-'));
const port = 19000 + Math.floor(Math.random() * 1000);
const output = process.env.MAJIN_UI_OUTPUT || path.resolve('work/ui-evidence');
fs.mkdirSync(output, { recursive: true });
const child = spawn(process.execPath, ['src/cli/majin.js', '_serve', '--no-window', '--no-channels'], {
  env: { ...process.env, MAJIN_HOME: home, MAJIN_PORT: String(port), MAJIN_NO_UPDATE_CHECK: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let browser, page;
try {
  let ready = false;
  child.stdout.on('data', d => { if (String(d).includes('listening on')) ready = true; });
  for (let i = 0; !ready && i < 100; i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(ready, 'server starts');
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  const token = cfg.server.token;
  browser = await chromium.launch({ headless: true, ...(process.env.MAJIN_UI_BROWSER ? { channel: process.env.MAJIN_UI_BROWSER } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/?t=${token}`);
  await page.waitForFunction(() => window.MAJIN_ONBOARD && document.querySelector('#home'));
  // Regression for the real Windows titlebar/taskbar icon mismatch: Chromium
  // --app uses the page favicon, not the icon embedded in MAJIN-Setup.exe.
  const iconUrl = await page.locator('link[rel="icon"]').getAttribute('href');
  assert.match(iconUrl, /^\/logo\.png\?v=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'versioned favicon defeats stale Edge taskbar cache');
  const logoResponse = await page.request.get(`http://127.0.0.1:${port}/logo.png?t=${token}`);
  assert.equal(logoResponse.status(), 200, 'pink MAJIN logo served to the app window');
  assert.equal(logoResponse.headers()['content-type'], 'image/png');
  assert.deepEqual(await logoResponse.body(), fs.readFileSync(path.resolve('assets/majin.png')),
    'the actual browser/favicon bytes must match the Windows installer icon source');
  assert.equal(await page.locator('header img.logo').getAttribute('src'), '/logo.png',
    'in-app header and Windows taskbar both request the same canonical image');
  const rejectedApproval = await page.evaluate(async () => {
    const box = approvalCard({ id: 'audit-expired-approval', tool: 'audit.no-execution', reason: 'test rejected acknowledgment' });
    await respond('audit-expired-approval', true, box);
    const enabled = [...box.querySelectorAll('button')].every(button => !button.disabled);
    box.remove();
    return enabled;
  });
  assert.equal(rejectedApproval, true, 'rejected approval acknowledgment never turns into a false allowed state');
  if (await page.locator('#ob-skip').isVisible()) await page.locator('#ob-skip').click();
  assert.equal(await page.evaluate(() => window.__MAJIN_TOKEN__), token, 'server does not rewrite variable names');
  assert.equal(await page.locator('#home h2').textContent(), 'What’s next?');
  assert.equal(await page.locator('#home button').count(), 0, 'welcome stays uncluttered');
  assert.equal(await page.locator('#send').isDisabled(), true, 'empty message cannot be sent');
  await page.locator('#input').fill('A new idea');
  assert.equal(await page.locator('#send').isEnabled(), true);
  const control = await page.locator('#send').evaluate(button => {
    const style = getComputedStyle(button);
    return { width: button.offsetWidth, height: button.offsetHeight, radius: style.borderRadius };
  });
  assert.deepEqual(control, { width: 44, height: 44, radius: '50%' });
  await page.locator('#send').hover();
  await page.screenshot({ path: path.join(output, 'send-ready.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.home-emblem i').first().evaluate(node => getComputedStyle(node).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('#input').fill('');
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(output, 'phoenix-home.png') });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.screenshot({ path: path.join(output, 'aurora-wide-home.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const catalog = Array.from({ length: 1200 }, (_, i) => ({ id: `vendor/model-${i}:free`, name: `Model ${String(i).padStart(4, '0')}`, free: i % 2 === 0, input: i % 2, output: i % 2, context: (i + 1) * 1000, tools: i % 3 !== 0, vision: i % 4 === 0 }));
  await page.route('**/api/models?**', r => r.fulfill({ json: { ok: true, catalog, models: catalog.map(m => m.id) } }));
  const providerActions = [];
  await page.route('**/api/provider?**', r => {
    providerActions.push(r.request().postDataJSON().action);
    return r.fulfill({ json: { ok: true } });
  });
  await page.locator('#manage-providers').click();
  await page.locator('#ob-choice').selectOption('deepseek');
  await page.locator('.ob-choose').click();
  if (await page.locator('#ob-body input[type=password]').count()) await page.locator('#ob-body input[type=password]').fill('ui-fixture-not-a-real-key');
  await page.locator('#ob-body .ob-go').click();
  await page.waitForFunction(() => !document.querySelector('#modeldrop').hidden);
  assert.ok(providerActions.every(action => action === 'add'), 'onboarding never probes a preset model or makes paid inference calls');
  await page.unroute('**/api/provider?**');
  await page.keyboard.press('Escape');
  await page.locator('#manage-providers').click();
  await page.getByText('More options', { exact: true }).click();
  await page.getByRole('button', { name: 'Use a custom API endpoint', exact: true }).click();
  await page.getByLabel('API protocol', { exact: true }).selectOption('anthropic');
  await page.getByLabel('Connection name', { exact: true }).fill('audit-anthropic');
  await page.getByLabel('Endpoint URL', { exact: true }).fill(`http://127.0.0.1:${port}/fixture/v1`);
  await page.locator('#ob-body input[type=password]').fill('ui-fixture-not-real');
  await page.screenshot({ path: path.join(output, 'custom-provider-protocol.png') });
  await page.locator('#ob-body .ob-go').click();
  await page.waitForFunction(() => document.querySelector('select[aria-label="Provider"]')?.value === 'audit-anthropic');
  const customConfig = await page.evaluate(async () => (await window.MAJIN_ONBOARD.api('/config')).config.providers['audit-anthropic']);
  assert.equal(customConfig.kind, 'anthropic');
  assert.equal(customConfig.baseUrl, `http://127.0.0.1:${port}/fixture/v1`);

  await page.keyboard.press('Escape');
  await page.locator('#c-model').click();
  await page.waitForFunction(() => document.querySelector('.explorer-count')?.textContent.includes('1200'));
  assert.equal(await page.locator('.ob-model').count(), 60);
  await page.getByRole('button', { name: 'Show more models' }).click();
  assert.equal(await page.locator('.ob-model').count(), 120);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('button', { name: 'Vision', exact: true }).click();
  await page.getByRole('button', { name: '128k+ context', exact: true }).click();
  assert.match(await page.locator('.explorer-count').textContent(), /179 of 1200/);
  await page.getByRole('combobox', { name: 'Sort models' }).selectOption('context');
  const topContext = await page.locator('.model-meta').first().textContent();
  assert.ok(topContext.includes('1197k'), 'context sorting uses real metadata');
  await page.locator('.model-inspect').first().click();
  await page.getByRole('heading', { name: 'Model 1196' }).waitFor();
  assert.ok(await page.locator('.model-detail').getByText('Supported', { exact: true }).count());
  await page.screenshot({ path: path.join(output, 'aurora-model-detail.png') });
  await page.getByRole('button', { name: 'Back to models' }).click();
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('button', { name: 'Vision', exact: true }).click();
  await page.getByRole('button', { name: '128k+ context', exact: true }).click();
  await page.getByRole('combobox', { name: 'Sort models' }).selectOption('name');

  await page.getByRole('button', { name: 'Free only', exact: true }).click();
  assert.match(await page.locator('.explorer-count').textContent(), /600 of 1200/);
  await page.getByRole('textbox', { name: 'Search models' }).fill('model-1198');
  assert.equal(await page.locator('.ob-model').count(), 1);
  await page.locator('.ob-model').click();
  await page.waitForFunction(() => document.querySelector('#modeldrop').hidden);
  const saved = await page.evaluate(() => window.MAJIN_ONBOARD.api('/config'));
  assert.ok(Object.values(saved.config.models.routes).every(r => r.endsWith('/vendor/model-1198:free')), 'exact provider IDs saved for every route');
  await page.locator('#c-model').click();
  await page.waitForFunction(() => document.querySelector('.explorer-count')?.textContent.includes('1200'));
  await page.getByRole('button', { name: 'Free only', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'phoenix-models.png') });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#c-model').evaluate(n => n === document.activeElement), true);
  // Task visualization is a view of API snapshots, never invented worker roles.
  const taskFixture = [
    { id: 'fixture-research', input: 'Research an interface direction', status: 'running', source: 'ui', toolsRun: 2, curTool: 'web.search', created: Date.now(), updated: Date.now() },
    { id: 'fixture-build', input: 'Build the selected design', status: 'waiting', source: 'ui', toolsRun: 1, created: Date.now() - 500, updated: Date.now() },
  ];
  await page.route('**/api/tasks?**', r => r.fulfill({ json: { ok: true, tasks: taskFixture } }));
  await page.locator('#b-studio').click();
  await page.waitForSelector('[data-task="fixture-research"]');
  await page.evaluate(() => window.MAJIN_STUDIO.updateTasks(Array.from({ length: 45 }, (_, i) => ({ id: 'fixture-' + i, input: 'Task ' + i, status: 'running', created: i, updated: i }))));
  assert.equal(await page.locator('.agent-node').count(), 30);
  await page.getByRole('button', { name: 'Show more tasks' }).click();
  assert.equal(await page.locator('.agent-node').count(), 45);
  await page.evaluate(tasks => window.MAJIN_STUDIO.updateTasks(tasks), taskFixture);
  await page.locator('[data-task="fixture-research"]').click();
  assert.equal(await page.locator('#task-count').textContent(), '2');
  await page.evaluate(() => window.MAJIN_STUDIO.setState('thinking'));
  assert.notEqual(await page.locator('#run-state .living-orb i').first().evaluate(n => getComputedStyle(n).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('#run-state .living-orb i').first().evaluate(n => getComputedStyle(n).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.screenshot({ path: path.join(output, 'aurora-activity.png') });
  let stoppedTask = '';
  await page.route('**/api/chat/stop?**', r => {
    stoppedTask = r.request().postDataJSON().task;
    taskFixture[0].status = 'stopped';
    return r.fulfill({ json: { ok: true } });
  });
  await page.getByRole('button', { name: 'Stop this task' }).click();
  await page.waitForFunction(() => document.querySelector('[data-task="fixture-research"]').dataset.state === 'stopped');
  assert.equal(stoppedTask, 'fixture-research');
  await page.unroute('**/api/chat/stop?**');
  await page.evaluate(() => {
    const task = { id: 'fixture-research', input: 'Continue research', status: 'running', run: 2, source: 'ui', created: 1, updated: Date.now() + 1 };
    window.MAJIN_STUDIO.updateTasks([task]);
  });
  assert.equal(await page.locator('[data-task="fixture-research"]').getAttribute('data-state'), 'running', 'explicit next run reopens a completed Workspace task');
  const previewPath = path.join(home, 'workspace', 'aurora-preview.html');
  fs.mkdirSync(path.dirname(previewPath), { recursive: true });
  fs.writeFileSync(previewPath, '<!doctype html><style>body{margin:0;background:#f5f1e9;color:#253830;font:16px/1.6 Georgia;padding:36px}small{letter-spacing:3px;font:10px Arial}h1{font-size:46px;line-height:1.1;margin-top:65px}p{color:#617268}article{border-top:1px solid #c5cbbd;margin-top:55px;padding-top:24px}</style><small>FIELDNOTES / STUDIO</small><h1>Ideas deserve<br>room to grow.</h1><p>A real local HTML file, displayed through MAJIN’s workspace API.</p><article>Browser acceptance fixture</article><script>document.body.dataset.unsafe="executed"</script>');
  await page.evaluate(p => window.MAJIN_STUDIO.onEvent({ type: 'tool_result', ok: true, meta: { path: p } }), previewPath);
  await page.getByRole('tab', { name: /^Files/ }).click();
  await page.getByRole('button', { name: /aurora-preview.html/ }).click();
  await page.waitForSelector('.studio-preview-frame');
  await page.getByRole('button', { name: 'Widen preview' }).click();
  assert.equal(await page.evaluate(() => document.body.classList.contains('studio-wide')), true);
  await page.screenshot({ path: path.join(output, 'aurora-preview-wide.png') });
  await page.getByRole('button', { name: 'Restore width' }).click();
  assert.equal(await page.locator('.studio-preview-frame').getAttribute('sandbox'), '');
  await page.frameLocator('.studio-preview-frame').getByRole('heading', { name: 'Ideas deserve room to grow.' }).waitFor();
  assert.equal(await page.frameLocator('.studio-preview-frame').locator('body').getAttribute('data-unsafe'), null);
  await page.screenshot({ path: path.join(output, 'aurora-preview.png') });
  const downloaded = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download', exact: true }).click();
  const downloadedFile = await downloaded;
  assert.equal(fs.readFileSync(await downloadedFile.path(), 'utf8'), fs.readFileSync(previewPath, 'utf8'), 'Download returns the actual file bytes');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#studio').isVisible(), false);
  await page.locator('#b-studio').click();
  await page.locator('#c-model').click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#studio').isVisible(), true, 'Escape closes the model dialog without dismissing its workspace');
  await page.keyboard.press('Escape');
  await page.locator('#b-expert').click();
  assert.equal(await page.getByRole('tab', { name: 'Settings', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.evaluate(() => document.body.classList.contains('simple')), true, 'advanced settings stay contextual');
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  assert.equal(await page.evaluate(() => document.body.classList.contains('light')), true);
  await page.waitForFunction(() => !document.body.classList.contains('theme-changing'));
  await page.screenshot({ path: path.join(output, 'aurora-settings-light.png') });
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByRole('tab', { name: 'Activity', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: /^Files/ }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Escape');
  await page.unroute('**/api/tasks?**');
  await page.locator('#chat-search').fill('no-such-conversation');
  assert.equal(await page.locator('#chat-empty').isVisible(), true);
  await page.locator('#chat-search').fill('');
  await page.evaluate(() => window.MAJIN_STUDIO.setState('idle'));
  const stream = events => events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  for (const status of [400, 401, 402, 404, 429, 500]) {
    await page.route('**/api/chat?**', r => r.fulfill({ contentType: 'text/event-stream', body: stream([
      ['error', { message: `${status}: deepseek/deepseek-flash is not a valid model ID` }],
      ['delta', { text: 'Late content must not replace the error' }],
      ['answer', { type: 'answer', text: 'False success' }], ['done', { ok: false }],
    ]) }));
    await page.locator('#input').fill('hi'); await page.locator('#send').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Request failed'));
    await page.waitForFunction(() => document.querySelector('#send').getAttribute('aria-label') === 'Send message');
    assert.equal(await page.locator('#input').inputValue(), 'hi');
    assert.equal(await page.getByText('False success', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Late content must not replace the error', { exact: true }).count(), 0);
    assert.equal(await page.locator('#imagine .core-label').textContent(), 'something went wrong');
    await page.unroute('**/api/chat?**');
  }
  await page.screenshot({ path: path.join(output, 'phoenix-error.png') });
  assert.equal(await page.locator('.msg.err').count(), 6, 'one error card per failed request');
  await page.locator('#new-chat').click();
  await page.waitForSelector('#home');
  await page.route('**/api/chat?**', r => r.fulfill({ contentType: 'text/event-stream', body: stream([
    ['route', { job: 'chat', model: 'test/model' }], ['compact', { tokens: 20000 }], ['escalate', { to: 'test/model' }], ['thinking', { text: 'internal reasoning must stay out of chat' }], ['delta', { text: 'Hello. ' }], ['delta', { text: 'Ready to create.' }],
    ['answer', { text: 'Hello. Ready to create.' }], ['done', { ok: true }],
  ]) }));
  await page.locator('#input').fill('hello'); await page.locator('#input').press('Enter');
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Ready');
  assert.equal(await page.getByText('Hello. Ready to create.', { exact: true }).count(), 1);
  assert.equal(await page.locator('.msg.sys').count(), 0, 'routing, compaction and escalation do not spam transcript');
  assert.equal(await page.locator('#scroller').getByText('internal reasoning must stay out of chat').count(), 0);
  await page.screenshot({ path: path.join(output, 'phoenix-chat.png') });
  await page.unroute('**/api/chat?**');
  await page.route('**/api/chat?**', r => r.fulfill({ contentType: 'text/event-stream', body: stream([
    ['answer', { text: 'An answer without deltas.' }], ['done', { ok: true }],
  ]) }));
  await page.locator('#input').fill('answer only'); await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Ready');
  assert.equal(await page.getByText('An answer without deltas.', { exact: true }).count(), 1);
  await page.unroute('**/api/chat?**');
  await page.route('**/api/chat?**', r => r.fulfill({ status: 401, json: { error: 'Unauthorized' } }));
  await page.locator('#input').fill('auth check'); await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Request failed'));
  assert.equal(await page.locator('#imagine .core-label').textContent(), 'something went wrong');
  await page.unroute('**/api/chat?**');
  await page.locator('#new-chat').click();
  await page.waitForSelector('#home');
  assert.equal(await page.locator('#input').inputValue(), '', 'new chat clears prior failed draft');
  assert.equal(await page.locator('#status').textContent(), 'Ready', 'new chat clears stale failure status');
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileOverflow = await page.evaluate(() => {
    const vw = innerWidth, actual = document.documentElement.scrollWidth;
    const bad = [...document.querySelectorAll('*')].map(el => {
      const st = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { el, st, r };
    }).filter(({ st, r }) => st.display !== 'none' && st.visibility !== 'hidden' &&
      r.width > 0 && r.height > 0 && r.right > vw + 1)
      .map(({ el, r }) => ({
        tag: el.tagName.toLowerCase(), id: el.id, cls: String(el.className?.baseVal ?? el.className ?? '').slice(0,80),
        x: Math.round(r.x), width: Math.round(r.width), right: Math.round(r.right),
      })).sort((a,b)=>b.right-a.right).slice(0,20);
    return { viewport: vw, scrollWidth: actual, offenders: bad };
  });
  console.log('MOBILE_OVERFLOW_EVIDENCE ' + JSON.stringify(mobileOverflow));
  assert.equal(mobileOverflow.scrollWidth > mobileOverflow.viewport, false, 'mobile has no horizontal overflow');
  await page.screenshot({ path: path.join(output, 'phoenix-small.png') });
  await page.locator('#b-rail').click();
  assert.equal(await page.locator('#new-chat').isVisible(), true, 'mobile sidebar is reachable');
  await page.locator('#b-rail').click();
  await page.locator('#b-studio').click();
  const drawer = await page.locator('#studio').boundingBox();
  assert.ok(drawer.x >= 0 && drawer.x + drawer.width <= 390, 'workspace fits narrow Windows window');
  await page.screenshot({ path: path.join(output, 'aurora-small-workspace.png') });
  await page.keyboard.press('Escape');
  await page.locator('#c-model').click();
  await page.waitForFunction(() => document.querySelector('.explorer-count')?.textContent.includes('1200'));
  const box = await page.locator('#modeldrop').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, 'picker fits small viewport');
  await page.screenshot({ path: path.join(output, 'phoenix-small-models.png') });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(async () => {
    const c = await window.MAJIN_ONBOARD.api('/config');
    const routes = Object.fromEntries(Object.keys(c.config.models.routes).map(k => [k, 'demo/demo-fast']));
    await window.MAJIN_ONBOARD.api('/config', { method: 'PATCH', body: { models: { provider: 'demo', routes }, moa: { policy: 'off' } } });
  });
  await page.evaluate(() => command('/budget 7'));
  const budgetConfig = await page.evaluate(async () => (await window.MAJIN_ONBOARD.api('/config')).config.budget);
  assert.equal(budgetConfig.mode, 'cap', 'chat budget command enables the enforced cap');
  assert.equal(budgetConfig.monthlyUsd, 7);
  await page.locator('#input').fill('hi'); await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('#send').getAttribute('aria-label') === 'Stop response');
  assert.equal(await page.locator('#send').isEnabled(), true, 'Stop remains available with an empty draft');
  await page.screenshot({ path: path.join(output, 'send-stop.png'), animations: 'disabled' });
  await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Stopped');
  assert.equal(await page.locator('#imagine .core-label').textContent(), 'stopped');
  await page.locator('#input').fill('hi'); await page.locator('#send').click();
  await page.waitForFunction(() => S.busy && S.taskId);
  await page.evaluate(() => window.MAJIN_CHAT.stopTask(S.taskId));
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Stopped');
  assert.equal(await page.locator('.msg.err').count(), 0, 'Workspace cancellation is acknowledged without an error card');
  const beforeFailedStop = await page.locator('.msg.majin .body').count();
  await page.route('**/api/chat/stop?**', async r => { await new Promise(resolve => setTimeout(resolve, 700)); await r.fulfill({ status: 503, json: { error: 'Stop unavailable' } }); });
  await page.locator('#input').fill('hi'); await page.locator('#send').click();
  await page.waitForFunction(() => S.busy && S.taskId);
  const stopFailure = await page.evaluate(async () => { try { await window.MAJIN_CHAT.stopTask(S.taskId); return false; } catch { return true; } });
  assert.equal(stopFailure, true);
  await page.unroute('**/api/chat/stop?**');
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Ready');
  assert.equal(await page.locator('.msg.majin .body').count(), beforeFailedStop + 1, 'failed stop preserves the real answer without duplication or false stopped status');

  await page.locator('#input').fill('hi'); await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Ready');
  assert.ok(await page.getByText('I am in demo mode', { exact: false }).count(), 'real backend mock streams through actual HTTP endpoint');
  if (process.env.MAJIN_UI_LIVE_CATALOG === '1') {
    await page.unroute('**/api/models?**');
    await page.locator('#c-model').click();
    await page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('openrouter');
    await page.waitForFunction(() => document.querySelector('.explorer-count')?.textContent.includes(' of '));
    await page.getByRole('button', { name: 'Free only', exact: true }).click();
    console.log('Live catalog: ' + await page.locator('.explorer-count').textContent());
    await page.screenshot({ path: path.join(output, 'aurora-live-catalog.png') });
    await page.keyboard.press('Escape');
  }
  // The header update control is intentionally hidden on narrow mobile layouts.
  // Assert its desktop behavior in desktop viewport, then keep the safe fixture.
  await page.setViewportSize({ width: 1440, height: 900 });
  // Check updates is always visible: even if GitHub has not replied yet,
  // the user never needs CMD to retry. Cache data from CLI must also show.
  await page.evaluate(() => paintHeader({ ...S.st, update: null,
    config: { ...S.st.config, updates: { check: true, latest: '99.0.0' } } }));
  assert.equal(await page.locator('#c-update').isVisible(), true, 'cache immediately displays the update');
  assert.match(await page.locator('#c-update').textContent(), /Update.*99.0.0/i);
  await page.evaluate(() => paintHeader({ ...S.st, update: null,
    config: { ...S.st.config, updates: { check: true, latest: null } } }));
  assert.equal(await page.locator('#c-update').isVisible(), true, 'manual check stays visible even with no release result');
  assert.match(await page.locator('#c-update').textContent(), /Check updates/i);
  // Update controls use a fixture acknowledgment; never install over this machine.
  const updateFixture = { latest: '99.0.0', available: true, status: 'available', notice: 'New release' };
  await page.evaluate(upd => paintHeader({ ...S.st, update: upd }), updateFixture);
  assert.equal(await page.locator('#c-update').isVisible(), true);
  await page.locator('#c-update').click();
  await page.evaluate(upd => paintHeader({ ...S.st, update: upd }), updateFixture);
  assert.match(await page.locator('#c-update').textContent(), /install.*99.0.0/i);
  let installRequests = 0;
  await page.route('**/api/update?**', async r => { installRequests++; await new Promise(resolve => setTimeout(resolve, 250)); await r.fulfill({ json: { ok: false, error: 'fixture installer declined' } }); });
  await page.locator('#c-update').click();
  await page.evaluate(upd => paintHeader({ ...S.st, update: upd }), updateFixture);
  assert.equal(await page.locator('#c-update').isDisabled(), true, 'refresh cannot allow a duplicate install');
  await page.waitForFunction(() => !document.querySelector('#c-update').disabled);
  assert.equal(installRequests, 1);
  await page.unroute('**/api/update?**');
  await page.evaluate(() => paintHeader({ ...S.st, update: { latest: S.st.version, status: 'up_to_date', available: false, notice: '' } }));
  assert.equal(await page.locator('#c-update').isVisible(), true, 'Check updates remains discoverable even when current');
  assert.match(await page.locator('#c-update').textContent(), /Check updates/i);
  await page.locator('#input').fill('Keep this unsent draft');
  await page.evaluate(() => { S.session = 'audit-update-resume'; });
  let stateRequests = 0;
  await page.route('**/api/state?**', async r => {
    if (++stateRequests !== 1) return r.continue();
    const result = await r.fetch(); const state = await result.json(); state.version = '99.0.0';
    await r.fulfill({ json: state });
  });
  await Promise.all([page.waitForEvent('domcontentloaded'), page.evaluate(() => refresh(true)).catch(() => {})]);
  await page.waitForFunction(() => S.session === 'audit-update-resume' && document.querySelector('#input').value === 'Keep this unsent draft');
  assert.equal(await page.locator('#send').isEnabled(), true);
  await page.unroute('**/api/state?**');
  await page.locator('#input').fill('');
  const longChat = await page.evaluate(() => {
    const t = performance.now();
    for (let i = 0; i < 300; i++) addMsg(i % 2 ? 'majin' : 'user', i % 2 ? 'MAJIN' : 'You', 'History message ' + i);
    const scroller = document.querySelector('#scroller'); scroller.scrollTop = 100;
    scroller.dispatchEvent(new Event('scroll'));
    appendDelta('A new response while reading older messages.');
    return { top: scroller.scrollTop, milliseconds: performance.now() - t };
  });
  assert.equal(longChat.top, 100, 'streaming preserves scroll position while reading history');
  console.log('Long conversation render (300 messages): ' + Math.round(longChat.milliseconds) + 'ms');
  assert.deepEqual(errors, [], 'no browser JavaScript errors');
  console.log('PASS: startup, token injection, 1200 models, pagination, free filter, search, exact route save, Escape/focus, 6 provider errors, no false success, streamed answer, clean transcript, new chat, small viewport, contextual settings, task snapshot controls, file download, sandbox preview, capability intersection and reduced motion; no paid calls.');
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(output, 'acceptance-failure.png') });
    console.error((await page.locator('#modeldrop').innerText()).slice(0, 1400));
  }
  throw error;
} finally {
  await browser?.close(); child.kill();
  // Keep disposable MAJIN data for debugging, never write user credentials here.
}
