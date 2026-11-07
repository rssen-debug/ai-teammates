/**
 * Kilo Gateway (kilocode) — samma transport som OpenRouter men egen base URL och
 * JWT-nyckel. Testet pratar mot en lokal mock som hävdar att den är gatewayen, så
 * det vi kontrollerar är det faktiska HTTP-contractet (path, header, body, :free-id).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PRESETS, chatUrl, listModelsUrl, splitModel } from '../src/core/presets.js';
import { openaiOnce } from '../src/core/provider/openai.js';
import { Config, DEFAULTS, clone } from '../src/core/config.js';
import { parseIntent } from '../src/core/routes.js';

const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJraWxvVXNlcklkIjoiNTNmYTM4ZjIiLCJ2ZXJzaW9uIjozfQ.fakefakesignaturefakesignature0000000';

let seen = [];
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [
        { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', context_length: 200000 },
        { id: 'poolside/laguna-xs.2:free', name: 'Laguna XS (free)' },
        { id: 'mistralai/codestral-2508', name: 'Codestral' },
      ] }));
    }
    if (req.url.includes('boom-401')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'invalid or missing API key', code: 401 } }));
    }
    if (req.url.includes('boom-402')) {
      res.writeHead(402, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Insufficient balance', code: 402 } }));
    }
    if (body?.tools?.length && !body.messages.some((m) => m.role === 'tool')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'gen-mock-1',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'fs.read', arguments: JSON.stringify({ path: 'notes.txt' }) } },
        ] } }],
        usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 },
      }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'gen-mock-2',
      model: body?.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Kilo says hej.' } }],
      usage: { prompt_tokens: 21, completion_tokens: 4, total_tokens: 25 },
    }));
  });
});

let base = '';
test.before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${mock.address().port}/api/gateway`;
});
test.after(() => mock.close());
test.beforeEach(() => { seen = []; });

function kiloCfg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-kilo-'));
  const cfg = new Config(clone(DEFAULTS), path.join(dir, 'config.json'));
  cfg.save = () => true;
  cfg.patch({
    guard: { mode: 'off' },
    providers: { kilocode: { label: 'Kilo Gateway', kind: 'openai', baseUrl: base, apiKey: JWT, models: [...PRESETS.kilocode.models] } },
    models: { provider: 'kilocode' },
  });
  return cfg;
}

test('preset: Kilo Gateway is wired like the docs say', () => {
  const k = PRESETS.kilocode;
  assert.equal(k.kind, 'openai', 'the gateway is OpenAI-compatible');
  assert.equal(k.baseUrl, 'https://ai-gateway.kilo.ai/api/v1', 'the base URL the current docs and the Kilo client use');
  assert.equal(k.keyEnv, 'KILO_API_KEY');
  assert.ok(k.keyUrl.startsWith('https://'), 'the user needs a link where the key is made');
  assert.ok(k.models.some((m) => m.includes(':free')), 'a free model must be in the default list');
  assert.equal(chatUrl(k), 'https://ai-gateway.kilo.ai/api/v1/chat/completions');
  assert.equal(listModelsUrl(k), 'https://ai-gateway.kilo.ai/api/v1/models');
  assert.equal(listModelsUrl({ kind: 'openai', baseUrl: 'https://api.kilo.ai/api/gateway/' }), 'https://api.kilo.ai/api/gateway/models', 'a trailing slash must not double up');
});

test('preset: a kilocode/model ref keeps the vendor prefix intact', () => {
  const cfg = { providers: { kilocode: {}, openrouter: {} } };
  const s = splitModel('kilocode/anthropic/claude-sonnet-4.5', cfg);
  assert.equal(s.provider, 'kilocode');
  assert.equal(s.model, 'anthropic/claude-sonnet-4.5', 'the gateway needs vendor/model as the model id');
});

test('transport: exact HTTP contract against the gateway', async () => {
  const cfg = kiloCfg();
  const route = cfg.resolveModel('kilocode/poolside/laguna-xs.2:free', 'chat');
  assert.equal(route.ref, 'kilocode/poolside/laguna-xs.2:free');
  const out = await openaiOnce({ route: { ...route, endpoint: `${base}/chat/completions` }, messages: [{ role: 'user', content: 'hej' }], maxTokens: 32, temperature: 0.2 });
  assert.equal(out.text, 'Kilo says hej.');
  assert.equal(out.usage.input, 21);
  assert.equal(out.usage.output, 4);
  assert.equal(out.usage.reported, true, 'the gateway reports usage, MAJIN must not guess');
  const req = seen[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/api/gateway/chat/completions', 'path must be chat/completions under the base URL');
  assert.equal(req.headers.authorization, `Bearer ${JWT}`, 'the JWT goes in Authorization: Bearer');
  assert.equal(req.body.model, 'poolside/laguna-xs.2:free', 'the :free suffix must survive to the wire');
  assert.equal(req.body.stream, false);
});

test('transport: tools round-trip through the gateway', async () => {
  const cfg = kiloCfg();
  const route = cfg.resolveModel('kilocode/anthropic/claude-sonnet-4.5', 'tools');
  const out = await openaiOnce({
    route: { ...route, endpoint: `${base}/chat/completions` },
    messages: [{ role: 'user', content: 'read notes.txt' }],
    tools: [{ name: 'fs.read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
  });
  assert.equal(out.stopReason, 'tool_calls');
  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.toolCalls[0].name, 'fs.read');
  assert.deepEqual(JSON.parse(out.toolCalls[0].argsJson), { path: 'notes.txt' });
  assert.equal(seen[0].body.tools[0].function.name, 'fs.read', 'tools are sent in OpenAI shape');
});

test('errors: 401 says key, 402 says credit', async () => {
  const cfg = kiloCfg();
  for (const [which, re] of [['boom-401', /key/i], ['boom-402', /credit|balance/i]]) {
    const route = cfg.resolveModel('kilocode/anthropic/claude-sonnet-4.5', 'chat');
    await assert.rejects(
      () => openaiOnce({ route: { ...route, endpoint: `${base}/${which}/chat/completions` }, messages: [{ role: 'user', content: 'x' }] }),
      (err) => {
        assert.match(err.message, re, `${which} message`);
        if (which === 'boom-402') assert.match(String(err.hint || ''), /credit/i, 'a 402 needs the top-up hint');
        return true;
      },
    );
  }
});

test('majin.provider: models action discovers the gateway catalog and saves it', async () => {
  const cfg = kiloCfg();
  const { buildRegistry } = await import('../src/core/tools/index.js');
  const { approvals } = await import('../src/core/guard.js');
  const registry = buildRegistry({ cfg, emit: () => {}, approvals, memory: null, skills: null, usage: null });
  const res = await registry.exec('majin.provider', { action: 'models', name: 'kilocode' }, { session: 'test' });
  assert.equal(res.ok, true, JSON.stringify(res.error || res));
  assert.match(res.result, /3 models/, res.result);
  assert.deepEqual(cfg.get('providers.kilocode.models'), ['anthropic/claude-sonnet-4.5', 'poolside/laguna-xs.2:free', 'mistralai/codestral-2508']);
  assert.equal(seen[0].url, '/api/gateway/models', '/models needs no auth but a bearer is harmless');
});

test('self-config: a pasted kilo JWT lands on the kilocode provider', () => {
  const cfg = kiloCfg();
  const intent = parseIntent(`my kilo key is ${JWT}`, cfg);
  assert.equal(intent.patch.providers.kilocode.apiKey, JWT, 'the alias "kilo" must map to the preset name');
  assert.match(intent.notes.join(' '), /kilocode/);

  const also = parseIntent(`sätt nyckeln för kilocode: ${JWT}`, cfg);
  assert.equal(also.patch.providers.kilocode.apiKey, JWT);

  const run = parseIntent('kör allt med kilocode', cfg);
  assert.ok(Object.keys(run.patch.models.routes).length >= 10, 'every job should point at the gateway');
  assert.match(run.patch.models.routes.chat, /^kilocode\//);
});

test('self-config: a log that merely mentions a token changes nothing', () => {
  const cfg = kiloCfg();
  const intent = parseIntent(`the log line was: authorization: Bearer something and then the file ${JWT.slice(0, 20)} appeared`, cfg);
  assert.notEqual(intent.patch.providers?.kilocode?.apiKey, JWT.slice(0, 20));
});
