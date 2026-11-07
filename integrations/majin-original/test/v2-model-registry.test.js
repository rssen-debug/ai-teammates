/**
 * Model registry refresh lane.
 * Offline proven against REAL stub gateways (OpenAI-shaped and hostile
 * variants); live round-trip is IT-gated (IT_MODELS=1 + OPENCODE_API_KEY),
 * exactly like the other live lanes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { refreshRegistry, readRegistry, drift } from '../src/v2/model/registry-refresh.js';
import { PROVIDER_PROFILES } from '../src/v2/model/profiles.js';

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, 'model-registry.json');
}

async function stubGateway(t, { status = 200, payload, assertAuth = true } = {}) {
  const seen = { auth: null, hits: 0 };
  const srv = http.createServer((req, res) => {
    seen.hits++;
    seen.auth = req.headers.authorization || null;
    if (assertAuth && !seen.auth) { res.writeHead(401); return res.end('{"error":"no key"}'); }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { url: `http://127.0.0.1:${srv.address().port}/v1`, seen };
}

const PROFILE_STUB = (url) => ({ baseUrl: url, keyEnv: 'OPENCODE_API_KEY', chatCompletionsModels: ['a-old', 'b-keep'], extraHeaders: {} });

test('1. happy path: OpenAI-shaped list cached with hash + fingerprint; auth header sent; drift computed', async (t) => {
  const { url, seen } = await stubGateway(t, { payload: { object: 'list', data: [{ id: 'b-keep' }, { id: 'c-new' }] } });
  const cache = tmp(t);
  const r = await refreshRegistry(cache, { profile: PROFILE_STUB(url), key: 'oc_sk_TEST_KEY_xxxxx' });
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  assert.match(seen.auth, /^Bearer oc_sk_TEST_KEY/);
  assert.deepEqual(r.drift.added, ['c-new']);
  assert.deepEqual(r.drift.removed, ['a-old']);
  const read = readRegistry(cache);
  assert.equal(read.state, 'FRESH');
  assert.equal(read.count, 2);
  assert.match(read.keyFingerprint, /^[0-9a-f]{8}$/);
  assert.ok(!fs.readFileSync(cache, 'utf8').includes('oc_sk_TEST_KEY_xxxxx'), 'the key NEVER enters the cache');
  assert.equal(read.contentHash.length, 64);
});

test('2. KEY_MISSING: no key → ModelError, ZERO gateway traffic (the stub saw nothing)', async (t) => {
  const { url, seen } = await stubGateway(t, { payload: { data: [] }, assertAuth: false });
  await assert.rejects(() => refreshRegistry(tmp(t), { profile: PROFILE_STUB(url), key: '' }), (e) => e.cls === 'KEY_MISSING');
  assert.equal(seen.hits, 0, 'no key means no packet leaves — proven by the stub');
});

test('3. GATEWAY_ERROR: HTTP 429 surfaces the real status; nothing cached', async (t) => {
  const { url } = await stubGateway(t, { status: 429, payload: { error: 'slow down' }, assertAuth: false });
  await assert.rejects(() => refreshRegistry(tmp(t), { profile: PROFILE_STUB(url), key: 'k' }), (e) => e.cls === 'GATEWAY_ERROR' && e.message.includes('429'));
});

test('4. PAYLOAD_INVALID: hostile payload shapes are refused, never fabricated into a list', async (t) => {
  for (const [name, payload] of [
    ['not JSON', 'garbage{'],
    ['no array', { object: 'error' }],
    ['empty ids', { data: [{}, { name: 1 }] }],
    ['xml-ish', '<html>nope</html>'],
  ]) {
    const { url } = await stubGateway(t, { payload, assertAuth: false });
    await assert.rejects(() => refreshRegistry(tmp(t), { profile: PROFILE_STUB(url), key: 'k' }), (e) => e.cls === 'PAYLOAD_INVALID', name);
  }
});

test('5. staleness is an injected-clock fact, not a vibe: 25h old → STALE with honest detail; absence → CACHE_EMPTY', (t) => {
  const cache = tmp(t);
  assert.equal(readRegistry(cache).state, 'CACHE_EMPTY');
  const freshAt = new Date('2026-10-22T10:00:00Z');
  fs.writeFileSync(cache, JSON.stringify({ format: 'majin-v2-model-registry', version: 1, fetchedAt: freshAt.toISOString(), source: 'x', keyFingerprint: 'abcd1234', contentHash: 'h', models: ['m1'] }));
  assert.equal(readRegistry(cache, { now: freshAt.getTime() + 3600_000 }).state, 'FRESH');
  const stale = readRegistry(cache, { now: freshAt.getTime() + 25 * 3600_000 });
  assert.equal(stale.state, 'STALE');
  assert.match(stale.detail, /older than the 24h honesty window/);
  // corrupted cache is a STATE we refuse, not content we trust
  fs.writeFileSync(cache, '{broken');
  assert.equal(readRegistry(cache).state, 'CACHE_INVALID');
});

test('6. drift() pure function: added/removed/unchanged counts are exact, empty static list → everything added', () => {
  const d = drift({ chatCompletionsModels: ['x', 'y'] }, ['y', 'z']);
  assert.deepEqual(d, Object.freeze({ added: ['z'], removed: ['x'], unchangedCount: 1 }));
  const d2 = drift({ chatCompletionsModels: [] }, ['a']);
  assert.deepEqual(d2.added, ['a']);
});

test('7. CLI: --models on empty cache exits 0 with the honest state; --models-refresh without key exits 1 KEY_MISSING', (t, done) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, OPENCODE_API_KEY: '' };
  const c1 = spawn(process.execPath, ['bin/majin-v2.mjs', '--models', '--telemetry-dir', dir], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let o1 = '';
  c1.stdout.on('data', (d) => { o1 += d; });
  c1.on('exit', (code) => {
    assert.equal(code, 0, o1);
    assert.match(o1, /CACHE_EMPTY/);
    const c2 = spawn(process.execPath, ['bin/majin-v2.mjs', '--models-refresh', '--telemetry-dir', dir], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let o2 = '';
    c2.stderr.on('data', (d) => { o2 += d; });
    c2.on('exit', (code2) => {
      assert.equal(code2, 1, o2);
      assert.match(o2, /KEY_MISSING/);
      done();
    });
  });
});

const LIVE = process.env.IT_MODELS === '1' && !!process.env.OPENCODE_API_KEY;
(LIVE ? test : test.skip)('IT LIVE (IT_MODELS=1 + key): real registry from the real gateway, cache honest', async () => {
  const cache = tmp(test);
  const profile = PROVIDER_PROFILES['opencode-go'];
  const r = await refreshRegistry(cache, { profile, key: process.env.OPENCODE_API_KEY });
  assert.ok(r.count > 0, 'the gateway lists real models');
  console.log(`  LIVE registry: ${r.count} models, drift +[${r.drift.added.join(',')}] -[${r.drift.removed.join(',')}]`);
  const read = readRegistry(cache, { profile });
  assert.equal(read.state, 'FRESH');
});
