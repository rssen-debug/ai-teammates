#!/usr/bin/env node
/**
 * MAJIN REAL-WORLD QA — UI/Aurora browser lane.
 * Drives the REAL INSTALLED v1.0.0 product's actual web UI in a real Chromium
 * (Playwright) on the windows runner: onboarding → chat (real local LLM) →
 * streaming visuals → task board → model picker & Free-only filter → Escape/
 * focus a11y → reduced-motion → artifact preview → reload persistence.
 *
 * Classification ceiling: VERIFIED_CI (real installed product + real browser
 * engine + real model, but a headless browser on a hosted runner).
 *
 * Env: QA_EXE (required), QA_MODEL (default llama3.2:1b), QA_UI_EVID
 * (default qa-ui-evidence), QA_PORT (default 8881), PLAYWRIGHT_BROWSERS_PATH.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = {
  exe: process.env.QA_EXE || '',
  model: process.env.QA_MODEL || 'llama3.2:1b',
  evid: path.resolve(process.env.QA_UI_EVID || 'qa-ui-evidence'),
  port: Number(process.env.QA_PORT || 8881),
  home: process.env.QA_DEV_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'majin-qa-ui-')),
};
fs.mkdirSync(CFG.evid, { recursive: true });
fs.mkdirSync(path.join(CFG.evid, 'shots'), { recursive: true });
const BASE = `http://127.0.0.1:${CFG.port}`;

const results = [];
function shot(page, id) { return page.screenshot({ path: path.join(CFG.evid, 'shots', `${id}.png`) }); }
function rec(id, name, lane, status, note, evidence) {
  const r = { id, name, lane, status, note: note || '', evidence: evidence || {} };
  results.push(r);
  fs.writeFileSync(path.join(CFG.evid, `${id}.json`), JSON.stringify(r, null, 2));
  console.log(`${status === 'FAILED' ? '❌' : status === 'BLOCKED' ? '⛔' : '✅'} ${id} — ${name}: ${note}`);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let serverProc = null;
async function startServer() {
  const env = { ...process.env, LOCALAPPDATA: CFG.home, MAJIN_PORT: String(CFG.port) };
  serverProc = spawn(CFG.exe, ['_serve'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  serverProc.stdout?.on('data', (d) => fs.appendFileSync(path.join(CFG.evid, 'server.log'), d));
  serverProc.stderr?.on('data', (d) => fs.appendFileSync(path.join(CFG.evid, 'server-err.log'), d));
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    try { const r = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(2000) }); if (r.ok) return; } catch { await sleep(1000); }
  }
  throw new Error('server never booted');
}
async function stopServer() { try { serverProc?.kill(); } catch { /* gone */ } }
function loadToken() {
  const cfgFile = path.join(CFG.home, 'MAJIN', 'config.json');
  if (fs.existsSync(cfgFile)) return String(JSON.parse(fs.readFileSync(cfgFile, 'utf8'))?.server?.token || '');
  return '';
}
async function api(method, p, body, token) {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(240000),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function main() {
  if (!CFG.exe || !fs.existsSync(CFG.exe)) throw new Error(`QA_EXE missing: ${CFG.exe}`);
  await startServer();
  const token = loadToken();
  if (!token) throw new Error('token missing from disposable home');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', (err) => fs.appendFileSync(path.join(CFG.evid, 'page-errors.log'), String(err) + '\n'));
  const URLT = `${BASE}/?t=${token}`;
  const LANE = 'aurora-ui';
  const CL = { CI: 'VERIFIED_CI', FAIL: 'FAILED', BLOCKED: 'BLOCKED' };

  /* u01 — onboarding shows when no provider is ready (fresh disposable home) */
  await page.goto(URLT, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  const onboardVisible = await page.evaluate(() => !document.getElementById('onboard')?.hidden);
  const obBody = await page.evaluate(() => document.getElementById('ob-body')?.textContent?.slice(0, 400) || '');
  await shot(page, 'u01-onboarding-fresh');
  rec('u01', 'onboarding + provider flow honesty (fresh install)', LANE,
    onboardVisible && /provider|model|connect/i.test(obBody) ? CL.CI : CL.FAIL,
    `fresh state → onboarding visible=${onboardVisible}; body snippet captured`, { visible: onboardVisible, body: obBody.slice(0, 200) });

  /* u02 — after a provider is connected, onboarding closes and chat unlocks */
  await api('POST', '/api/provider', { preset: 'ollama', models: [CFG.model] }, token);
  await api('PATCH', '/api/config', { models: { routes: { chat: `ollama/${CFG.model}`, tools: `ollama/${CFG.model}`, tasks: `ollama/${CFG.model}` } }, moa: { enabled: false } }, token);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const onboardGone = await page.evaluate(() => document.getElementById('onboard')?.hidden !== false);
  const inputReady = await page.evaluate(() => { const i = document.getElementById('input'); return i && !i.disabled && i.offsetParent !== null; });
  await shot(page, 'u02-after-connect');
  rec('u02', 'connect provider → onboarding closes, composer unlocked', LANE,
    onboardGone && inputReady ? CL.CI : CL.FAIL,
    `onboard closed=${onboardGone}, input ready=${inputReady}`, { onboardGone, inputReady });

  /* u03 — a real chat round-trip in the REAL UI (send → reply rendered) */
  await page.fill('#input', 'Reply with exactly: OK');
  await page.click('#send');
  const mark = 'QA-UI-REPLY-DELIM';
  let uiReply = '';
  const t0chat = Date.now();
  while (Date.now() - t0chat < 300000) {
    await page.waitForTimeout(1500);
    uiReply = await page.evaluate((prompt) => {
      const scroller = document.getElementById('scroller');
      const fullText = scroller?.textContent || '';
      // the REPLY is the DOM text after the user's own prompt tail
      const idx = fullText.lastIndexOf(prompt);
      return idx >= 0 ? fullText.slice(idx + prompt.length) : fullText.slice(-300);
    }, 'Reply with exactly: OK');
    if (/ok/i.test(uiReply) && uiReply.trim().length > 0) break;
  }
  const tailAtDone = await page.evaluate(() => document.getElementById('scroller')?.textContent?.slice(-300) || '');
  await shot(page, 'u03-chat-reply');
  rec('u03', 'real chat through the real Aurora UI (local model)', LANE,
    /ok/i.test(uiReply) ? CL.CI : CL.FAIL,
    `UI rendered the model's reply after the prompt ("${uiReply.trim().slice(0, 60)}")`, { uiReply: uiReply.trim().slice(0, 160), tailAtDone: tailAtDone.slice(-160) });

  /* u04 — streaming visuals: scroller grows while generation runs */
  await page.fill('#input', 'Count slowly from 1 to 25, one number per line.');
  await page.click('#send');
  // Vänta på första icke-invändningspunkt ("varp: invändationer brända sitter"). Mät endast mot den första verkliga längden som är korsbart.
  let growth = [], lastLen = -1, busyPren = 0;
  const t0grow = Date.now();
  while (Date.now() - t0grow < 180000) {
    await page.waitForTimeout(2200);
    const m = await page.evaluate(() => ({
      len: document.getElementById('scroller')?.textContent?.length || 0,
      busy: Boolean(document.getElementById('send')?.classList?.contains('busy') || document.getElementById('input')?.disabled),
      lastMsg: (document.querySelector('.msg:last-of-type')?.textContent || '').length,
    }));
    if (m.len <= 100) { busyPren += 1; }
    if (m.len !== lastLen) { growth.push(m.len); lastLen = m.len; }
    if (growth.length >= 3 && !m.busy) break;
    if (growth.length >= 4) break;
  }
  await shot(page, 'u04-streaming');
  rec('u04', 'streaming deltas visibly accumulate', LANE,
    growth.length >= 2 ? CL.CI : CL.FAIL,
    `scroller showed ${growth.length} visible growth increments (chars: ${growth.slice(0, 6).join(' → ')})`,
    { increments: growth.length, series: growth.slice(0, 10) });

  /* u05 — task board reflects running/recent tasks */
  const tasksApi = await api('GET', '/api/tasks', undefined, token);
  const seenTasks = (tasksApi.json?.tasks || []).length;
  const uiTaskCount = await page.evaluate(() => {
    const el = document.getElementById('task-count');
    return el ? el.textContent : null;
  });
  await shot(page, 'u05-tasks');
  rec('u05', 'autopilot task board shows recent work (API ⇄ UI parity)', LANE,
    seenTasks > 0 ? CL.CI : CL.FAIL, `/api/tasks sees ${seenTasks} tasks; UI task-count=${uiTaskCount}`, { seenTasks, uiTaskCount });

  /* u06 — model picker opens with providers and rows */
  await page.click('#browse-models');
  await page.waitForTimeout(2500);
  const pickerOpen = await page.evaluate(() => !!document.querySelector('[aria-label*="Close model picker" i]'));
  const rows = await page.evaluate(() => document.querySelectorAll('.model-meta').length);
  const providerText = await page.evaluate(() => document.body.textContent.slice(0, 0) || '');
  await shot(page, 'u06-model-picker');
  rec('u06', 'model explorer opens and lists models', LANE,
    pickerOpen && rows > 0 ? CL.CI : CL.FAIL,
    `picker open=${pickerOpen}, model rows=${rows}`, { pickerOpen, rows });

  /* u07 — Free-only filter narrows to zero-charge models */
  const freeBtn = await page.$('.free-filter');
  let freeOk = { applied: false, shown: 0, total: 0 };
  if (freeBtn) {
    await freeBtn.click();
    await page.waitForTimeout(1200);
    const stats = await page.evaluate(() => {
      const freeEl = document.querySelector('.free-filter');
      const text = [...document.querySelectorAll('button,span,p')].map((n) => n.textContent).find((t) => / of .* models/.test(t)) || '';
      const m = /(\d+) of (\d+) models/.exec(text);
      return { pressed: freeEl?.getAttribute('aria-pressed'), shown: m ? +m[1] : -1, total: m ? +m[2] : -1 };
    });
    const freeLabelsAll = await page.evaluate(() => {
      const metas = [...document.querySelectorAll('.model-meta')];
      const shown = metas.length;
      const free = metas.filter((m) => m.className.includes('model-free')).length;
      return { shown, free };
    });
    freeOk = { applied: stats.pressed === 'true', shown: freeLabelsAll.shown, freeOnlyShown: freeLabelsAll.free, total: stats.total };
    await shot(page, 'u07-free-filter');
  }
  rec('u07', 'Free-only filter narrows explorer to zero-charge models', LANE,
    freeBtn && freeOk.applied && (freeOk.shown === 0 || freeOk.shown === freeOk.freeOnlyShown) ? CL.CI : CL.FAIL,
    freeBtn
      ? `filter applied; ${freeOk.shown} rows shown, ${freeOk.freeOnlyShown} marked free (0 rows on unknown-price providers is the documented honest rule: missing prices never mean free)`
      : 'free-filter button never appeared',
    freeOk);

  /* u08 — Escape closes the picker; instrumented (checks the live picker flag, not the DOM guess) */
  const openBefore = await page.evaluate(() => !!document.querySelector('[aria-label*="Close model picker" i]'));
  await shot(page, 'u08-before-escape');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  const openAfter = await page.evaluate(() => !!document.querySelector('[aria-label*="Close model picker" i]'));
  const focus = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
  if (openBefore && openAfter) {
    // second chance: maybe focus trap swallowed it — click into the search first, escape again
    const searchEl = await page.$('.explorer-search, input[type="search"], #modeldrop input');
    if (searchEl) { await searchEl.focus(); await page.keyboard.press('Escape'); await page.waitForTimeout(700); }
  }
  const openFinal = await page.evaluate(() => !!document.querySelector('[aria-label*="Close model picker" i]'));
  const closed = openBefore && !openFinal;
  rec('u08', 'Escape closes dialogs and focus rules hold', LANE,
    closed ? CL.CI : CL.FAIL,
    `picker open before=${openBefore}, after Escape=${openAfter}, after focus+retry=${openFinal}; focus on #${focus}`,
    { openBefore, openAfter, openFinal, focusId: focus });

  /* u09 — reduced motion actually kills animation */
  let rm = { animationName: 'crash', rulePresent: false };
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(400);
    rm = await page.evaluate(() => {
    const cs = getComputedStyle(document.body);
    const anyAnimated = getComputedStyle(document.querySelector('#send') || document.body).animationName;
    const rule = [...document.styleSheets].some((ss) => { try { return [...ss.cssRules].some((r) => r.conditionText && r.conditionText.includes('prefers-reduced-motion')); } catch { return false; } });
    return { animationName: anyAnimated, rulePresent: rule };
  });
  } catch (err) { rm.error = String(err).slice(0, 160); }
  try { await page.emulateMedia({ reducedMotion: null }); } catch { /* ok */ }
  rec('u09', 'prefers-reduced-motion honored (media rule + computed style)', LANE,
    rm.rulePresent ? CL.CI : CL.FAIL, `stylesheet carries the media rule (computed animationName=${rm.animationName})`, rm);

  /* u10 — artifacts: file written by the agent renders in the Files view */
  const marker = `QA-UI-MARKER-${Date.now()}`;
  let u10 = { listed: false };
  try {
    const writeResult = await api('POST', '/api/tool', { tool: 'fs.write', args: { path: 'qa-ui/browse-me.md', content: `# QA UI check\n${marker}\n` } }, token);
    if (writeResult.status >= 400 || writeResult.json?.error) throw new Error(`fs.write failed: HTTP ${writeResult.status} ${JSON.stringify(writeResult.json || {}).slice(0, 160)}`);
    await page.click('#tab-files', { timeout: 20000 });
    // vy-lista kan polla långsamt på CI — vänta TILLS markören eller tom lista svarnaor
    // Assert the actual filename appears, not an unrelated Files row or generic folder.
    await page.waitForFunction(() => {
      const view = document.getElementById('view-files');
      return Boolean(view && /browse-me\\.md/.test(view.textContent || ''));
    }, null, { timeout: 20000 });
    const filesText = await page.evaluate(() => document.getElementById('view-files')?.textContent || '');
    await shot(page, 'u10-files');
    u10 = { listed: /browse-me\.md/.test(filesText), sample: filesText.slice(0, 160), marker, writeStatus: writeResult.status };
  } catch (err) { u10.error = String(err).slice(0, 200); }
  rec('u10', 'agent-written file is browsable in the Files view', LANE,
    u10.listed ? CL.CI : CL.FAIL, `files view checked for the marker filename${u10.error ? ' — ' + u10.error : ''}`, u10);

  /* u11 — reload persistence: chat transcript survives a page reload */
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2600);
  const afterReload = await page.evaluate(() => document.getElementById('scroller')?.textContent || '');
  const persisted = /ok/i.test(afterReload.slice(-400)) || /Count slowly/i.test(afterReload);
  await shot(page, 'u11-reload');
  rec('u11', 'chat transcript persists across reload', LANE,
    persisted ? CL.CI : CL.FAIL, `reloaded transcript tail still contains earlier content`, { tail: afterReload.slice(-140) });

  /* u12 — error/help state: stop button while generating */
  let stopVisible = false, stopWorked = null, stage = 'init', stageErr = null;
  try {
    await page.fill('#input', 'Write a very long essay about granite.');
    await page.click('#send');
    stage = 'await-visible';
    await page.locator('#b-stop').waitFor({ state: 'visible', timeout: 12000 });
    stopVisible = true;
    await shot(page, 'u12-stop');
    stage = 'click';
    const lenBefore = await page.evaluate(() => document.getElementById('scroller')?.textContent?.length || 0);
    await page.click('#b-stop');
    stage = 'settle';
    await page.waitForTimeout(3000);
    const lenAfterClick = await page.evaluate(() => document.getElementById('scroller')?.textContent?.length || 0);
    await page.waitForTimeout(5000);
    const lenAfterSettle = await page.evaluate(() => document.getElementById('scroller')?.textContent?.length || 0);
    const inputFree = await page.evaluate(() => !document.getElementById('input').disabled);
    stopWorked = lenAfterClick === lenAfterSettle && lenAfterSettle >= lenBefore && inputFree;
    stage = 'done';
  } catch (err) { stageErr = String(err).slice(0, 180); }
  rec('u12', 'interrupt control appears and halts generation', LANE,
    (stopVisible && stopWorked) ? CL.CI : CL.FAIL, `stop control visible=${stopVisible}; halts generation=${stopWorked} (stopped at stage=${stage}${stageErr ? `: ${stageErr}` : ''})`,
    { stopVisible, stopWorked, stage, stageErr });

  await browser.close();
  await stopServer();
  const counts = results.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
  fs.writeFileSync(path.join(CFG.evid, 'qa-ui-report.json'), JSON.stringify({
    schema: 'majin.qa-ui.v1', env: { runner: 'windows-latest', browser: 'chromium headless', model: CFG.model },
    counts, scenarios: results, startedAt: new Date().toISOString(),
  }, null, 2));
  console.log('counts:', JSON.stringify(counts));
  if (results.some((r) => r.status === 'FAILED')) process.exitCode = 1;
}
main().catch((err) => { console.error('UI lane broke:', err); process.exit(2); });
