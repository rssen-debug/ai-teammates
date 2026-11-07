import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { bootV5App } from '../../src/v5/ui/app.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 20));
function setup(fetch) {
  const dom = new JSDOM(fs.readFileSync('src/v5/ui/index.html', 'utf8'));
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  bootV5App(dom.window.document, fetch);
  return dom.window;
}
const state = { skills: [], provider: { activeProvider: 'opencode-go', activeModelId: 'exact-model', providers: { 'opencode-go': { hasKey: true, discoveredModels: ['exact-model'] } } } };
const response = data => ({ ok: true, json: async () => data });

test('Enter sends once; HTTP errors preserve input and restore send button', async () => {
  let calls = 0;
  const window = setup(async url => {
    if (url.endsWith('/state')) return response(state);
    calls++;
    return { ok: false, json: async () => ({ error: 'Provider unavailable' }) };
  });
  await tick();
  const input = window.document.getElementById('wish-input');
  input.value = 'Hitta jobb';
  input.dispatchEvent(new window.Event('input'));
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();
  assert.equal(calls, 1);
  assert.equal(input.value, 'Hitta jobb');
  assert.equal(window.document.getElementById('send-btn').disabled, false);
  assert.match(window.document.getElementById('conversation').textContent, /Provider unavailable/);
  window.close();
});

test('catalog models are selectable and saving never supplies a guessed ID', async () => {
  const bodies = [];
  const window = setup(async (url, options) => {
    if (url.endsWith('/state')) return response(state);
    bodies.push(JSON.parse(options.body));
    return response({ provider: state.provider });
  });
  await tick();
  const doc = window.document;
  assert.equal(doc.getElementById('model-select').value, 'exact-model');
  doc.getElementById('model-id-input').value = '';
  doc.getElementById('provider-save-btn').click();
  await tick();
  assert.equal(bodies.length, 0);
  doc.getElementById('model-select').dispatchEvent(new window.Event('change'));
  doc.getElementById('provider-save-btn').click();
  await tick();
  assert.equal(bodies[0].modelId, 'exact-model');
  window.close();
});
