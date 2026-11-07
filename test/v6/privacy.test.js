import test from 'node:test';
import assert from 'node:assert/strict';
import { scrub, assertSyncSafe, findSyncViolations, maskEmail } from '../../src/v6/redact.js';
import { buildSyncPayload, pushTelemetry, verifyPrivateRepo } from '../../src/v6/sync.js';
import { loadOwnerToken } from '../../src/v6/secrets.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('events keep operational shape but remove secrets, emails and private content', () => {
  const scrubbed = scrub({
    token: 'super-secret', authorization: 'Bearer abcdefghijklmnop', password: 'hunter2',
    body: 'private email body that must not be stored',
    summary: 'Contact me at person@example.com',
    note: 'link https://portal.example/verify?token=abcdef123456',
  });
  assert.equal(scrubbed.token, '[REDACTED]');
  assert.equal(scrubbed.authorization, '[REDACTED]');
  assert.equal(scrubbed.password, '[REDACTED]');
  assert.match(scrubbed.body, /^\[OMITTED \d+ chars\]$/);
  assert.equal(scrubbed.summary, 'Contact me at p*****@example.com');
  assert.ok(!scrubbed.note.includes('abcdef123456'));
  assert.equal(maskEmail('a@b.se'), 'a**@b.se');
});

test('the sync gate refuses private fields, tokens and verification links', () => {
  assert.throws(() => assertSyncSafe({ nested: { refreshToken: 'x' } }), /private data/);
  const plantedToken = ['ghp', 'x'.repeat(26)].join('_');
  assert.throws(() => assertSyncSafe({ note: plantedToken }), /private data/);
  assert.throws(() => assertSyncSafe({ note: 'https://x.example/verify?token=abc' }), /private data/);
  assert.deepEqual(findSyncViolations({ ok: true, count: 2 }), []);
  const payload = buildSyncPayload({
    generatedAt: '2026-01-01T00:00:00.000Z',
    engine: { state: 'RUNNING' },
    queue: { byState: { COMPLETED: 2 } },
    workers: [{ state: 'ACTIVE', ageSeconds: 2, lastAction: 'tool started' }],
    activity: [{ at: '2026-01-01T00:00:00.000Z', type: 'task.completed', taskId: 'tsk_1', data: { body: 'private' } }],
    jobs: { total: 3, byState: { CONFIRMED_RECEIVED: 1 } },
    checks: {},
    limitations: [],
  });
  assert.equal(payload.queue.COMPLETED, 2);
  assert.equal(payload.activity[0].data, undefined, 'raw event payloads are not uploaded');
  assert.equal(assertSyncSafe(payload), true);
});

test('a public repository is refused before any upload', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options?.method || 'GET' });
    return { ok: true, status: 200, json: async () => ({ full_name: 'rssen-debug/majin2026', private: false, default_branch: 'main' }) };
  };
  const result = await verifyPrivateRepo({ token: 't', repo: 'rssen-debug/majin2026', fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'SYNC_REPO_NOT_PRIVATE');
  const push = await pushTelemetry({
    report: { generatedAt: '2026-01-01T00:00:00.000Z', queue: { byState: {} } },
    repo: 'rssen-debug/majin2026', token: 't', fetchImpl,
  });
  assert.equal(push.ok, false);
  assert.equal(push.error.code, 'SYNC_REPO_NOT_PRIVATE');
  assert.ok(calls.every((call) => call.method === 'GET'), 'no write request may be attempted');
});

test('a private repository receives a sanitized report through the API, without gh', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body });
    if (url.endsWith('/repos/rssen-debug/majin2026')) {
      return { ok: true, status: 200, json: async () => ({ full_name: 'rssen-debug/majin2026', private: true, default_branch: 'main' }) };
    }
    if (options.method === 'GET' && url.includes('/contents/')) {
      return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    }
    if (options.method === 'PUT') {
      return { ok: true, status: 201, json: async () => ({ commit: { sha: 'commit-1' } }) };
    }
    throw new Error(`unexpected request ${options.method || 'GET'} ${url}`);
  };
  const result = await pushTelemetry({
    report: {
      generatedAt: '2026-01-01T00:00:00.000Z',
      engine: { state: 'RUNNING' },
      queue: { byState: { COMPLETED: 1 } },
      workers: [{ state: 'ACTIVE', ageSeconds: 1, lastAction: 'working' }],
      activity: [{ at: '2026-01-01T00:00:00.000Z', type: 'task.completed', taskId: 'tsk_1' }],
      jobs: { total: 1, byState: { MATCHED: 1 } },
    },
    repo: 'rssen-debug/majin2026', token: 'secret-token', fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.repo, 'rssen-debug/majin2026');
  const put = calls.find((call) => call.method === 'PUT');
  assert.ok(put.body);
  const uploaded = JSON.parse(Buffer.from(JSON.parse(put.body).content, 'base64').toString('utf8'));
  assert.equal(uploaded.queue.COMPLETED, 1);
  assert.equal(uploaded.schema, 'majin.v6.telemetry/v1');
  assert.ok(!JSON.stringify(uploaded).includes('secret-token'));
  assert.ok(!calls.some((call) => String(call.url).includes('gh')));
});

test('a 404 repository is not treated as private', async () => {
  const result = await verifyPrivateRepo({
    token: 't', repo: 'rssen-debug/majin2026',
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ message: 'Not Found' }) }),
  });
  assert.equal(result.error.code, 'SYNC_REPO_NOT_ACCESSIBLE');
});

test('owner tokens are only read from env or a 0600 file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v6-token-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'token');
  fs.writeFileSync(file, 'file-token');
  fs.chmodSync(file, 0o644);
  if (process.platform !== 'win32') {
    assert.equal(loadOwnerToken({ envNames: ['NOPE'], file }).error.code, 'TOKEN_FILE_PERMISSIONS');
  }
  fs.chmodSync(file, 0o600);
  assert.equal(loadOwnerToken({ envNames: ['NOPE'], file }).token, 'file-token');
  assert.equal(loadOwnerToken({ envNames: ['YES'], file, env: { YES: 'env-token' } }).source, 'env:YES');
  assert.equal(loadOwnerToken({ envNames: [], file: path.join(root, 'missing') }).error.code, 'TOKEN_FILE_MISSING');
});
