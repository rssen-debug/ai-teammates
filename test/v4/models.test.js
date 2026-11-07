import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempHome, startTestServer, postChat } from './helpers.mjs';
import { discoverModels, resolveRouteForModel, routeUnavailableReason } from '../../src/v4/models.js';

const V1_SECRET = 'sk-live-must-never-leak-0123456789';

function writeV1Config(home, extra = {}) {
  const cfg = {
    version: 1,
    providers: {
      deepseek: {
        label: 'DeepSeek',
        kind: 'openai',
        baseUrl: 'https://api.deepseek.example',
        apiKey: V1_SECRET,
        models: ['deepseek-chat', 'deepseek-reasoner'],
      },
      openrouter: {
        label: 'OpenRouter',
        kind: 'openai',
        baseUrl: 'https://openrouter.example/api',
        apiKey: '{env:OPENROUTER_KEY}',
        models: ['z-ai/glm-4.6'],
      },
      unconfigured: {
        label: 'Tom',
        kind: 'openai',
        baseUrl: 'https://empty.example',
        apiKey: null,
        models: ['nothing-here'],
      },
    },
    models: { routes: { chat: 'deepseek/deepseek-chat', tasks: 'deepseek/deepseek-chat' } },
    ...extra,
  };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg, null, 2));
}

test('models: existing V1 providers are discovered without reading a key', () => {
  const home = tempHome();
  writeV1Config(home);
  const cat = discoverModels({ home, env: {} });
  assert.equal(cat.source, 'v1-config');
  const ids = cat.models.map((m) => m.id);
  assert.ok(ids.includes('deepseek/deepseek-chat'));
  assert.ok(ids.includes('deepseek/deepseek-reasoner'));
  const noKey = cat.models.find((m) => m.id === 'openrouter/z-ai/glm-4.6');
  assert.ok(noKey, 'model is still listed so the phone can explain why it is unavailable');
  assert.equal(noKey.configured, false);
  assert.equal(noKey.status, 'missing-key');
  assert.equal(cat.current, 'deepseek/deepseek-chat');
  assert.equal(cat.models.find((m) => m.id === 'deepseek/deepseek-chat').liveVerified, false);
  assert.equal(JSON.stringify(cat).includes(V1_SECRET), false, 'no credential may appear in the catalogue');
  fs.rmSync(home, { recursive: true, force: true });
});

test('models: an env-backed key is resolved for discovery but never serialised', () => {
  const home = tempHome();
  writeV1Config(home);
  const cat = discoverModels({ home, env: { OPENROUTER_KEY: 'rot-secret-value' } });
  const entry = cat.models.find((m) => m.id === 'openrouter/z-ai/glm-4.6');
  assert.ok(entry);
  assert.equal(entry.configured, true);
  assert.equal(JSON.stringify(cat).includes('rot-secret-value'), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('models: route resolution rejects ids that are not in the configured catalogue', () => {
  const home = tempHome();
  writeV1Config(home);
  const env = {};
  assert.equal(resolveRouteForModel({ home, env, modelId: 'deepseek/deepseek-chat' }).model, 'deepseek-chat');
  assert.equal(resolveRouteForModel({ home, env, modelId: 'deepseek/not-declared' }), null);
  assert.equal(resolveRouteForModel({ home, env, modelId: 'evil/model' }), null);
  assert.equal(resolveRouteForModel({ home, env, modelId: '../../etc/passwd' }), null);
  assert.equal(resolveRouteForModel({ home, env, modelId: '' }), null);
  fs.rmSync(home, { recursive: true, force: true });
});

test('models: route diagnostics distinguish stale selections from missing credentials without leaking keys', () => {
  const home = tempHome();
  writeV1Config(home);
  const env = {};
  assert.equal(routeUnavailableReason({ home, env, modelId: 'deepseek/not-declared' }), 'model-not-listed');
  assert.equal(routeUnavailableReason({ home, env, modelId: 'unconfigured/nothing-here' }), 'api-key-missing');
  assert.equal(routeUnavailableReason({ home, env, modelId: 'removed/model' }), 'provider-missing');
  assert.equal(routeUnavailableReason({ home, env, modelId: 'openrouter/z-ai/glm-4.6' }), 'api-key-missing');
  assert.equal(JSON.stringify([
    routeUnavailableReason({ home, env, modelId: 'openrouter/z-ai/glm-4.6' }),
  ]).includes(V1_SECRET), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('models: the API lists the host catalogue and never a key', async () => {
  const home = tempHome();
  writeV1Config(home);
  const s = await startTestServer({ home });
  try {
    const { cookie } = await s.pair();
    const res = await fetch(`${s.base}/api/models`, { headers: { cookie } });
    const raw = await res.text();
    assert.equal(res.status, 200);
    assert.equal(raw.includes(V1_SECRET), false);
    const data = JSON.parse(raw);
    assert.ok(data.models.length >= 2);
    assert.ok(data.models.every((m) => !('apiKey' in m) && !('baseUrl' in m)));
    assert.ok(data.models.every((m) => m.liveVerified === false));
  } finally {
    await s.close();
  }
});

test('models: mobile alias endpoint requires a session', async () => {
  const s = await startTestServer();
  try {
    const res = await fetch(`${s.base}/api/models`);
    assert.equal(res.status, 401);
  } finally {
    await s.close();
  }
});

test('models: explicit authorized selection becomes canonical without rewriting conversation history', async () => {
  const home = tempHome();
  writeV1Config(home);
  const s = await startTestServer({ home });
  try {
    const { cookie } = await s.pair();
    const created = await fetch(`${s.base}/api/conversations`, {
      method: 'POST',
      headers: { cookie, 'x-majin-csrf': '1', origin: s.base },
    });
    const conv = (await created.json()).conversation;

    const select = await fetch(`${s.base}/api/model`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
      body: JSON.stringify({ conversationId: conv.id, modelId: 'deepseek/deepseek-reasoner', expectedVersion: 0, authorizePotentialCost: true }),
    });
    assert.equal(select.status, 200);
    const body = await select.json();
    assert.equal(body.modelId, 'deepseek/deepseek-reasoner');

    const read = await fetch(`${s.base}/api/conversation?id=${conv.id}`, { headers: { cookie } });
    assert.equal((await read.json()).conversation.modelId, null, 'history metadata is preserved');
    const canonical = await (await fetch(`${s.base}/api/models`, { headers: { cookie } })).json();
    assert.equal(canonical.selection.modelId, 'deepseek/deepseek-reasoner');
    assert.equal(canonical.selection.version, 1);
    assert.equal(s.context.model.routeForModel(null).model, 'deepseek-reasoner');

    const other = await fetch(`${s.base}/api/conversations`, {
      method: 'POST',
      headers: { cookie, 'x-majin-csrf': '1', origin: s.base },
    });
    const otherId = (await other.json()).conversation.id;
    const otherRead = await fetch(`${s.base}/api/conversation?id=${otherId}`, { headers: { cookie } });
    assert.equal((await otherRead.json()).conversation.modelId, null, 'other conversations are untouched');
  } finally {
    await s.close();
  }
});

test('models: selecting an unknown or unconfigured model is refused', async () => {
  const home = tempHome();
  writeV1Config(home);
  const s = await startTestServer({ home });
  try {
    const { cookie } = await s.pair();
    const created = await fetch(`${s.base}/api/conversations`, {
      method: 'POST',
      headers: { cookie, 'x-majin-csrf': '1', origin: s.base },
    });
    const conv = (await created.json()).conversation;
    for (const modelId of ['evil/model', 'deepseek/not-declared', 'openrouter/z-ai/glm-4.6']) {
      const res = await fetch(`${s.base}/api/model`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
        body: JSON.stringify({ conversationId: conv.id, modelId, expectedVersion: 0 }),
      });
      assert.equal(res.status, 400, modelId);
      assert.equal((await res.json()).error.code, 'MODEL_NOT_CONFIGURED');
    }
  } finally {
    await s.close();
  }
});

test('models: a broken config degrades to demo instead of crashing', async () => {
  const home = tempHome();
  fs.writeFileSync(path.join(home, 'config.json'), '{not json');
  const s = await startTestServer({ home });
  try {
    const { cookie } = await s.pair();
    const state = await fetch(`${s.base}/api/state`, { headers: { cookie } });
    const body = await state.json();
    assert.equal(body.model.demo, true);
    assert.equal(body.models.count, 0);
    const cat = discoverModels({ home, env: {} });
    assert.equal(cat.configReadable, false);
  } finally {
    await s.close();
  }
});

test('models: the demo lane answers without any provider and is labelled as demo', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const res = await postChat(s.base, cookie, { text: 'Hej' });
    const raw = await res.text();
    assert.ok(raw.includes('"demo":true'));
    assert.ok(raw.includes('demo-läge') || raw.includes('demo mode'));
  } finally {
    await s.close();
  }
});

/* ---------------------------------------------------------------------------
 * Live catalog discovery. The fetching is V1's code (src/core/provider/
 * catalog.js); these tests prove V4 uses it, caches it, and never leaks a key.
 * ------------------------------------------------------------------------- */

import { refreshProviderCatalog, refreshAllCatalogs, readCatalogCache, cacheEntryFresh, CATALOG_TTL_MS } from '../../src/v4/models.js';

function mockFetch(payload, { status = 200 } = {}) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), headers: opts.headers || {} });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    };
  };
  fn.calls = calls;
  return fn;
}

test('catalog: refresh uses the provider /models endpoint and never sends the key to the client', async () => {
  const home = tempHome();
  writeV1Config(home);
  const fetchImpl = mockFetch({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-v3' }] });
  const entry = await refreshProviderCatalog({ home, env: {}, providerName: 'deepseek', fetchImpl });
  assert.equal(entry.ok, true);
  assert.deepEqual(entry.models.sort(), ['deepseek-chat', 'deepseek-v3']);
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0].url, /\/models$/);
  assert.equal(fetchImpl.calls[0].headers.authorization, `Bearer ${V1_SECRET}`);
  // the persisted cache must not contain the credential
  const persisted = fs.readFileSync(path.join(home, 'v4', 'model-cache.json'), 'utf8');
  assert.equal(persisted.includes(V1_SECRET), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('catalog: discovered models are listed and routable, marked as discovered', async () => {
  const home = tempHome();
  writeV1Config(home);
  await refreshAllCatalogs({
    home,
    env: {},
    fetchImpl: mockFetch({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-brand-new' }] }),
  });
  const cat = discoverModels({ home, env: {} });
  const fresh = cat.models.find((m) => m.model === 'deepseek-brand-new');
  assert.ok(fresh, 'newly discovered model appears in the catalogue');
  assert.equal(fresh.status, 'discovered');
  assert.equal(fresh.discoveredVia, 'catalog');
  assert.equal(fresh.liveVerified, false, 'listing is not inference');

  const route = resolveRouteForModel({ home, env: {}, modelId: 'deepseek/deepseek-brand-new' });
  assert.ok(route, 'a discovered model can be routed');
  assert.equal(route.model, 'deepseek-brand-new');
  assert.equal(route.baseUrl, 'https://api.deepseek.example', 'endpoint still comes from config');
  fs.rmSync(home, { recursive: true, force: true });
});

test('catalog: an expired cache stops authorising models it discovered', async () => {
  const home = tempHome();
  writeV1Config(home);
  const entry = await refreshProviderCatalog({ home, env: {}, providerName: 'deepseek', fetchImpl: mockFetch({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-old' }] }) });
  assert.ok(entry.ok);
  const stale = { v: 1, providers: { deepseek: { ...entry, at: new Date(Date.now() - CATALOG_TTL_MS - 1000).toISOString() } } };
  fs.writeFileSync(path.join(home, 'v4', 'model-cache.json'), JSON.stringify(stale));
  assert.equal(readCatalogCache({ home }).providers.deepseek.ok, true);
  assert.equal(cacheEntryFresh(readCatalogCache({ home }).providers.deepseek), false);
  assert.equal(resolveRouteForModel({ home, env: {}, modelId: 'deepseek/deepseek-old' }), null);
  assert.ok(resolveRouteForModel({ home, env: {}, modelId: 'deepseek/deepseek-chat' }), 'config-declared models still work');
  fs.rmSync(home, { recursive: true, force: true });
});

test('catalog: provider errors are reported, cached honestly and never crash the listing', async () => {
  const home = tempHome();
  writeV1Config(home);
  const entry = await refreshProviderCatalog({
    home,
    env: {},
    providerName: 'deepseek',
    fetchImpl: mockFetch({ error: { message: 'invalid api key' } }, { status: 401 }),
  });
  assert.equal(entry.ok, false);
  assert.match(entry.error, /401|failed/i);
  const cat = discoverModels({ home, env: {} });
  assert.equal(cat.catalog.providers.deepseek.ok, false);
  assert.ok(cat.models.length >= 2, 'config models still listed');
  fs.rmSync(home, { recursive: true, force: true });
});

test('catalog: a hung provider is cut off before it can stall the API', async () => {
  const home = tempHome();
  writeV1Config(home);
  const hang = () => new Promise(() => {});
  const started = Date.now();
  const entry = await refreshProviderCatalog({ home, env: {}, providerName: 'deepseek', fetchImpl: hang, timeoutMs: 150 });
  assert.equal(entry.ok, false);
  assert.match(entry.error, /timed out/i);
  assert.ok(Date.now() - started < 3000, 'timeout is enforced');
  fs.rmSync(home, { recursive: true, force: true });
});

test('catalog: a provider without a key is never called', async () => {
  const home = tempHome();
  writeV1Config(home);
  const fetchImpl = mockFetch({ data: [] });
  const entry = await refreshProviderCatalog({ home, env: {}, providerName: 'openrouter', fetchImpl });
  assert.equal(entry.ok, false);
  assert.match(entry.error, /no api key/i);
  assert.equal(fetchImpl.calls.length, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('catalog: /api/models?refresh=1 triggers one discovery pass and stays authenticated', async () => {
  const home = tempHome();
  writeV1Config(home);
  const s = await startTestServer({ home });
  try {
    const unauthenticated = await fetch(`${s.base}/api/models?refresh=1`);
    assert.equal(unauthenticated.status, 401);

    const { cookie } = await s.pair();
    const res = await fetch(`${s.base}/api/models?refresh=1`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.equal(raw.includes(V1_SECRET), false);
    const data = JSON.parse(raw);
    assert.ok(data.catalog, 'catalog metadata is reported');
    // The sandbox cannot reach api.deepseek.example: the failure must be visible,
    // not silently converted into a fake success.
    assert.equal(data.catalog.providers.deepseek.ok, false);
    assert.ok(data.models.some((m) => m.id === 'deepseek/deepseek-chat'));
  } finally {
    await s.close();
  }
});
