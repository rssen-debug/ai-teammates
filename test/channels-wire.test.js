import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { sendWebhook, isLoopbackUrl } from '../src/core/channels/send.js';

const cfgFrom = () => ({ get: () => undefined });

function receiver({ respond = 200 } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, raw });
      res.writeHead(respond, { 'content-type': 'application/json' });
      res.end(respond === 200 ? '{"ok":true}' : '{"ok":false,"err":"nope"}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

test('W8 wire: HMAC signature over a REAL socket validates byte-for-byte on the receiver side', async () => {
  const { server, seen, port } = await receiver();
  const payload = { task: 'nightly', ok: true, steps: 12 };
  const r = await sendWebhook(cfgFrom(), { url: `http://127.0.0.1:${port}/hook`, payload, secret: 'topsecret' });
  await new Promise((res) => server.close(res));
  assert.equal(r.ok, true, 'real socket must accept: ' + JSON.stringify(r));
  assert.equal(seen.length, 1);
  const got = seen[0];
  /* receiver recomputes the MAC over the RAW bytes — the exact contract any
     webhook consumer (GitHub, Stripe) enforces; header without MAC-matching
     body would be worthless */
  const expect = 'sha256=' + crypto.createHmac('sha256', 'topsecret').update(got.raw).digest('hex');
  assert.equal(got.headers['x-majin-signature'], expect);
  assert.deepEqual(JSON.parse(got.raw), payload);
  assert.match(got.headers['user-agent'], /^MAJIN\//);
});

test('W8 wire: loopback exception is precise — domain names that only LOOK loopback stay forbidden', () => {
  assert.equal(isLoopbackUrl('http://127.0.0.1:8080/x'), true);
  assert.equal(isLoopbackUrl('http://localhost:3000'), true);
  assert.equal(isLoopbackUrl('http://[::1]:9000'), true);
  assert.equal(isLoopbackUrl('http://127.0.0.1.evil.tld/x'), false, 'DNS trick must not pass');
  assert.equal(isLoopbackUrl('http://127.1/x'), false, 'netmask shorthand must not pass');
  assert.equal(isLoopbackUrl('http://2130706433/x'), false, 'integer-encoded 127.0.0.1 must not pass');
  assert.equal(isLoopbackUrl('http://[::ffff:127.0.0.1]/x'), false, 'IPv4-mapped IPv6 stays forbidden (conservative, documented)');
});

test('W8 wire: non-2xx from a REAL receiver surfaces as honest error (no swallow)', async () => {
  const { server, port } = await receiver({ respond: 403 });
  const r = await sendWebhook(cfgFrom(), { url: `http://127.0.0.1:${port}/x`, payload: { t: 1 } });
  await new Promise((res) => server.close(res));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'webhook_api');
  assert.match(r.error.message, /403/);
});

test('W8 wire: plain http to an external host still refused — the exception did not leak', async () => {
  const r = await sendWebhook(cfgFrom(), { url: 'http://example.com/hook', payload: {} });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'forbidden');
});
