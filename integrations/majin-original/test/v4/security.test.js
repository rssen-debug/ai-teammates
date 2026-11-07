import assert from 'node:assert/strict';
import test from 'node:test';
import { RateLimiter, HttpError, assertCsrfHeader, hostMatches } from '../../src/v4/security.js';
import { formatCode, hmac, safeEqual, SessionStore, loadSecret, verifyPairing, ensurePairing } from '../../src/v4/auth.js';
import { safeFileName, WorkspaceError } from '../../src/v4/tools.js';
import { startTestServer, tempHome, postChat } from './helpers.mjs';
import fs from 'node:fs';
import path from 'node:path';

test('security: unknown pair code is rejected and issues no cookie', async () => {
  const s = await startTestServer();
  try {
    const res = await fetch(`${s.base}/api/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: s.base },
      body: JSON.stringify({ code: 'AAAA-AAAA' }),
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null);
    const body = await res.json();
    assert.equal(body.error.code, 'PAIRING_REJECTED');
  } finally {
    await s.close();
  }
});

test('security: pairing is rate limited', async () => {
  const s = await startTestServer({ env: { MAJIN_V4_RATE_PAIRING: '2' } });
  try {
    for (let i = 0; i < 2; i += 1) {
      await fetch(`${s.base}/api/auth/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: s.base },
        body: JSON.stringify({ code: 'AAAA-AAAA' }),
      });
    }
    const res = await fetch(`${s.base}/api/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: s.base },
      body: JSON.stringify({ code: 'AAAA-AAAA' }),
    });
    assert.equal(res.status, 429);
    assert.ok(res.headers.get('retry-after'));
  } finally {
    await s.close();
  }
});

test('security: unauthenticated API access is refused', async () => {
  const s = await startTestServer();
  try {
    for (const route of ['/api/state', '/api/conversations', '/api/sessions']) {
      const res = await fetch(`${s.base}${route}`);
      assert.equal(res.status, 401, route);
    }
    const chat = await fetch(`${s.base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
      body: JSON.stringify({ text: 'hej' }),
    });
    assert.equal(chat.status, 401);
  } finally {
    await s.close();
  }
});

test('security: cross-origin requests are rejected', async () => {
  const s = await startTestServer();
  try {
    const res = await fetch(`${s.base}/api/health`, {
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.code, 'ORIGIN_REJECTED');
  } finally {
    await s.close();
  }
});

test('security: mutating request without CSRF header is rejected', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const res = await fetch(`${s.base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: s.base, cookie },
      body: JSON.stringify({ text: 'hej' }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'CSRF_REQUIRED');
  } finally {
    await s.close();
  }
});

test('security: host header allowlist blocks DNS rebinding names', async () => {
  const s = await startTestServer({ env: { MAJIN_V4_ALLOWED_HOSTS: 'majin.example' } });
  try {
    // real server socket, forged Host header
    const http = await import('node:http');
    const port = s.server.address().port;
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/health', headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  } finally {
    await s.close();
  }
});

test('security: oversized body is rejected with 413', async () => {
  const s = await startTestServer({ env: { MAJIN_V4_MAX_BODY_BYTES: '1024' } });
  try {
    const { cookie } = await s.pair();
    const res = await postChat(s.base, cookie, { text: 'x'.repeat(5000) });
    assert.equal(res.status, 413);
  } finally {
    await s.close();
  }
});

test('security: session cookie is HttpOnly and SameSite=Strict', async () => {
  const s = await startTestServer();
  try {
    const res = await fetch(`${s.base}/api/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: s.base },
      body: JSON.stringify({ code: s.context.pairingFresh }),
    });
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);
  } finally {
    await s.close();
  }
});

test('security: logout revokes the session immediately', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const before = await fetch(`${s.base}/api/state`, { headers: { cookie } });
    assert.equal(before.status, 200);

    const out = await fetch(`${s.base}/api/auth/logout`, {
      method: 'POST',
      headers: { 'x-majin-csrf': '1', origin: s.base, cookie },
    });
    assert.equal(out.status, 200);

    const after = await fetch(`${s.base}/api/state`, { headers: { cookie } });
    assert.equal(after.status, 401);
  } finally {
    await s.close();
  }
});

test('security: expired sessions are refused', async () => {
  const home = tempHome();
  const secret = loadSecret(path.join(home, 'secret.key'));
  let now = 1_000_000;
  const store = new SessionStore({
    file: path.join(home, 'sessions.json'),
    secret,
    ttlMs: 1000,
    now: () => now,
  });
  const { token } = store.create({ ip: 'test' });
  assert.ok(store.verify(token));
  now += 1500;
  assert.equal(store.verify(token), null);
  assert.equal(store.size, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('security: tampered session tokens are refused', async () => {
  const home = tempHome();
  const secret = loadSecret(path.join(home, 'secret.key'));
  const store = new SessionStore({ file: path.join(home, 'sessions.json'), secret, ttlMs: 60_000 });
  const { token } = store.create({ ip: 'test' });
  const [id] = token.split('.');
  assert.equal(store.verify(`${id}.${'0'.repeat(64)}`), null);
  assert.equal(store.verify('garbage'), null);
  assert.equal(store.verify(''), null);
  fs.rmSync(home, { recursive: true, force: true });
});

test('security: pairing record never stores the plaintext code', async () => {
  const home = tempHome();
  const secret = loadSecret(path.join(home, 'secret.key'));
  const file = path.join(home, 'pairing.json');
  const code = ensurePairing(file, secret);
  const stored = fs.readFileSync(file, 'utf8');
  assert.ok(!stored.includes(code));
  assert.ok(verifyPairing(file, secret, code));
  assert.ok(verifyPairing(file, secret, code.toLowerCase().replace('-', '')));
  assert.equal(verifyPairing(file, secret, 'ZZZZ-ZZZZ'), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('security: workspace filenames reject traversal and reserved names', () => {
  const bad = ['../escape.txt', '..\\escape.txt', '/etc/passwd', 'sub/dir.txt', '.hidden', 'a\u0000b', 'CON', 'nul.txt', 'name.', 'a:b.txt'];
  for (const name of bad) {
    assert.throws(() => safeFileName(name), WorkspaceError, name);
  }
  for (const good of ['rapport.txt', 'anteckning 2026.md', 'bild-1.png']) {
    assert.equal(safeFileName(good), good);
  }
  // Trailing whitespace is trimmed rather than written to disk.
  assert.equal(safeFileName('  name  '), 'name');
});

test('security: path traversal through the API never writes outside the workspace', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await s.pair();
    const res = await postChat(s.base, cookie, { text: 'Skriv filen ../evil.txt med innehåll: pwned' });
    const raw = await res.text();
    const deltas = [...raw.matchAll(/event: delta\ndata: (.+)/g)].map((m) => JSON.parse(m[1]).text).join('');
    // The demo brain refuses before any tool call, and says so honestly.
    assert.ok(!raw.includes('"ok":true'), 'no successful tool call');
    assert.match(deltas, /Filnamnet fungerar inte/);
    assert.equal(fs.existsSync(path.join(s.home, 'evil.txt')), false);
    assert.deepEqual(fs.readdirSync(path.join(s.home, 'workspace')), []);
  } finally {
    await s.close();
  }
});

test('security: tool layer refuses traversal even if a model emits it', async () => {
  const { createToolRegistry } = await import('../../src/v4/tools.js');
  const { runTool } = await import('../../src/v2/tools/runner.js');
  const home = tempHome();
  const { registry } = createToolRegistry({
    workspaceDir: path.join(home, 'workspace'),
    memoryDir: path.join(home, 'memory'),
  });
  for (const fileName of ['../evil.txt', '..\\evil.txt', '/etc/passwd', '.majin/x', 'CON']) {
    await assert.rejects(
      () => runTool({ tool: 'workspace_write', input: { fileName, content: 'x' } }, { registry, approvals: { check: () => ({ decision: 'allow' }) } }),
      (err) => err.cls === 'PERMISSION_DENIED' || err.cls === 'INVALID_TOOL_OUTPUT',
      fileName,
    );
  }
  assert.equal(fs.existsSync(path.join(home, 'evil.txt')), false);
  assert.deepEqual(fs.readdirSync(path.join(home, 'workspace')), []);
  fs.rmSync(home, { recursive: true, force: true });
});

test('security: workspace_write never overwrites an existing file', async () => {
  const { createToolRegistry } = await import('../../src/v4/tools.js');
  const { runTool } = await import('../../src/v2/tools/runner.js');
  const home = tempHome();
  const { registry } = createToolRegistry({
    workspaceDir: path.join(home, 'workspace'),
    memoryDir: path.join(home, 'memory'),
  });
  const approvals = { check: () => ({ decision: 'allow' }) };
  const first = await runTool({ tool: 'workspace_write', input: { fileName: 'a.txt', content: 'one' } }, { registry, approvals });
  assert.equal(first.ok, true);
  await assert.rejects(
    () => runTool({ tool: 'workspace_write', input: { fileName: 'a.txt', content: 'two' } }, { registry, approvals }),
    (err) => err.cls === 'STALE_STATE',
  );
  const read = await runTool({ tool: 'workspace_read', input: { fileName: 'a.txt' } }, { registry, approvals });
  assert.equal(read.data.content, 'one');
  fs.rmSync(home, { recursive: true, force: true });
});

test('security: rate limiter is deterministic and bounded', () => {
  let now = 0;
  const limiter = new RateLimiter({ windowMs: 1000, limits: { x: 2 }, now: () => now });
  assert.equal(limiter.take('x', 'a'), 1);
  assert.equal(limiter.take('x', 'a'), 0);
  assert.throws(() => limiter.take('x', 'a'), (err) => err instanceof HttpError && err.status === 429);
  now = 1500;
  assert.equal(limiter.take('x', 'a'), 1);
});

test('security: CSRF helper rejects everything but the exact header', () => {
  assert.throws(() => assertCsrfHeader({ headers: {} }), HttpError);
  assert.throws(() => assertCsrfHeader({ headers: { 'x-majin-csrf': 'true' } }), HttpError);
  assert.doesNotThrow(() => assertCsrfHeader({ headers: { 'x-majin-csrf': '1' } }));
});

test('security: hmac and constant-time compare behave', () => {
  const secret = 'a'.repeat(64);
  assert.equal(hmac(secret, 'x'), hmac(secret, 'x'));
  assert.notEqual(hmac(secret, 'x'), hmac(secret, 'y'));
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(formatCode('abcd1234'), 'ABCD-1234');
});

test('security: CSP forbids inline script and framing', async () => {
  const s = await startTestServer();
  try {
    const res = await fetch(`${s.base}/`);
    const csp = res.headers.get('content-security-policy');
    assert.ok(csp.includes("script-src 'self'"));
    assert.ok(!csp.includes("script-src 'unsafe-inline'"));
    assert.ok(csp.includes("frame-ancestors 'none'"));
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  } finally {
    await s.close();
  }
});

test('security: static serving cannot escape the UI directory', async () => {
  const s = await startTestServer();
  try {
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2fsrc/v4/server.js']) {
      const res = await fetch(`${s.base}${p}`);
      assert.equal(res.status, 404, p);
    }
  } finally {
    await s.close();
  }
});

test('security: subdomain allowlist matches only real subdomains', () => {
  assert.equal(hostMatches('a.example.com', '*.example.com'), true);
  assert.equal(hostMatches('deep.a.example.com', '*.example.com'), true);
  assert.equal(hostMatches('example.com', '*.example.com'), false);
  assert.equal(hostMatches('evilexample.com', '*.example.com'), false);
  assert.equal(hostMatches('example.com.evil.net', '*.example.com'), false);
  assert.equal(hostMatches('majin.example.com', 'majin.example.com'), true);
  assert.equal(hostMatches('MAJIN.EXAMPLE.COM', 'majin.example.com'), true);
  assert.equal(hostMatches('other.example.com', 'majin.example.com'), false);
});
