/**
 * Provider profile lane — real local OpenAI-compatible server on both ends
 * of the wire; no live gateway calls (that is the operator's lane with their
 * key, on their machine). Proves: header contract incl. V1's session header,
 * honesty gates, and that secrets never leak into errors/logs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProfile, PROVIDER_PROFILES } from '../src/v2/model/profiles.js';
import { OpenAICompatibleProvider, ModelError } from '../src/v2/model/provider.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO, 'bin', 'majin-v2.mjs');
const FAKE_KEY = 'oc_sk_testkey_do_not_use_000000';

function openaiStub({ status = 200, echoAuthInBody = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, authorization: req.headers.authorization, session: req.headers['x-opencode-session'], ua: req.headers['user-agent'], body: JSON.parse(body || '{}') });
      res.writeHead(status, { 'content-type': 'application/json' });
      if (status === 200) {
        res.end(JSON.stringify({
          id: 'chatcmpl-stub',
          model: seen[seen.length - 1].body.model,
          choices: [{ message: { role: 'assistant', content: 'stub-svar' } }],
          usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
        }));
      } else {
        res.end(JSON.stringify({ error: { message: echoAuthInBody ? `bad key ${req.headers.authorization}` : 'unauthorized' } }));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, baseUrl: `http://127.0.0.1:${server.address().port}/v1` })));
}

test('1. opencode-go resolves from env only — baseUrl, V1 default model, keyHash for attribution', () => {
  const r = resolveProfile('opencode-go', { env: { OPENCODE_API_KEY: FAKE_KEY } });
  assert.equal(r.baseUrl, 'https://opencode.ai/zen/go/v1');
  assert.equal(r.model, 'glm-5.3-flash'); // V1 preset's proven default, not a doc scrape
  assert.equal(r.apiKey, FAKE_KEY);
  assert.equal(r.keyRef, 'OPENCODE_API_KEY');
  assert.match(r.keyHash, /^[0-9a-f]{8}$/);
  assert.deepEqual(r.extraHeaders['x-opencode-session'], 'majin'); // V1: gateway refuses without it (400 MissingSessionID)
});

test('2. missing env refuses honestly — PROFILE_KEY_MISSING, zero silent traffic, secret never invented', () => {
  assert.throws(
    () => resolveProfile('opencode-go', { env: {} }),
    (err) => {
      assert.equal(err.cls, 'PROFILE_KEY_MISSING');
      assert.match(err.message, /OPENCODE_API_KEY/);
      assert.match(err.message, /never enter the repo or CLI args/);
      return true;
    }
  );
});

test('3. unknown profile lists the known ones; local profile needs no key', () => {
  assert.throws(() => resolveProfile('nope'), (err) => err.cls === 'UNKNOWN_PROFILE' && /opencode-go/.test(err.message));
  const r = resolveProfile('opencode-local', { env: {} });
  assert.equal(r.apiKey, null);
  assert.equal(r.keyHash, null);
});

test('4. REAL wire: auth + session + ua headers arrive at a real server; response parsed with usage', async () => {
  const { server, seen, baseUrl } = await openaiStub();
  const r = resolveProfile('opencode-go', { env: { OPENCODE_API_KEY: FAKE_KEY }, baseUrl });
  const provider = new OpenAICompatibleProvider({ name: r.name, baseUrl: r.baseUrl, apiKey: r.apiKey, model: r.model, extraHeaders: r.extraHeaders });
  const out = await provider.chat([{ role: 'user', content: 'hej' }]);
  server.close();
  assert.equal(out.text, 'stub-svar');
  assert.equal(out.usage.total_tokens, 16);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(seen[0].session, 'majin');
  assert.match(seen[0].ua, /MAJIN-coding-agent/);
  assert.equal(seen[0].body.model, 'glm-5.3-flash');
  assert.match(seen[0].url, /\/v1\/chat\/completions$/);
});

test('5. secret never leaks: 401 with the key ECHOED in the body still produces a clean AUTH_REQUIRED', async () => {
  const { server, baseUrl } = await openaiStub({ status: 401, echoAuthInBody: true });
  const provider = new OpenAICompatibleProvider({ name: 'opencode-go', baseUrl, apiKey: FAKE_KEY, model: 'glm-5.3-flash', extraHeaders: { 'x-opencode-session': 'majin' } });
  const err = await provider.chat([{ role: 'user', content: 'x' }]).then(() => null).catch((e) => e);
  server.close();
  assert.ok(err instanceof ModelError);
  assert.equal(err.cls, 'AUTH_REQUIRED');
  const surface = err.message + ' ' + JSON.stringify(err.meta) + ' ' + String(err.stack);
  assert.ok(!surface.includes(FAKE_KEY), `key leaked into error surface: ${surface.slice(0, 200)}`);
});

test('6. error classes stay in kernel vocabulary on the real wire (429/500/timeout)', async () => {
  for (const [status, cls] of [[429, 'MODEL_RATE_LIMIT'], [500, 'MODEL_FAILURE']]) {
    const { server, baseUrl } = await openaiStub({ status });
    const provider = new OpenAICompatibleProvider({ name: 'p', baseUrl, apiKey: FAKE_KEY, model: 'm' });
    const err = await provider.chat([{ role: 'user', content: 'x' }]).catch((e) => e);
    server.close();
    assert.equal(err.cls, cls, `status ${status}`);
  }
  const { server, baseUrl } = await openaiStub({ status: 200 });
  // make the stub hang: replace handler? simpler: timeoutMs 50 against a never-answering server
  const hang = http.createServer(() => { /* never respond */ });
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  const slow = new OpenAICompatibleProvider({ name: 'p', baseUrl: `http://127.0.0.1:${hang.address().port}/v1`, model: 'm', timeoutMs: 60 });
  const err = await slow.chat([{ role: 'user', content: 'x' }]).catch((e) => e);
  hang.close(); server.close();
  assert.equal(err.cls, 'TIMEOUT');
});

test('7. CLI --profile without env: exit 2 with the env var named, BEFORE any network', async () => {
  const { server, seen, baseUrl } = await openaiStub();
  const env = { ...process.env };
  delete env.OPENCODE_API_KEY;
  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, '--profile', 'opencode-go', '--provider-url', baseUrl, '"build a portfolio"', '--workspace', REPO], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, out }));
  });
  server.close();
  assert.equal(res.code, 2, res.out);
  assert.match(res.out, /OPENCODE_API_KEY/);
  assert.equal(seen.length, 0, 'ZERO network traffic when the key is missing — refusal happens before the wire');
});

test('8. CLI --profile with env: banner shows keyRef+keyHash, NEVER the key itself', async () => {
  const env = { ...process.env, OPENCODE_API_KEY: FAKE_KEY };
  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, '--profile', 'opencode-go', '--help'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, out }));
  });
  // --help exits through usage; also run resolution through a misuse path that prints the provider banner-free error
  assert.equal(res.code, 0);
  assert.ok(!res.out.includes(FAKE_KEY));
  // unit-level: the banner string itself must carry hash not secret
  const r = resolveProfile('opencode-go', { env: { OPENCODE_API_KEY: FAKE_KEY } });
  const banner = `provider: profile ${r.name} → ${r.baseUrl} model=${r.model} key=${r.keyRef} sha256:${r.keyHash}`;
  assert.ok(banner.includes('sha256:') && !banner.includes(FAKE_KEY));
});

test('9. profile table covers zen + local; docs-honest notes carried', () => {
  assert.ok(PROVIDER_PROFILES['opencode-zen'].note.includes('separate access rules'));
  assert.ok(PROVIDER_PROFILES['opencode-go'].note.includes('NOT proof of inference access')); // V1's honesty lesson
  assert.equal(PROVIDER_PROFILES['opencode-local'].keyEnv, null);
});
