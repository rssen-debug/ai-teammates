import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_TOOLS } from '../src/core/tools/index.js';
import { encodeControlRequest } from '../src/core/tools/wincontrol.js';

/** Control-lane contract (Fas 1, user directive 2026-10-20):
 *  — kontrollverktygen EXISTERAR i produktbältet (inte bara som PoC i scripts/)
 *  — de är exec-gated (BM_CLICK / WM_SETTEXT driver andra fönster)
 *  — på fel plattform nekar de ÄRLIGT, de låtsas aldrig
 *  — scheman är deterministiska (R1-låset: declaration-only)
 */
test('wincontrol: control lane is a shipped product surface', () => {
  const names = ALL_TOOLS.filter((t) => t.group === 'control').map((t) => t.name).sort();
  assert.deepEqual(names, ['control.click_button', 'control.focus', 'control.inspect', 'control.list_windows', 'control.read', 'control.type', 'mouse.move']);
  for (const t of ALL_TOOLS.filter((t) => t.group === 'control')) {
    assert.ok(['read', 'exec'].includes(t.risk), `${t.name} risk must be declared`);
    if (/type|click/.test(t.name)) assert.equal(t.risk, 'exec', `${t.name} drives other windows — must be exec-gated`);
  }
});

const IS_WIN = process.platform === 'win32';

test('wincontrol: wrong platform refuses honestly (never a pretend click)', { skip: IS_WIN && 'windows: real behavior covered by c03 CI scenario' }, async () => {
  const t = ALL_TOOLS.find((t) => t.name === 'control.type');
  const r = await t.run({ window: 'Notepad', text: 'prove-me-not' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'unsupported_platform');
  assert.match(r.error.message, /Windows-only|honest/i);
});

test('wincontrol: schemas deterministic and required sets honest', () => {
  const by = Object.fromEntries(ALL_TOOLS.filter((t) => t.group === 'control').map((t) => [t.name, t.parameters.required || []]));
  assert.deepEqual(by['control.type'], ['window']); // text has '' default = clear the field
  assert.deepEqual(by['control.read'], ['window']);
  assert.deepEqual(by['control.list_windows'], []);
  assert.deepEqual(by['control.click_button'], ['window', 'caption']);
  assert.deepEqual(by['mouse.move'], ['x','y']);
});

test('wincontrol: untrusted window strings are payload, never executable PowerShell syntax', () => {
  const hostile = `Hello ' "& whoami | \$(Start-Process calc) ; <>&\r\nÅÄÖ 🔒`;
  const a = encodeControlRequest('type', { window: hostile, text: hostile, caption: hostile });
  const b = encodeControlRequest('type', { window: 'Notepad', text: 'safe' });
  assert.equal(a.command, b.command, 'command syntax must not depend on user-controlled text');
  assert.doesNotMatch(a.command, /whoami|calc|Notepad|Hello/);
  assert.match(a.command, /^powershell .* -EncodedCommand [A-Za-z0-9+/=]+$/);
  assert.deepEqual(JSON.parse(Buffer.from(a.payload, 'base64').toString('utf8')),
    { action: 'type', window: hostile, text: hostile, caption: hostile });
  assert.throws(() => encodeControlRequest('type', { text: 'x'.repeat(20000) }), RangeError);
});

test('wincontrol: Windows executes the actual PowerShell bridge without an interactive desktop', {
  skip: !IS_WIN && 'requires Windows PowerShell',
  // Covers the bridge cold-start budget (90s first call) plus one warmed
  // read-only retry; the assertion still requires real bridge output.
  timeout: 150000,
}, async () => {
  const list = ALL_TOOLS.find((t) => t.name === 'control.list_windows');
  const result = await list.run({});
  assert.equal(result.ok, true, JSON.stringify(result.error || result).slice(0, 500));
  assert.match(result.result, /top-level window/);
});
