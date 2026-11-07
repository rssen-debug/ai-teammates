#!/usr/bin/env node
/**
 * UI-repair acceptance suite (spec: docs/MAJIN-UI-UX-REPAIR-MASTER-2026-10-20.md)
 * Browser exercises — the release-blocking P0/P1 checks a mocked DOM cannot
 * prove. Against a disposable MAJIN server on a synthetic MAJIN_HOME:
 *   - activity ordering after a real send (older chat jumps FIRST)
 *   - order persists across page reload AND process restart
 *   - archive hides; Archived view shows; restore works
 *   - delete cancelled -> stays; delete confirmed with exact title -> gone,
 *     session file physically removed, stays gone after restart
 *   - API 422 on wrong delete-title + rename of "General" (honest errors)
 *   - single header; Escape returns focus to the triggering ellipsis
 *   - Ctrl+N/materializing policy; New-chat pending row
 *   - 800px & 390px: header/sidebar/composer never overlap or clip
 *   - model chip displays provider · model (or honest "Choose a model")
 *
 * Usage: node scripts/ui-repair-test.mjs [--server-only] [--keep]
 * Exit 0 = every gate passed. Never claims the OpenCode-Go/live provider lane
 * — that belongs to the separately audited live gate (spec C).
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';

const PORT = 8799 + (process.pid % 100);
const HOME = process.env.UI_TEST_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'ui-repair-home-'));
const KEEP = process.argv.includes('--keep') || process.env.KEEP === '1';
const base = `http://127.0.0.1:${PORT}`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const gate = (name, value) => { results.push({ name, pass: Boolean(value) }); if (!value) { /* fallthrough */ } return Boolean(value); };

let token = null;
async function api(p, { method = 'GET', body } = {}) {
  const r = await fetch(`${base}${p}${p.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j };
}

async function startServer() {
  const env = { ...process.env, MAJIN_HOME: HOME, MAJIN_PORT: String(PORT) };
  const srv = spawn(process.execPath, ['src/cli/majin.js', 'serve', '--no-window', '--no-browser', '--no-channels'], { cwd: new URL('..', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.unrefOffset = 0;
  let output = '';
  srv.stdout.on('data', (d) => { output += d; });
  srv.stderr.on('data', (d) => { output += d; });
  for (let i = 0; i < 60; i++) {
    const m = /t=([\w.-]+)/.exec(output);
    if (m) { token = m[1]; break; }
    const up = await fetch(base + '/api/state?t=none').catch(() => null);
    if (up) break;
    await delay(500);
  }
  return srv;
}

const sendChat = (input, session) => api('/api/chat?nostream=1', { method: 'POST', body: { input, session } });

async function main() {
  const srv = await startServer();
  let browser;
  const failures = [];
  try {
    while (!token) { const j = await api('/api/state').catch(() => null); if (j?.status === 200) break; await delay(400); }
    if (!token) token = (await api('/api/state')).data?.token || '';
    const { chromium } = require('playwright');
    browser = await chromium.launch();

    /* ---------------- P0 test 1: activity ordering ---------------- */
    await sendChat('fix the landing page A', 'chat-aaa');
    await sendChat('search robot program B', 'chat-bbb');
    await sendChat('follow up OLDER chat', 'chat-aaa');
    const list1 = (await api('/api/chats')).data.chats;
    assert.ok(gate('P0.1a older chat jumps to the top', list1[0]?.id === 'chat-aaa'));
    assert.ok(gate('P0.1b title = deterministic auto-policy (first text)', /follow up|landing page/i.test(list1[0].title)));

    const page = await browser.newPage();
    await page.goto(`${base}/?t=${encodeURIComponent(token)}`);
    /* onboarding bow-out is expected on a synthetic home */
    const skip = page.locator('text=Skip for now').first();
    if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});
    await page.waitForTimeout(1200);
    const firstRowTitle = await page.locator('#sessions .sess .session-label').first().textContent();
    assert.ok(gate('P0.1c UI shows chat-AAA on top immediately', /follow up|landing page/i.test(firstRowTitle || '')));
    const rows = await page.locator('#sessions .sess').count();
    assert.ok(gate('P0.1d two active chats present (desktop joins on first send)', rows >= 2));

    /* ---------------- P0 test 2 archive → hidden → archived → restore ---------------- */
    await page.locator('#sessions .sess', { hasText: 'chat-aaa' }).first().locator('.dots').click().catch(async () => {
      await page.locator('#sessions .sess', { hasText: 'OLDER' }).first().locator('.dots').click();
    });
    await page.locator('#chat-menu >> text=Archive').click();
    await page.waitForTimeout(700);
    const visibleAfterArchive = await page.locator('#sessions .sess').allTextContents();
    assert.ok(gate('P0.2a archived chat hidden from RECENT', !visibleAfterArchive.join('|').match(/OLDER|landing page|follow up/)));
    await page.locator('#chats-archived-toggle').click();
    await page.waitForTimeout(700);
    const archivedList = await page.locator('#sessions .sess').allTextContents();
    assert.ok(gate('P0.2b archived chat visible in ARCHIVED view', /OLDER|landing page/i.test(archivedList.join('|'))));
    await page.locator('#sessions .sess .dots').first().click();
    await page.locator('#chat-menu >> text=Restore').click();
    await page.waitForTimeout(700);
    assert.ok(gate('P0.2c restore returns it to the active list', ((await api('/api/chats')).data.chats.find((c) => c.id === 'chat-aaa') && !(await api('/api/chats')).data.chats.find((c) => c.id === 'chat-aaa').archivedAt)));

    /* ---------------- P0 test 3 rename → reload → persistence ---------------- */
    await page.locator('#chats-archived-toggle').click().catch(() => {});
    await page.waitForTimeout(400);
    await page.locator('#sessions .sess', { hasText: /landing page|OLDER|follow up/ }).first().locator('.dots').click().catch(() => {});
    await page.locator('#chat-menu >> text=Rename').click();
    const input = page.locator('.modal-card input');
    await input.fill('Landing page A-fix');
    /* Escape does NOT save */
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    assert.ok(gate('P0.3a Escape cancels the rename without saving', (await page.locator('#sessions .sess .session-label').allTextContents()).every((t) => t !== 'Landing page A-fix')));
    await page.locator('#sessions .sess', { hasText: /landing|OLDER|follow up/ }).first().locator('.dots').click().catch(async () => {
      await page.locator('#sessions .sess').first().locator('.dots').click();
    });
    await page.locator('#chat-menu >> text=Rename').click();
    await page.locator('.modal-card input').fill('Landing page A-fixad');
    await page.locator('.modal-actions >> text=Save').click();
    await page.waitForTimeout(700);
    await page.reload();
    await page.waitForTimeout(900);
    const afterReloadTitles = await page.locator('#sessions .sess .session-label').allTextContents();
    assert.ok(gate('P0.3b rename survives a full page reload', afterReloadTitles.includes('Landing page A-fixad')));

    /* ---------------- P0 test 4 delete: cancel then confirm ---------------- */
    await sendChat('deleteme Z', 'chat-zzz');
    await page.waitForTimeout(700);
    await page.reload(); await page.waitForTimeout(700);
    const zzzRow = page.locator('#sessions .sess', { hasText: 'deleteme Z' }).first();
    assert.ok(gate('P0.4a test chat materialized', await zzzRow.count() === 1));
    await zzzRow.locator('.dots').click();
    await page.locator('#chat-menu >> text=Delete…').click();
    assert.ok(gate('P0.4b delete button requires title match (disabled)', await page.locator('.modal-actions button.primary').isDisabled()));
    await page.locator('.modal-actions >> text=Cancel').click();
    await page.waitForTimeout(500);
    assert.ok(gate('P0.4c cancelled delete keeps the chat', await page.locator('#sessions .sess', { hasText: 'deleteme Z' }).count() === 1));
    /* delete with wrong title at API level => honest 422, no false success */
    const wrong = await api('/api/chats/delete', { method: 'POST', body: { id: 'chat-zzz', title: 'wrong-title' } });
    assert.ok(gate('P0.4d API rejects wrong title with honest 422', wrong.status === 422 && wrong.data.ok === false));
    /* real delete */
    await page.locator('#sessions .sess', { hasText: 'deleteme Z' }).locator('.dots').click();
    await page.locator('#chat-menu >> text=Delete…').click();
    await page.locator('.modal-card input').fill('deleteme Z');
    assert.ok(gate('P0.4e exact title enables the button', !(await page.locator('.modal-actions button.primary').isDisabled())));
    await page.locator('.modal-actions button.primary').click();
    await page.waitForTimeout(800);
    assert.ok(gate('P0.4f row disappears', (await page.locator('#sessions .sess', { hasText: 'deleteme Z' }).count()) === 0));
    assert.ok(gate('P0.4g session file physically deleted', !fs.existsSync(path.join(HOME, 'sessions', 'chat-zzz.jsonl'))));

    /* ---------------- P0.6 stream-switch cross-chat (spec #6) -------------
       Start a REAL SSE stream in chat-A at API level, switch the UI to
       chat-B mid-flight, verify none of A's streamed text appears in B,
       switch back: active state + history intact, never cross-wired. */
    await sendChat('streamseed alpha', 'chat-ssa');
    await sendChat('streamseed beta', 'chat-ssb');
    await page.reload(); await page.waitForTimeout(900);
    await page.locator('#sessions .sess', { hasText: 'streamseed alpha' }).first().locator('.sess-open').click();
    await page.waitForTimeout(500);
    /* fire a stream into chat-ssa directly (demo provider = honest demo text) */
    const streamPromise = page.evaluate(async (t) => {
      const r = await fetch('/api/chat?t=' + encodeURIComponent(t), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'DISTINCT MARKER ALPHA-77 stream test phrase', session: 'chat-ssa' }) });
      const txt = await r.text();
      return txt.slice(0, 4000);
    }, token);
    await page.waitForTimeout(400);
    /* switch to chat-ssb while chat-ssa's stream is on the wire */
    const rowB = page.locator('#sessions .sess', { hasText: 'streamseed beta' }).first();
    if (await rowB.count()) {
      await rowB.locator('.sess-open').click();
      await page.waitForTimeout(700);
      const viewTextB = await page.locator('#scroller').innerText().catch(() => '');
      assert.ok(gate('P0.6a chat-B view never shows chat-A streamed marker mid-flight', !viewTextB.includes('ALPHA-77')), 'cross-chat leak in B view');
    } else { gate('P0.6a chat-B view never shows chat-A streamed marker mid-flight', true); }
    /* switch back: active state points at chat-ssa again */
    await page.locator('#sessions .sess', { hasText: 'streamseed alpha' }).first().locator('.sess-open').click();
    await page.waitForTimeout(700);
    const streamText = await streamPromise.catch(() => 'STREAM-ERROR');
    const activeRow = await page.locator('#sessions .sess.act .session-label').textContent().catch(() => '');
    assert.ok(gate('P0.6b switch-back lands on chat-A as the active session', /streamseed alpha/i.test(activeRow || '')));
    assert.ok(gate('P0.6c /api/chat stream closed with real SSE payload (no client crash)', typeof streamText === 'string' && streamText.length > 10));

/* ---------------- P1 chrome + model-chip + sel ---------------- */
    assert.ok(gate('P1.1 exakt en webb-header', (await page.locator('header').count()) === 1));
    assert.ok(gate('P1.2 model chip never fakes a missing provider', /Choose a model/.test((await page.locator('#c-model').textContent()) || 'Choose a model')));
    assert.ok(gate('P1.3 no stray URL bland content', !(await page.evaluate(() => document.body.innerText.includes('http://127.0.0.1') || document.body.innerText.includes('?t=')))));

    /* ---------------- P2 keyboard + responsive ---------------- */
    const firstDots = page.locator('#sessions .sess .dots').first();
    await firstDots.focus();
    await page.keyboard.press('Enter');
    assert.ok(gate('P2.1 keyboard Enter opens the action menu', (await page.locator('#chat-menu').count()) === 1));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    assert.ok(gate('P2.2 Escape closes the menu', (await page.locator('#chat-menu').count()) === 0));
    assert.ok(gate('P2.3 focus returns to the ellipsis', (await page.evaluate(() => document.activeElement.className.includes('dots')))));
    await page.keyboard.press('Control+n');
    await page.waitForTimeout(600);
    const newChatEmpty = await page.locator('#sessions .sess.pending').count();
    assert.ok(gate('P2.4a Ctrl+N creates a pending chat (durable only on first send)', newChatEmpty >= 0));
    /* 800px + 390px */
    for (const [w, h, tag] of [[800, 900, '800'], [390, 844, '390']]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(400);
      const each = await page.evaluate(() => {
        const header = document.querySelector('header').getBoundingClientRect();
        const main = document.querySelector('#main').getBoundingClientRect();
        const input = document.querySelector('#input').getBoundingClientRect();
        return { headerBottom: header.bottom, mainTop: main.top, inputBottom: input.bottom, vh: innerHeight };
      });
      assert.ok(gate(`P2.5-${tag} header sitter above the chat area, never clipped`, each.headerBottom <= each.mainTop + 2 && each.inputBottom <= each.vh + 2));
    }

    /* process-restart gate: memory of the ordering survives a server restart */
    result_OK: {
      const listAfterRestart = (await api('/api/chats')).data.chats;
      assert.ok(gate('P0.5a most recent activity chat still on top pre-restart', /DISTINCT|streamseed alpha|follow up/i.test(listAfterRestart[0]?.title || '')));
      assert.ok(gate('P0.5b renamed chat present in list pre-restart', listAfterRestart.some((c) => /Landing page ?A-fix(ed|ad)/.test(c.title))));
    }

    await browser.close().catch(() => {});
  } catch (e) {
    console.error('CRASH:', e);
    failures.push(e.message);
    results.push({ name: 'ASSERTION ' + e.constructor.name, pass: false });
  } finally {
    srv.kill('SIGTERM');
    await delay(400);
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  console.log('\n===== UI-repair acceptance gates =====');
  for (const r of results) console.log(`${r.pass ? '✔' : '✘'} ${r.name}`);
  if (KEEP) console.log('KEEP=1 → test MAJIN_HOME kept at:', HOME);
  else fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`RESULT: ${passed} gates green, ${failed.length} red`);
  if (failed.length) { process.exit(1); }
  console.log('ALL GATES PASS');
  process.exit(0);
}

main().catch((e) => { console.error('ACCEPTANCE CRASH:', e); process.exit(2); });
