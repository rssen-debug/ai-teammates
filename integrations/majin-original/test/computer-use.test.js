import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { computerUse, normalizeAction, sessionId, evidenceDir, VERSION } from '../src/core/computer-use.js';
import { isWindowsDesktop, NOT_WINDOWS, ensureOverlayFiles, cursor } from '../src/core/pink-cursor.js';

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cu-ws-'));

/* A fake desktop where control.* tools really mutate state (like the real lane's
   SendMessage round-trips do), so the loop's VERIFY phase has something honest
   to measure against. */
function fakeDesktop(initial = []) {
  const state = { windows: [...initial], reads: new Map() };
  const exec = async (name, args) => {
    if (name === 'control.list_windows') return { ok: true, result: state.windows };
    if (name === 'screen.capture') return { ok: true, meta: { path: '/tmp/fake.png', bytes: 100 } };
    if (name === 'control.type') { state.reads.set(args.window, (state.reads.get(args.window) || '') + args.text); return { ok: true }; }
    if (name === 'control.read') return { ok: true, result: state.reads.get(args.window) || '' };
    if (name === 'control.click_button') { state.windows.push({ title: 'OK dialog closed', class: 'Button' }); return { ok: true }; }
    return { ok: false, error: { code: 'unknown_tool', message: name } };
  };
  return { state, registry: { exec } };
}

test('CU: OBSERVE→PLAN→ACT→VERIFY loop reaches VERIFIED completion (never click-ok)', async () => {
  const dir = ws();
  const desk = fakeDesktop([{ title: 'Untitled - Notepad', class: 'Notepad' }]);
  const plans = [
    { action: 'type', window: 'Untitled - Notepad', text: 'hello world', verify: { type: 'read_contains', window: 'Untitled - Notepad', text: 'hello world' } },
    { action: 'done', verify: { type: 'read_contains', window: 'Untitled - Notepad', text: 'hello world' } },
  ];
  let n = 0;
  const r = await computerUse('write hello world in notepad', {
    workspaceDir: dir, registry: desk.registry,
    modelCall: async () => plans[n++],
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'complete');
  assert.match(r.verify, /matched/);
  const trace = fs.readFileSync(path.join(r.dir, 'steps.jsonl'), 'utf8');
  assert.ok(trace.includes('"phase":"observe"') && trace.includes('"phase":"verify"'), 'evidence records prove the phases, not just claims');
});

test('CU: a "done" claim without proof is REFUSED (model must try again)', async () => {
  const dir = ws();
  const desk = fakeDesktop([{ title: 'Notepad', class: 'Notepad' }]);
  const plans = [
    { action: 'done', verify: { type: 'read_contains', window: 'Notepad', text: 'SECRET' } },  /* nothing written — unprovable */
    { action: 'type', window: 'Notepad', text: 'SECRET', verify: { type: 'read_contains', window: 'Notepad', text: 'SECRET' } },
    { action: 'done', verify: { type: 'read_contains', window: 'Notepad', text: 'SECRET' } },
  ];
  let n = 0;
  const r = await computerUse('sneaky false claim', { workspaceDir: dir, registry: desk.registry, modelCall: async () => plans[n++], maxSteps: 6 });
  assert.equal(r.ok, true);
  const trace = fs.readFileSync(path.join(r.dir, 'steps.jsonl'), 'utf8');
  assert.ok(trace.includes('unverified_done_claim'), 'the false done-claim is logged as such');
});

test('CU: repeat wall — identical action twice forces strategy change, never a blind re-click', async () => {
  const dir = ws();
  const desk = fakeDesktop();
  const plans = [
    { action: 'click_button', window: 'X', caption: 'OK' },
    { action: 'click_button', window: 'X', caption: 'OK' },
    { action: 'blocked', reason: 'button never responds — strategy exhausted', category: 'stuck' },
  ];
  let n = 0;
  const events = [];
  const r = await computerUse('click OK', { workspaceDir: dir, registry: desk.registry, modelCall: async () => plans[n++], emit: (e) => events.push(e) });
  assert.equal(r.status, 'blocked');
  assert.ok(events.some((e) => e.type === 'cu_repeat_wall'), 'the repeat wall event is visible — no silent re-click');
});

test('CU: maxSteps bound ends in an explicit blocked-state with error category', async () => {
  const dir = ws();
  const desk = fakeDesktop();
  const r = await computerUse('impossible', { workspaceDir: dir, registry: desk.registry, modelCall: async () => ({ action: 'list_windows' }), maxSteps: 3 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'blocked');
  assert.equal(r.errorCategory, 'budget');
});

test('CU: disallowed model actions are refused by the allowlist (never executed)', () => {
  assert.equal(normalizeAction({ action: 'format_c:' }).kind, 'invalid');
  assert.equal(normalizeAction({ action: 'type', window: 'X' }).kind, 'invalid');
  assert.equal(normalizeAction({ action: 'read', window: 'X' }).kind, 'read');
});

test('CU overlay: non-Windows honesty — FORBIDDEN, never a fake cursor', async () => {
  if (process.platform === 'win32') return; /* interactive lane, checked by the win runner */
  assert.equal(isWindowsDesktop(), false);
  const r = await cursor(ws(), { op: 'move', x: 1, y: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'FORBIDDEN');
});

test('CU overlay: overlay PS1 materializes under workspace/cursor (script is real, versioned)', () => {
  const dir = ws();
  const p = ensureOverlayFiles(dir);
  const src = fs.readFileSync(p.ps1, 'utf8');
  assert.ok(src.includes('System.Windows.Forms'), 'the overlay is a real layered WinForms script');
  assert.ok(src.includes('Add_Paint'), 'real WinForms pink pointer is drawn using the registered Paint event');
  assert.ok(src.includes('Opacity'), 'real interactive desktop renders the dark cursor backing instead of hiding the whole form');
  assert.equal(sessionId('a'), sessionId('a'), 'session id stable');
  assert.ok(VERSION.startsWith('majin-computer-use/'));
});
