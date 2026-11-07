import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DiscordChannel } from '../src/core/channels/discord.js';
import { SlackChannel } from '../src/core/channels/slack.js';
import { MatrixChannel } from '../src/core/channels/matrix.js';

const wsd = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chan-ws-'));

const cfgOf = (map) => ({ get: (k) => map[k], patch: () => ({ ok: true }) });

const busStub = () => {
  const warnings = []; const infos = []; const errors = [];
  return {
    warnings, infos, errors,
    warn: (t, m) => warnings.push([t, m]),
    info: (t, m) => infos.push([t, m]),
    error: (t, m) => errors.push([t, m]),
    on: () => () => {},
  };
};

/** fetchFn-mock: svarar via URL/kropp-matcher; loggar alla anrop för assertions. */
const mockFetch = (routes) => {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ url: String(url), method, body: opts.body ? JSON.parse(opts.body) : null });
    for (const [match, respond] of routes) {
      if (typeof match === 'string' ? String(url).includes(match) : match.method === method && String(url).includes(match.contains)) {
        const r = respond(calls[calls.length - 1]);
        /* ok-speglar send/post-semantiken: ett svar UTAN status är ett lyckat
           200 — aldrig ok:false av tystnad (det maskerade sig som "adapter
           puschar inte" när det var mocken som ljög om nätverket). */
        const status = r.status ?? 200;
        return { ok: status < 400, status, json: async () => r.json, text: async () => JSON.stringify(r.json ?? '') };
      }
    }
    return { ok: false, status: 404, json: async () => ({ error: 'no-route' }), text: async () => 'no-route' };
  };
  return { fetchFn, calls };
};

/* ============================ DISCORD ============================ */

test('W8 discord: start → tail-baseline hoppar över gammalt, nytt meddelande leder till agent-turn, reply postas', async () => {
  const dir = wsd();
  const msgsOld = [{ id: '900', content: 'old why', author: { id: 'u2', username: 'frida', bot: false } }];
  const msgsNew = [{ id: '901', content: 'build failing — why?', author: { id: 'u2', username: 'frida', bot: false } }];
  let phase = 0;
  const { fetchFn, calls } = mockFetch([
    [{ contains: '/users/@me', method: 'GET' }, () => ({ json: { id: 'b1', username: 'majin-bot' } })],
    [{ contains: '/channels/C1/messages', method: 'GET' }, () => ({ json: phase === 0 ? msgsOld : msgsNew })],
    [{ contains: '/channels/C1/messages', method: 'POST' }, () => ({ json: { id: '999' } })],
  ]);
  const got = []; const bus = busStub();
  const ch = new DiscordChannel(cfgOf({ 'channels.discord.token': 't', 'channels.discord.channelIds': ['C1'] }), {
    fetchFn, bus, autostart: false, cursorRoot: dir,
    onMessage: (m) => { got.push(m); return Promise.resolve(); },
  });
  assert.equal(await ch.start(), true);
  await ch.pollOnce(); // baseline: gammalt meddelande räknas INTE
  assert.equal(got.length, 0, 'base poll tailar, inte floodar historik');
  phase = 1;
  await ch.pollOnce();
  assert.equal(got.length, 1);
  assert.equal(got[0].channel, 'discord');
  assert.equal(got[0].chatId, 'C1');
  assert.match(got[0].text, /build failing/);
  await got[0].reply('kollade: saknar env-variabel');
  const posted = calls.find((c) => c.method === 'POST' && c.url.includes('/channels/C1/messages'));
  assert.ok(posted, 'reply gick faktiskt ut');
  assert.match(posted.body.content, /env-variabel/);
  // dedupe: samma poll igen = 0 nya
  await ch.pollOnce();
  assert.equal(got.length, 1, 'dedupe fångar om-poll');
  ch.stop();
  const st = ch.status();
  assert.equal(st.received, 1);
  assert.equal(st.sent, 1);
  assert.match(st.notes, /Message Content/);
});

test('W8 discord: egna/bot-meddelanden hoppar (loop-guard) + tom content = ärlig warn om Missing Intent', async () => {
  const dir = wsd();
  const payload = [
    { id: '800', content: 'self', author: { id: 'b1', username: 'majin-bot', bot: true } },
    { id: '801', content: 'other bot', author: { id: 'b2', username: 'github[bot]', bot: true } },
    { id: '802', author: { id: 'u3', username: 'joel', bot: false } }, // tom content — intent-signal!
    { id: '803', content: 'hej', author: { id: 'u3', username: 'joel', bot: false } },
  ];
  const { fetchFn } = mockFetch([
    [{ contains: '/users/@me', method: 'GET' }, () => ({ json: { id: 'b1', username: 'majin-bot' } })],
    [{ contains: '/channels/C1/messages', method: 'GET' }, () => ({ json: payload })],
  ]);
  const got = []; const bus = busStub();
  const ch = new DiscordChannel(cfgOf({ 'channels.discord.token': 't', 'channels.discord.channelIds': ['C1'] }), {
    fetchFn, bus, autostart: false, cursorRoot: wsd(), onMessage: (m) => void got.push(m),
  });
  await ch.start();
  ch._firstPoll = false; // simulera steady-state
  await ch.pollOnce();
  assert.equal(got.length, 1, 'endast vanligt användarmeddelande');
  assert.equal(got[0].from, 'joel');
  assert.ok(bus.warnings.some(([t]) => t === 'discord.empty-content'), 'tom content → bus-warn om Message Content intent (never-stuck-diagnos)');
  ch.stop();
});

test('W8 discord: utan token/kanaler = ärlig no-token/no-channels-status, start returnerar false', async () => {
  const bus = busStub();
  const ch = new DiscordChannel(cfgOf({}), { bus, autostart: false });
  assert.equal(await ch.start(), false);
  assert.equal(ch.status().state, 'no-token');
  const ch2 = new DiscordChannel(cfgOf({ 'channels.discord.token': 't' }), { bus: busStub(), autostart: false });
  assert.equal(await ch2.start(), false);
  assert.match(ch2.status().lastError, /channelIds/);
});

/* ============================ SLACK ============================ */

test('W8 slack: auth.test → history tail → agent-turn + reply; not_in_channel reser sig ÄRLIGT i status', async () => {
  const dir = wsd();
  let phase = 0;
  const { fetchFn, calls } = mockFetch([
    ['auth.test', () => ({ json: { ok: true, user_id: 'UBOT', bot_id: 'BBOT', team: 'T9' } })],
    ['conversations.history', (c) => {
      if (c.body.channel === 'CBAD') return { json: { ok: false, error: 'not_in_channel' } };
      if (phase === 0) return { json: { ok: true, messages: [{ ts: '1700.0009', user: 'U5', text: 'old' }] } };
      return { json: { ok: true, messages: [{ ts: '1700.0011', user: 'U5', text: 'W8 receive-verify?' }] } };
    }],
    ['chat.postMessage', () => ({ json: { ok: true, ts: '1700.0100' } })],
  ]);
  const got = []; const bus = busStub();
  const cfg = cfgOf({ 'channels.slack.token': 'xoxb-t', 'channels.slack.channelIds': ['CGOOD', 'CBAD'] });
  const ch = new SlackChannel(cfg, { fetchFn, bus, autostart: false, cursorRoot: dir, onMessage: (m) => void got.push(m) });
  assert.equal(await ch.start(), true);
  await ch.pollOnce(); // baseline tail
  assert.equal(got.length, 0);
  assert.ok(bus.warnings.some(([t]) => t === 'slack.not_in_channel'), 'not_in_channel diagnostiseras');
  phase = 1;
  await ch.pollOnce();
  assert.equal(got.length, 1);
  assert.equal(got[0].channel, 'slack');
  assert.match(got[0].text, /receive-verify/);
  const historyCalls = calls.filter((c) => c.url.includes('conversations.history') && c.body.channel === 'CGOOD');
  const aged = historyCalls.find((c) => c.body.oldest);
  assert.ok(aged && aged.body.inclusive === false, 'cursor-anrop använder oldest+inclusive=false (aldrig samma ts dubbelt)');
  await got[0].reply('verifierat!');
  assert.ok(calls.some((c) => c.url.includes('chat.postMessage') && /verifierat!/.test(c.body.text)));
  ch.stop();
  const st = ch.status();
  assert.equal(st.received, 1);
  assert.deepEqual(st.channelIssues, { CBAD: 'not_in_channel' });
});

test('W8 slack: bot/egna/JOIN-subtype-meddelanden tas aldrig till agenten', async () => {
  const dir = wsd();
  const { fetchFn } = mockFetch([
    ['auth.test', () => ({ json: { ok: true, user_id: 'UBOT', team: 'T' } })],
    ['conversations.history', () => ({ json: { ok: true, messages: [
      { ts: '2.0', bot_id: 'BK1', text: 'other bot' },
      { ts: '2.1', user: 'UBOT', text: 'self message' },
      { ts: '2.2', subtype: 'channel_join', text: 'joel joined' },
      { ts: '2.3', subtype: 'message_deleted', text: '' },
      { ts: '2.4', user: 'U9', text: 'real human' },
    ] } })],
  ]);
  const got = [];
  const ch = new SlackChannel(cfgOf({ 'channels.slack.token': 't', 'channels.slack.channelIds': ['C'] }), { fetchFn, bus: busStub(), autostart: false, cursorRoot: wsd(), onMessage: (m) => void got.push(m) });
  await ch.start();
  ch._firstPoll = false;
  await ch.pollOnce();
  assert.equal(got.length, 1);
  assert.equal(got[0].from, 'U9');
  ch.stop();
});

/* ============================ MATRIX ============================ */

test('W8 matrix: whoami → baseline-filter(limit:0) → /sync seitane → m.text till agent; egen + encrypted ärligt räknade/skippade; cursor persisterar', async () => {
  const dir = wsd();
  let phase = 0;
  const { fetchFn, calls } = mockFetch([
    ['whoami', () => ({ json: { user_id: '@majin:mock' } })],
    ['_matrix/client/v3/sync', (c) => {
      if (phase === 0) {
        return { json: { next_batch: 's1', rooms: { join: { '!room1:mock': { timeline: { events: [] } } } } } };
      }
      return { json: {
        next_batch: 's2',
        rooms: { join: { '!room1:mock': { timeline: { events: [
          { event_id: '$e1', sender: '@majin:mock', type: 'm.room.message', content: { msgtype: 'm.text', body: 'self-echo (skip)' } },
          { event_id: '$e2', sender: '@friend:mock', type: 'm.room.encrypted', content: {} },
          { event_id: '$e3', sender: '@friend:mock', type: 'm.room.message', content: { msgtype: 'm.notice', body: 'notice (skip)' } },
          { event_id: '$e4', sender: '@friend:mock', type: 'm.room.message', content: { msgtype: 'm.text', body: 'W8 matrix inbound proof' } },
        ] } } } },
      } };
    }],
    ['/send/m.room.message/', () => ({ json: { event_id: '$r1' } })],
  ]);
  const got = [];
  const ch = new MatrixChannel(cfgOf({
    'channels.matrix.homeserver': 'http://mock', 'channels.matrix.accessToken': 'tok', 'channels.matrix.token': 'tok', 'channels.matrix.roomIds': ['!room1:mock'],
  }), { fetchFn, bus: busStub(), autostart: false, cursorRoot: dir, onMessage: (m) => void got.push(m) });
  assert.equal(await ch.start(), true);
  await ch.pollOnce();
  assert.equal(got.length, 0, 'baseline synkar bara since-token');
  const baselineCall = calls.find((c) => c.url.includes('/sync'));
  assert.ok(decodeURIComponent(baselineCall.url).includes('"limit":0'), 'baseline skickar limit:0-filter (aldrig backlog-flood)');
  phase = 1;
  await ch.pollOnce();
  assert.equal(got.length, 1);
  assert.equal(got[0].channel, 'matrix');
  assert.match(got[0].text, /matrix inbound proof/);
  await got[0].reply('fick den!');
  const sendCall = calls.find((c) => c.url.includes('/send/m.room.message'));
  assert.ok(sendCall && sendCall.method === 'PUT');
  const st = ch.status();
  assert.equal(st.received, 1);
  assert.equal(st.skippedEncrypted, 1, 'krypterade räknas ärligt, aldrig dekrypteras-felaktigt');
  const syncCalls = calls.filter((c) => c.url.includes('/sync'));
  assert.ok(syncCalls.some((c) => c.url.includes('since=s1')), 'andra synken bär since=s1-cursor');
  ch.stop();
  // persistens: ny instans ska läsa cursor från disk (s1→s2 sparat)
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'channels', 'matrix-cursor.json'), 'utf8'));
  assert.equal(file.since, 's2');
});

test('W8 matrix: utan homeserver = ärlig no-homeserver-status', async () => {
  const ch = new MatrixChannel(cfgOf({ 'channels.matrix.accessToken': 'x' }), { bus: busStub(), autostart: false });
  assert.equal(await ch.start(), false);
  assert.equal(ch.status().state, 'no-homeserver');
});
