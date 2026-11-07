import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverModels } from '../src/core/provider/catalog.js';
import { chatUrl, listModelsUrl, splitModel } from '../src/core/presets.js';
import { normalizeCatalog } from '../src/ui/catalog.js';
const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

test('Anthropic native auth and cursor pagination preserve the full catalog', async () => {
  let calls = 0;
  const result = await discoverModels({ kind: 'anthropic', baseUrl: 'https://api.example/v1', apiKey: 'fixture' }, { fetchImpl: async (url, options) => {
    calls++;
    assert.equal(options.headers['x-api-key'], 'fixture');
    assert.equal(options.headers['anthropic-version'], '2023-06-01');
    assert.equal(options.headers.authorization, undefined);
    if (calls === 1) return response({ data: Array.from({ length: 600 }, (_, i) => ({ id: 'claude-' + i, display_name: 'Claude ' + i })), has_more: true, last_id: 'claude-599' });
    assert.equal(url.searchParams.get('after_id'), 'claude-599');
    return response({ data: [{ id: 'claude-600' }], has_more: false });
  } });
  assert.equal(result.ok, true);
  assert.equal(result.count, 601);
  assert.equal(result.catalog[0].name, 'Claude 0');
});

test('Gemini native pages use Google auth and exact chat IDs; chat uses compatible protocol', async () => {
  let calls = 0;
  const result = await discoverModels({ kind: 'gemini', baseUrl: 'https://google.example/v1beta', apiKey: 'fixture' }, { fetchImpl: async (url, options) => {
    assert.equal(options.headers['x-goog-api-key'], 'fixture');
    if (++calls === 1) return response({ models: [{ name: 'models/gemini-chat', displayName: 'Gemini Chat', inputTokenLimit: 200000, supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'page-2' });
    assert.equal(url.searchParams.get('pageToken'), 'page-2');
    return response({ models: [{ name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }] });
  } });
  assert.deepEqual(result.models, ['gemini-chat']);
  assert.equal(result.catalog[0].context, 200000);
  assert.equal(chatUrl({ kind: 'gemini', baseUrl: 'https://google.example/v1beta/' }), 'https://google.example/v1beta/openai/chat/completions');
  assert.equal(chatUrl({ kind: 'gemini', baseUrl: 'https://google.example/v1beta/openai/' }), 'https://google.example/v1beta/openai/chat/completions');
});

test('Qwen workspace endpoints and page totals use the documented native model list', async () => {
  const provider = { kind: 'openai', baseUrl: 'https://workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', apiKey: 'fixture' };
  assert.match(listModelsUrl(provider), /\/api\/v1\/models\?/);
  let calls = 0;
  const result = await discoverModels(provider, { fetchImpl: async (url, options) => {
    assert.equal(options.headers.authorization, 'Bearer fixture');
    if (++calls === 2) assert.equal(url.searchParams.get('page_no'), '2');
    return response({ output: { total: 2, models: [{ model: 'qwen-' + calls, name: 'Qwen ' + calls, model_info: { context_window: 131072 }, features: ['function-calling'] }] } });
  } });
  assert.deepEqual(result.models, ['qwen-1', 'qwen-2']);
  assert.equal(result.catalog[0].tools, true);
  assert.equal(result.catalog[0].context, 131072);
  assert.equal(result.catalog[0].free, false, 'missing compatible pricing cannot imply free');
});

test('malformed catalogs, failing pages and hostile next links never become successful partial lists', async () => {
  const provider = { baseUrl: 'https://api.example/v1', apiKey: 'fixture' };
  for (const payload of [{ error: { message: 'rejected' } }, {}, { data: [], has_more: true }, { data: [{ id: 'one' }], next: 'https://elsewhere.example/models' }]) {
    let calls = 0;
    const result = await discoverModels(provider, { fetchImpl: async () => { calls++; return response(payload); } });
    assert.equal(result.ok, false);
    assert.equal(result.models, undefined);
    assert.ok(calls <= 1, 'no credentials forwarded to another host');
  }
  assert.equal((await discoverModels({ baseUrl: 'not a URL' })).ok, false);
});

test('OpenAI vendor IDs, environment credentials and custom headers stay intact', async () => {
  process.env.MAJIN_CATALOG_TEST_KEY = 'fixture-env';
  try {
    const result = await discoverModels({ baseUrl: 'https://api.example/v1', keyEnv: 'MAJIN_CATALOG_TEST_KEY', headers: { 'x-tenant': 'test' } }, { fetchImpl: async (_url, options) => {
      assert.equal(options.headers.authorization, 'Bearer fixture-env');
      assert.equal(options.headers['x-tenant'], 'test');
      return response({ data: [{ id: 'vendor/model' }, { id: 'vendor/model' }] });
    } });
    assert.deepEqual(result.models, ['vendor/model']);
    assert.equal(splitModel('vendor/model', { providers: { gateway: {} }, models: { provider: 'gateway' } }).model, 'vendor/model');
  } finally { delete process.env.MAJIN_CATALOG_TEST_KEY; }
  assert.equal(normalizeCatalog({ data: [{ id: 'name-free' }] })[0].free, false);
});
