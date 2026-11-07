import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/ui/phoenix.css', import.meta.url), 'utf8');
const studio = readFileSync(new URL('../src/ui/studio.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');

test('simple mode hides only the redundant activity shortcut', () => {
  assert.match(css, /body\.simple\s+#run-state\s+#run-details\s*\{\s*display\s*:\s*none\s*;/);
  assert.match(html, /id="run-state"[^>]*>[\s\S]*?id="run-details"/);
  assert.match(html, /id="b-studio"/);
});

test('Workspace still opens Activity and expert shortcut remains wired', () => {
  assert.match(studio, /function open\(tab = 'activity'\)/);
  assert.match(studio, /\$\('b-studio'\)\.onclick\s*=\s*\(\)\s*=>/);
  assert.match(studio, /\$\('run-details'\)\.onclick\s*=\s*\(\)\s*=>\s*open\('activity'\)/);
  assert.doesNotMatch(css, /(?:^|\n)\s*#run-details\s*\{\s*display\s*:\s*none/);
});
