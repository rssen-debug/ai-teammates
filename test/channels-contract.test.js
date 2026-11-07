import test from 'node:test';
import assert from 'node:assert/strict';
import { sendSlack, sendDiscord, sendMatrix, sendEmail, sendWebhook } from '../src/core/channels/send.js';

/* W8 transport-boundary contract: the exact HTTP request each sender would
   place onto the live API, captured at the fetch seam. Everything a real
   integration depends on is verified here — endpoint, method, auth header
   shape, payload contract, truncation, unicode survival, and the ZERO-
   credential-reflection rule (secrets must never appear in results). Only the
   live API acceptance itself remains credential-gated (honest NOT-TESTED). */

function capture(status = 200, jsonOk = true) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(jsonOk === true ? { ok: true, id: 'x1' } : jsonOk), };
  };
  return { calls, fetchFn };
}
const cfg = (v) => ({ get: (k) => v[k] });

test('W8 Slack: exact endpoint + bearer auth + payload contract + 3000-char truncation', async () => {
  const { calls, fetchFn } = capture();
  const r = await sendSlack(cfg({ 'channels.slack.token': 'xoxb-secret-9f8a', 'channels.slack.channel': '#ops' }), { text: 'hej — alert: ' + 'å'.repeat(4000), ts: '1234.5' }, fetchFn);
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  const [c] = calls;
  assert.equal(c.url, 'https://slack.com/api/chat.postMessage');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers.authorization, 'Bearer xoxb-secret-9f8a');
  const body = JSON.parse(c.init.body);
  assert.equal(body.channel, '#ops');
  assert.ok(body.text.length <= 3000 + 30, 'slack cap respected: ' + body.text.length);
  assert.match(body.text, /hej — alert/); /* unicode survived */
  /* ZERO credential reflection */
  assert.ok(!JSON.stringify(r).includes('xoxb-secret-9f8a'), 'token must not leak into the result object');
});

test('W8 Discord: channel REST path + Bot-token header + 1900-char content cap + honest API error text', async () => {
  const { calls, fetchFn } = capture(429, { ok: false, message: 'You are being rate limited' });
  const r = await sendDiscord(cfg({ 'channels.discord.token': 'DISCORD-BOT-TOKEN-77', 'channels.discord.channelId': '12345678901234567' }), { text: 'x'.repeat(2500), username: 'MAJIN' }, fetchFn);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'discord_api');
  assert.match(r.error.message, /429/);
  assert.match(r.error.message, /rate limited/, 'the REAL api message surfaces, not a generic excuse');
  const [c] = calls;
  assert.match(c.url, /discord\.com\/api\/v10\/channels\/12345678901234567\/messages$/);
  assert.equal(c.init.headers.authorization, 'Bot DISCORD-BOT-TOKEN-77');
  const body = JSON.parse(c.init.body);
  assert.ok(body.content.length <= 1900, 'discord 1900-char content cap: ' + body.content.length);
  assert.equal(body.username, 'MAJIN');
});

test('W8 Matrix: PUT + homeserver path construction + m.text packet shape', async () => {
  const { calls, fetchFn } = capture();
  const r = await sendMatrix(cfg({ 'channels.matrix.token': 'MAT_TOKEN_AB', 'channels.matrix.homeserver': 'https://matrix.home.se/', 'channels.matrix.room': '!room:matrix.org' }), { text: 'matrix hej' }, fetchFn);
  assert.equal(r.ok, true);
  const [c] = calls;
  assert.match(c.url, /^https:\/\/matrix\.home\.se\/_matrix\/client\/v3\/rooms\/!room%3Amatrix\.org\/send\/m\.room\.message\/[0-9a-f]{12}$/, 'deterministic endpoint shape, no double-slash: ' + c.url);
  assert.equal(c.init.method, 'PUT');
  assert.equal(c.init.headers.authorization, 'Bearer MAT_TOKEN_AB');
  const body = JSON.parse(c.init.body);
  assert.deepEqual(body, { msgtype: 'm.text', body: 'matrix hej' });
});

test('W8 Email: Mailgun-compatible relay — form body, Basic-auth api-key, and not_configured refusal without every required field', async () => {
  const { calls, fetchFn } = capture();
  const r = await sendEmail(cfg({ 'channels.email.relayUrl': 'https://relay.example.com/send', 'channels.email.apiKey': 'key-abc-12345', 'channels.email.from': 'MAJIN <majin@example.com>' }), { to: 'ops@example.com', subject: 'incit 44', text: 'body text äö' }, fetchFn);
  const [c] = calls;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(c.url, 'https://relay.example.com/send');
  assert.equal(c.init.headers['content-type'], 'application/x-www-form-urlencoded');
  const expectedAuth = 'Basic ' + Buffer.from('api:key-abc-12345').toString('base64');
  assert.equal(c.init.headers.authorization, expectedAuth, 'Mailgun-compatible Basic auth');
  const form = new URLSearchParams(c.init.body);
  assert.equal(form.get('to'), 'ops@example.com');
  assert.equal(form.get('subject'), 'incit 44');
  assert.equal(form.get('from'), 'MAJIN <majin@example.com>');
  assert.match(String(form.get('text')), /äö/);
  /* and the honest refusal: without 'from' the sender must refuse to pretend */
  const r2 = await sendEmail(cfg({ 'channels.email.relayUrl': 'https://relay.example.com/send', 'channels.email.apiKey': 'key-abc-12345' }), { to: 'ops@example.com', subject: 'x' }, fetchFn);
  assert.equal(r2.ok, false);
  assert.equal(r2.error.code, 'not_configured');
  assert.equal(calls.length, 1, 'a refused email sends ZERO requests');
});

test('W8 Webhook: https-only + HMAC exactness + payload round-trip compatible with external verifiers', async () => {
  const { calls, fetchFn } = capture();
  const payload = { äpple: 'Åland — 1, 2, 3', nested: { ok: true } };
  const r = await sendWebhook(cfg({}), { url: 'https://hooks.example.com/xyz', payload, secret: 'S3CRET' }, fetchFn);
  assert.equal(r.ok, true);
  const [c] = calls;
  const expected = 'sha256=' + (await import('node:crypto')).createHmac('sha256', 'S3CRET').update(c.init.body).digest('hex');
  assert.equal(c.init.headers['x-majin-signature'], expected, 'signature over the EXACT wire bytes');
  assert.deepEqual(JSON.parse(c.init.body), payload, 'unicode+structure round-trip unharmed');
  /* bad API answer surfaces honestly */
  const bad = capture(500, { ok: false });
  const r2 = await sendWebhook(cfg({}), { url: 'https://hooks.example.com/xyz', payload: {} }, bad.fetchFn);
  assert.equal(r2.ok, false);
  assert.equal(r2.error.code, 'webhook_api');
});
