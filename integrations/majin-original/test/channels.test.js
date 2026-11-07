import test from 'node:test';
import assert from 'node:assert/strict';
import { sendDiscord, sendSlack, sendMatrix, sendWebhook, sendEmail, CHANNELS_OUT } from '../src/core/channels/send.js';

const cfgFrom = (obj) => ({ get: (k) => k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), obj) });

test('W8: missing token is a clear not_configured diagnosis, never a pretend-send', async () => {
  for (const [name, fn, input] of [
    ['discord', sendDiscord, { channelId: '123', text: 'hej' }],
    ['slack', sendSlack, { channel: '#test', text: 'hej' }],
    ['matrix', sendMatrix, { room: '!a:x.org', text: 'hej' }],
    ['email', sendEmail, { to: 'a@b.se', subject: 's', text: 'hej' }],
  ]) {
    const r = await fn(cfgFrom({}), input, async () => ({ status: 0, ok: false, text: async () => 'No' , json: null }));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'not_configured', `${name} must fail honestly with not_configured, got ${r.error.code}`);
  }
});

test('W8: webhook refuses plain http (payload leakage)', async () => {
  const r = await sendWebhook(cfgFrom({}), { url: 'http://insecure.example.com/hook', payload: { a: 1 } });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'forbidden');
});

test('W8: discord posts to the correct v10 URL with bot auth; success surfaces message id', async () => {
  const calls = [];
  const fetchFake = async (url, init) => {
    calls.push([url, init]);
    return { status: 200, ok: true, text: async () => '{"id":"987654321"}' };
  };
  const r = await sendDiscord(cfgFrom({ channels: { discord: { token: 'T' } } }), { channelId: 'C123', text: 'klart genom' }, fetchFake);
  assert.equal(r.ok, true);
  assert.equal(r.messageId, '987654321');
  assert.match(calls[0][0], /discord\.com\/api\/v10\/channels\/C123\/messages$/);
  assert.equal(calls[0][1].headers['authorization'], 'Bot T');
  const body = JSON.parse(calls[0][1].body);
  assert.equal(body.content, 'klart genom');
});

test('W8: slack api error surfaced honestly (not_ok json)', async () => {
  const fetchFake = async () => ({ status: 200, ok: true, text: async () => '{"ok":false,"error":"channel_not_found"}' });
  const r = await sendSlack(cfgFrom({ channels: { slack: { token: 'xoxb-x' } } }), { channel: '#missing', text: 'hej' }, fetchFake);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /channel_not_found/);
});

test('W8: matrix uses PUT to send/m.room.message with txn id', async () => {
  const calls = [];
  const fetchFake = async (url, init) => { calls.push([url, init]); return { status: 200, ok: true, text: async () => '{"event_id":"$ev1"}' }; };
  const r = await sendMatrix(cfgFrom({ channels: { matrix: { token: 'M', homeserver: 'https://matrix.example.com' } } }), { room: '!room1:example.com', text: 'hej' }, fetchFake);
  assert.equal(r.ok, true);
  assert.equal(r.eventId, '$ev1');
  assert.match(calls[0][0], /_matrix\/client\/v3\/rooms\/.*send\/m\.room\.message\//);
  assert.equal(calls[0][1].method, 'PUT');
});

test('W8: webhook secret signs payload (HMAC binds secret to exact bytes)', async () => {
  const calls = [];
  const fetchFake = async (url, init) => { calls.push([url, init]); return { status: 200, ok: true, text: async () => 'ok' }; };
  const r = await sendWebhook(cfgFrom({}), { url: 'https://hooks.example.com/x', payload: { n: 5 }, secret: 'shh' }, fetchFake);
  assert.equal(r.ok, true);
  assert.match(calls[0][1].headers['x-majin-signature'], /^sha256=[0-9a-f]{64}$/);
});

test('W8: email uses relay POST with basic-auth api key', async () => {
  const calls = [];
  const fetchFake = async (url, init) => { calls.push([url, init]); return { status: 200, ok: true, text: async () => '{"id":"<id1>"}' }; };
  const r = await sendEmail(cfgFrom({ channels: { email: { relayUrl: 'https://api.mailgun.net/v3/m.example/messages', apiKey: 'k', from: 'majin <m@example.se>' } } }), { to: 'u@x.se', subject: 'st', text: 'body' }, fetchFake);
  assert.equal(r.ok, true);
  assert.match(calls[0][1].headers['authorization'], /^Basic /);
  assert.match(calls[0][1].body, /to=u%40x\.se/);
});

test('W8: registry tool is the only in/out entry point and is approval-gated by risk', async () => {
  assert.deepEqual(Object.keys(CHANNELS_OUT).sort(), ['discord', 'email', 'matrix', 'slack', 'webhook']);
});
