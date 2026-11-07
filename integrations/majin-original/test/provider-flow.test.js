/* End-to-end provider onboarding WITHOUT the open internet:
 * a local stub speaks OpenAI-style /v1/models + /v1/chat/completions,
 * and the real provider tool walks add → models → test against it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Config, DEFAULTS, clone } from '../src/core/config.js';
import { majinTools } from '../src/core/tools/majin.js';

const providerTool = majinTools.find((t) => t.name === 'majin.provider');

test('add → list models → verify key: the whole flow on a stub provider', async () => {
  const calls = { models: 0, chat: 0, authSeen: '' };
  const stub = http.createServer((req, res) => {
    if (req.url.endsWith('/models')) {
      calls.models += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'solo-1' }, { id: 'solo-2-free' }] }));
      return;
    }
    if (req.url.endsWith('/chat/completions')) {
      calls.chat += 1;
      calls.authSeen = req.headers.authorization || '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'cm1', choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-pflow-'));
  const cfg = new Config(clone(DEFAULTS), path.join(dir, 'config.json'));
  const ctx = { cfg };

  /* Gateway-presets (opencode m.fl.) krawer skall-headrar; utan dem 400:ar
     gatewayen aven om nyckeln ar perfekt. Headers maste alltsa folja med. */
  const oc = await providerTool.run({ action: 'add', name: 'opencodechathe', preset: 'opencode', apiKey: 'oc_sk_dummy-not-real' }, ctx);
  assert.ok(oc.ok !== false && !oc.error, 'opencode-add failed: ' + JSON.stringify(oc.error || oc));
  const ocSaved = cfg.get('providers.opencodechathe') || {};
  assert.equal(ocSaved.headers?.['x-opencode-session'], 'majin', 'preset headers must follow the saved provider or the gateway 400:s');
  cfg.patch({ providers: { opencodechathe: undefined } });

  try {
    // 1) onboarding "Save key" — persisted, never echoed back raw
    const add = await providerTool.run(
      { action: 'add', name: 'localbox', kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key-123', models: 'solo-1' },
      ctx,
    );
    assert.equal(add.ok !== false && !add.error, true, 'add failed: ' + JSON.stringify(add.error || add));
    const saved = clone(cfg.get('providers.localbox'));
    assert.equal(saved.apiKey, 'test-key-123', 'the key is stored where the runtime can use it');
    assert.doesNotMatch(cfg.redacted().providers.localbox.apiKey, /test-key-123/, 'the UI only ever sees a masked key');

    // 2) onboarding "load models" — live catalogue path, saved back to config
    const models = await providerTool.run({ action: 'models', name: 'localbox' }, ctx);
    assert.equal(models.ok !== false && !models.error, true, 'models failed: ' + JSON.stringify(models.error || models));
    assert.equal(calls.models, 1, 'the call really hit the provider');
    assert.deepEqual(cfg.get('providers.localbox.models').sort(), ['solo-1', 'solo-2-free'].sort(), 'catalogue persisted for the picker');

    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    stub.close();
  }
});

test('Gemini compatible chat and Anthropic messages reach the correct endpoints with the right keys', async () => {
  const { complete } = await import('../src/core/provider/chat.js');
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/messages') ? { id: 'm', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } : { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-protocol-'));
  try {
    const cfg = new Config(clone(DEFAULTS), path.join(dir, 'config.json'));
    for (const kind of ['openai', 'gemini', 'anthropic']) {
      cfg.patch({ providers: { protocol: { kind, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'protocol-fixture' } } });
      const result = await complete({ route: cfg.resolveModel('protocol/model-id', 'chat'), messages: [{ role: 'user', content: 'OK' }], retries: 0, maxTokens: 4 });
      assert.equal(result.text, 'OK');
    }
    assert.deepEqual(requests.map(r => r.url), ['/v1/chat/completions', '/v1/openai/chat/completions', '/v1/messages']);
    assert.equal(requests[1].headers.authorization, 'Bearer protocol-fixture');
    assert.equal(requests[2].headers['x-api-key'], 'protocol-fixture');
    assert.ok(requests.every(r => r.body.model === 'model-id'));
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
