/**
 * Provider-flödet onboarding gör: add → models → test — mot en lokal
 * OpenAI-kompatibel STUB-server. Inget externt nätverk, men komplett klient→tool→HTTP→config-kedja.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-pflow-'));
const { Config, DEFAULTS, clone } = await import('../src/core/config.js');
const { majinTools } = await import('../src/core/tools/majin.js');
const providerTool = majinTools.find((t) => t.name === 'majin.provider');
assert.ok(providerTool, 'majin.provider-tool saknas i registry');

let requests = [];
const stub = http.createServer((req, res) => {
  requests.push(req.method + ' ' + req.url);
  res.setHeader('content-type', 'application/json');
  const bad = (req.headers.authorization || '') !== 'Bearer stub-key';
  if (req.url === '/v1/models') {
    if (bad) { res.statusCode = 401; res.end(JSON.stringify({ error: 'invalid key' })); return; }
    res.end(JSON.stringify({ data: [{ id: 'stub-flash' }, { id: 'stub-pro' }, { id: 'stub-vision' }] }));
    return;
  }
  if (req.url === '/v1/chat/completions') {
    if (bad) { res.statusCode = 401; res.end(JSON.stringify({ error: 'invalid key' })); return; }
    res.end(JSON.stringify({ choices: [{ message: { content: 'stub-svar OK' } }] }));
    return;
  }
  res.statusCode = 404; res.end('{}');
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const PORT = stub.address().port;
const BASE = `http://127.0.0.1:${PORT}/v1`;

function mk() {
  const cfg = new Config(clone(DEFAULTS), path.join(tmp, 'conf-' + Math.random().toString(36).slice(2) + '.json'));
  return { cfg };
}

test('add + models + test fungerar end-to-end mot stub (som onboarding steg 2→3)', async (t) => {
  t.after(() => {});
  const { cfg } = mk();
  const ctx = { cfg, runtime: null, session: 't' };
  // steg 2 i onboarding: add
  const add = await providerTool.run({ action: 'add', name: 'stub', kind: 'openai', baseUrl: BASE, apiKey: 'stub-key', models: 'stub-flash,stub-pro' }, ctx);
  assert.equal(add.ok, undefined, 'add ska inte flagga fel: ' + JSON.stringify(add));
  assert.match(String(add.result), /added stub|routed/i, 'add-resultat ska bekräfta: ' + add.result);
  assert.equal(cfg.get('providers.stub.baseUrl'), BASE, 'providern ska pocka spara sig i config');
  assert.ok(fs.readFileSync(cfg.file || path.join(tmp, 'x'), 'utf8').length > 0, 'config-filen ska finnas');
  const onDisk = JSON.parse(fs.readFileSync(cfg.file, 'utf8'));
  assert.equal(onDisk.providers.stub.apiKey, 'stub-key', 'nyckeln ska ligga i config-filen (plattext, 0600)');

  // steg 3 i onboarding: models
  const models = await providerTool.run({ action: 'models', name: 'stub' }, ctx);
  assert.equal(models.ok, undefined, 'models ska inte flagga fel: ' + JSON.stringify(models));
  assert.ok(String(models.result).includes('stub-flash'), 'modelldump ska innehålla stub-flash');
  assert.deepEqual(cfg.get('providers.stub.models').slice(0, 3), ['stub-flash', 'stub-pro', 'stub-vision'], 'hämtade modeller ska sparas i config');

  // steg 3b i onboarding: test (ping)
  const ping = await providerTool.run({ action: 'test', name: 'stub' }, ctx);
  assert.equal(ping.ok, undefined, 'test ska inte flagga fel: ' + JSON.stringify(ping));
  assert.ok(/OK|stub-svar/i.test(String(ping.result)), 'test-svar ska säga OK, fick: ' + ping.result);
  assert.ok(requests.some((r) => r === 'POST /v1/chat/completions'), 'stubben ska ha fått chat/completions-anrop');
});

test('fel: fel nyckel ger förståeligt meddelande med hint, inte krasch', async () => {
  const { cfg } = mk();
  const ctx = { cfg, runtime: null, session: 't' };
  await providerTool.run({ action: 'add', name: 'stub', kind: 'openai', baseUrl: BASE, apiKey: 'FEL', models: 'stub-flash' }, ctx);
  const models = await providerTool.run({ action: 'models', name: 'stub' }, ctx);
  assert.equal(models.ok, false, 'models med fel nyckel ska flagga fel');
  assert.equal(models.error.code, 'list_failed');
  assert.match(String(models.error.message), /401|invalid/i, 'meddelandet ska förklara felet: ' + models.error.message);
  assert.ok(String(models.error.hint || '').length > 3, 'en hint ska finnas: ' + models.error.hint);
  const ping = await providerTool.run({ action: 'test', name: 'stub' }, ctx);
  assert.equal(ping.ok, false);
  assert.match(String(ping.error.message), /wrong|invalid|rejected|401/i, 'test-fel förklarat: ' + ping.error.message);
});

test('fel: url som inte svarar ger förståeligt test-fel (timeout/no response)', async () => {
  const { cfg } = mk();
  const ctx = { cfg, runtime: null, session: 't' };
  await providerTool.run({ action: 'add', name: 'dod', kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'x', models: 'm' }, ctx);
  const ping = await providerTool.run({ action: 'test', name: 'dod' }, ctx);
  assert.equal(ping.ok, false, 'död endpoint ska flagga fel');
  assert.match(String(ping.error.message), /cannot reach|no response|ECONN|abort|fetch|internet/i, 'förståeligt: ' + JSON.stringify(ping.error.message));
  assert.ok(String(ping.error.hint || ping.error.message || '').length > 3, 'hint (eller förklarande message) när endpoint inte svarar: ' + JSON.stringify(ping.error));
});

test('add kräver baseUrl om inget preset matchar (server-side regel speglad)', async () => {
  const { cfg } = mk();
  const ctx = { cfg, runtime: null, session: 't' };
  const bad = await providerTool.run({ action: 'add', name: 'hemlos', kind: 'openai', apiKey: 'x' }, ctx);
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'no_url');
  assert.ok(/baseUrl/.test(bad.error.message), 'säg vad som saknas');
});

test('efter suite: stub stängs snyggt', async () => {
  await new Promise((r) => stub.close(r));
});
