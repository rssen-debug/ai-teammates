/* V1 regression gate: critical controls must keep their DOM targets and handlers.
 * Inspired by verification-first agent workflows; no runtime/UI modifications.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (relative) => fs.readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
const html = read('src/ui/index.html');
const app = read('src/ui/app.js');

test('V1 essential controls retain their accessible DOM wiring', () => {
  const critical = ['b-stop', 'b-mode', 'b-expert', 'b-voice', 'mic', 'send', 'b-quit'];
  for (const id of critical) {
    const matches = [...html.matchAll(new RegExp('\\bid="' + id + '"', 'g'))];
    assert.equal(matches.length, 1, id + ' must exist exactly once');
    assert.ok(app.includes("$('" + id + "')"), id + ' must be used by the UI controller');
  }
});

test('V1 chat composer retains keyboard send and stop actions', () => {
  assert.match(html, /id="input"/);
  assert.match(app, /e\.key === 'Enter' && !e\.shiftKey/);
  assert.match(app, /if \(e\.key === 'Escape'\) stop\(\)/);
  assert.match(app, /\$\('send'\)\.onclick = \(\) => \(S\.busy \? stop\(\) : send\(/);
});
