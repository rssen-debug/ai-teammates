import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('Live Agent Vision is mounted in the window and served from the real UI dir', () => {
  const html = read('src/ui/index.html');
  assert.match(html, /id="imagine" hidden/, 'the canvas mount point exists, hidden until a real run');
  assert.ok(html.indexOf('/imagine.js') > 0 && html.indexOf('/imagine.js') < html.indexOf('/app.js'), 'imagine.js loads before app.js so early events are never lost');
  assert.ok(fs.existsSync(path.join(ROOT, 'src/ui/imagine.js')), 'the module ships in the UI bundle');
});

test('every status row begins life as a real event — no fabricated activity', () => {
  const src = read('src/ui/imagine.js');
  // the module only ever paints inside onEvent(ev): no timers, no fakes
  assert.doesNotMatch(src, /setInterval|setTimeout|requestAnimationFrame/, 'no self-driving animation: an idle agent shows an idle core');
  const events = src.slice(src.indexOf('function onEvent('), src.indexOf('function reset('));
  assert.doesNotMatch(events, /fetch\(|XMLHttpRequest|EventSource/, 'event rendering is network-free; a user may explicitly fetch a local preview');
  assert.match(src, /case 'tool'/, 'tool starts are shown');
  assert.match(src, /case 'tool_result'/, 'tool outcomes are shown');
  assert.match(src, /case 'approval:request'/, 'waiting-for-you is a real state');
  assert.match(src, /case 'answer'/, 'done is marked by the actual answer event');
  assert.match(src, /new Date\(\)\.toLocaleTimeString/, 'each row carries its real arrival time');
});

test('model text can never become HTML in the canvas', () => {
  const src = read('src/ui/imagine.js');
  assert.doesNotMatch(src, /\.innerHTML\s*=/, "textContent only — a model's words stay inert");
  assert.match(src, /n\.textContent = text/, 'the one element helper writes textContent');
});

test('the Living Core respects reduced motion and the old UI still works without it', () => {
  const html = read('src/ui/index.html');
  assert.match(html, /prefers-reduced-motion: reduce/, 'reduced-motion users get a calm core');
  const app = read('src/ui/app.js');
  assert.match(app, /window\.MAJIN_IMAGINE\) window\.MAJIN_IMAGINE\.onEvent/, 'run events feed the canvas');
  assert.match(app, /window\.MAJIN_IMAGINE\) window\.MAJIN_IMAGINE\.reset/, 'a new run gets a fresh canvas');
  assert.match(app, /type: name, \.\.\.ev/, 'global events (approvals, schedules) reach the canvas too');
  // deleting the module must break nothing: every MAJIN_IMAGINE touch is guarded
  const touches = app.split('\n').filter((l) => l.includes('MAJIN_IMAGINE.') && !l.trim().startsWith('*'));
  assert.ok(touches.length >= 3 && touches.every((l) => l.includes('window.MAJIN_IMAGINE) window')), 'unguarded use would throw if imagine.js were missing: ' + touches.join(' | '));
});
