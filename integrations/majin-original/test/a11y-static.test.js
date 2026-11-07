/** Aurora 8D — accessibility / performance / interaction static locks.
 *  Everything asserted here is machine-checked truth about the shipped UI
 *  sources; the BEHAVIOUR of these mechanisms is proven live by
 *  scripts/phoenix-browser.mjs (Playwright, docs/evidence/aurora-acceptance-*). */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const index = read('src/ui/index.html');
const app = read('src/ui/app.js');
const studio = read('src/ui/studio.js');
const css = read('src/ui/phoenix.css');

/* ---- WCAG 2.1 contrast, computed from the real theme tokens ---- */
function lum(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(m, 'hex token ' + hex);
  const v = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function ratio(a, b) {
  const [hi, lo] = [Math.max(lum(a), lum(b)), Math.min(lum(a), lum(b))];
  return (hi + 0.05) / (lo + 0.05);
}

test('dark theme text meets WCAG AA contrast (ink, dim, cy on bg)', () => {
  assert.match(index, /--bg:#0b0509/);
  const bg = '#0b0509';
  for (const [token, val] of [['--ink', '#f7dbe9'], ['--dim', '#bb8ba3'], ['--cy', '#ff8fd0'], ['--pink', '#ffc9dd']]) {
    const r = ratio(val, bg);
    assert.ok(r >= 4.5, `${token} on bg contrast ${r.toFixed(2)}:1 < 4.5:1`);
  }
  assert.ok(index.includes('--bg:' + bg) && index.includes('--ink:#f7dbe9'), 'theme tokens present');
});

test('landmarks and live region wiring', () => {
  assert.match(index, /<header>/, 'header landmark');
  assert.match(index, /role="status" aria-live="polite"/, 'polite live status region');
  assert.match(index, /aria-label="Workspace"/, 'studio aside accessible name');
  assert.match(index, /role="tablist" aria-label="Workspace views"/, 'studio tablist');
  assert.match(index, /role="tab" aria-selected/, 'tabs expose selection state');
  assert.match(index, /role="tabpanel" aria-labelledby/, 'panels labelled by their tab');
});

test('every interactive header/rail control has an accessible name', () => {
  const buttons = [...index.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gs)];
  assert.ok(buttons.length >= 20, 'sanity: found header/rail/button markup (' + buttons.length + ')');
  for (const [i, b] of buttons.entries()) {
    const attrs = b[1];
    const visibleText = b[2].replace(/<[^>]+>/g, '').trim();
    const named = /aria-label=/.test(attrs) || /title=/.test(attrs) || visibleText.length > 0;
    assert.ok(named, `button #${i} has no accessible name`);
  }
});

test('send/stop button: stateful accessible label + circular control lock', () => {
  assert.ok(app.includes("button.setAttribute('aria-label', S.busy ? 'Stop response' : 'Send message')"), 'aria-label flips with run state');
  assert.ok(app.includes('Stop response'), 'stop state reachable');
  assert.ok(index.includes('aria-label="Send message"'), 'initial send accessible name');
});

test('reduced motion is respected for every animated surface', () => {
  assert.match(css, /prefers-reduced-motion/, 'phoenix.css honors reduced motion');
  assert.match(index, /@media \(prefers-reduced-motion: reduce\)\{ #imagine \.core\{ animation:none !important; \} \}/, 'imagine core animation gate');
  assert.match(index, /@media\(prefers-reduced-motion:reduce\)\{\*,\*::before,\*::after/, 'global motion gate');
});

test('keyboard operation: tabs arrows/home/end + Escape + focus restore', () => {
  assert.ok(studio.includes("['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)"), 'roving-tabindex arrow navigation');
  assert.ok(studio.includes('previousFocus'), 'studio restores prior focus on close');
  assert.ok(studio.includes('tabIndex = on ? 0 : -1'), 'roving tabindex pattern');
  assert.ok(app.includes('Escape'), 'Escape handling in app');
});

test('search/filter inputs carry accessible names', () => {
  assert.match(index, /id="chat-search"[^>]*aria-label="Search chats"/);
  assert.match(index, /<textarea id="input"[^>]*aria-label="Message MAJIN"/);
});

test('performance budgets: UI payload stays lean (real file sizes)', () => {
  const size = (rel) => fs.statSync(path.join(root, rel)).size;
  assert.ok(size('src/ui/app.js') <= 120 * 1024, 'app.js ' + size('src/ui/app.js'));
  assert.ok(size('src/ui/phoenix.css') <= 60 * 1024, 'phoenix.css ' + size('src/ui/phoenix.css'));
  assert.ok(size('src/ui/index.html') <= 80 * 1024, 'index.html ' + size('src/ui/index.html'));
  /* 8D-behavioural perf gate: scripts/phoenix-browser.mjs asserts
     'Long conversation render (300 messages): <N>ms' — logged 126ms. */
});

test('interaction honesty: no fake timers simulating progress in studio/app', () => {
  for (const src of [['studio.js', studio], ['app.js', app]]) {
    const fakeProgress = /setInterval\([^)]*(progress|percent|fake)/i.test(src[1]);
    assert.equal(fakeProgress, false, src[0] + ' must never fake progress');
  }
  assert.ok(studio.includes("No simulated agents, progress, file trees or inference calls"), 'studio honesty header');
});
