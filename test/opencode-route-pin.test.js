import test from 'node:test';
import assert from 'node:assert/strict';
import { Config, DEFAULTS, clone } from '../src/core/config.js';
import { routeFor } from '../src/core/router.js';

function settings() {
  const data = clone(DEFAULTS);
  // Ensure the fallback is always available: detecting silent provider swaps
  // must not depend on an external API key or an online model catalog.
  data.models.fallbackOrder = ['demo'];
  data.providers.opencode.apiKey = null;
  data.providers.opencodezen.apiKey = null;
  data.providers.deepseek.apiKey = null;
  return data;
}

test('selected OpenCode Go remains selected without credentials (never silently falls back to demo)', () => {
  const data = settings();
  data.models.routes.chat = 'opencode/glm-5.3-flash';
  const cfg = new Config(data);
  const route = routeFor(cfg, 'chat');
  assert.equal(route.providerName, 'opencode');
  assert.equal(route.ref, 'opencode/glm-5.3-flash');
  assert.equal(route.baseUrl, 'https://opencode.ai/zen/go/v1');
});

test('OpenCode Zen is separate from Go even when credentials are missing', () => {
  const data = settings();
  data.models.routes.chat = 'opencodezen/my-model';
  const route = routeFor(new Config(data), 'chat');
  assert.equal(route.providerName, 'opencodezen');
  assert.equal(route.ref, 'opencodezen/my-model');
  assert.equal(route.baseUrl, 'https://opencode.ai/zen/v1');
});

test('legacy unconfigured DeepSeek still uses explicitly allowed demo fallback', () => {
  const data = settings();
  data.models.routes.chat = 'deepseek/deepseek-flash';
  const route = routeFor(new Config(data), 'chat');
  assert.equal(route.providerName, 'demo');
});

test('session-pinned Go choice wins over global fallback', () => {
  const data = settings();
  data.models.routes.chat = 'deepseek/deepseek-flash';
  data.models.sessionRoutes = { 'some-session': { chat: 'opencode/glm-5.3-flash' } };
  const route = routeFor(new Config(data), 'chat', { session: 'some-session' });
  assert.equal(route.providerName, 'opencode');
});
