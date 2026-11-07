/**
 * Studio page script-syntax guard — born of a REAL bug class the HTTP-only
 * tests never saw: strings with `\n` inside the page's inline <script> made
 * the ENTIRE browser script a SyntaxError (panels API-green, clicks dead).
 * Regression rule, enforced here: the rendered inline script must parse for
 * every gate combination the server can emit. (Behavioral proof lives in the
 * GUI-QA lane on the operator runner; syntax sanity belongs in CI.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderStudioPage } from '../src/v2/studio/page.js';

const COMBOS = [
  {},
  { enableWrites: true },
  { enableGoals: true },
  { enableVoice: true },
  { enableBundle: true },
  { enableDoctor: true },
  { enableWrites: true, enableGoals: true, enableVoice: true, enableBundle: true, enableDoctor: true },
];

test('rendered inline <script> parses for every gate combination (the whole page depends on it)', () => {
  for (const combo of COMBOS) {
    const html = renderStudioPage(combo);
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, `no inline script at all for combo ${JSON.stringify(combo)}`);
    assert.doesNotThrow(() => new Function(m[1]), `script must PARSE for combo ${JSON.stringify(combo)} — an unescaped newline here dead the entire page`);
  }
});

test('template discipline marker: script contains handlers for every enabled surface id in DOM', () => {
  const html = renderStudioPage({ enableWrites: true, enableGoals: true, enableVoice: true, enableBundle: true, enableDoctor: true });
  for (const id of ['c-grant', 'g-run', 'v-speak', 'b-export', 'd-run']) {
    assert.ok(html.includes(`id="${id}"`), `${id} in DOM`);
    assert.ok(html.includes(`getElementById('${id}')`), `${id} wired in script`);
  }
});
