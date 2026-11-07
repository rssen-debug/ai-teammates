/**
 * MAJIN W8 outbound messaging — Discord / Slack / Matrix / Email / generic Webhook.
 * Live wire through official REST APIs. No transport mocking: fetchFn is
 * injectable purely for offline tests; production uses global fetch.
 * Missing credentials NEVER pretend to send — clear not_configured codes.
 */
import crypto from 'node:crypto';

const UA = 'MAJIN/1.0 channels-out (+self-hosted assistant)';

async function post(fetchFn, url, { headers = {}, body, method = 'POST', timeoutMs = 15000 }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error(`network timeout after ${timeoutMs / 1000}s — retry with a longer window`)), timeoutMs);
  t.unref?.();
  try {
    const res = await fetchFn(url, {
      method,
      signal: ctrl.signal,
      headers: { 'user-agent': UA, 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = JSON.parse(text); } catch { /* plain-text response is fine */ }
    return { status: res.status, ok: res.ok, json, text: text.slice(0, 500) };
  } finally {
    clearTimeout(t);
  }
}

function s(v, n = 5000) { return String(v ?? '').slice(0, n); }

export const sendDiscord = async (cfg, { channelId, text, username = null, embeds = null }, fetchFn = fetch) => {
  const token = cfg.get('channels.discord.token');
  const id = s(channelId || cfg.get('channels.discord.channelId') || '', 64);
  if (!token) return { ok: false, error: { code: 'not_configured', message: 'channels.discord.token missing — set it in majin config or env, then retry (nothing was sent)' } };
  if (!id) return { ok: false, error: { code: 'not_configured', message: 'Discord channel id missing (target or channels.discord.channelId)' } };
  const body = { content: s(text, 1900) || 'MAJIN: (empty message body — note: Discord ignores empty messages)' };
  if (username) body.username = s(username, 80);
  if (embeds) body.embeds = embeds;
  const r = await post(fetchFn, `https://discord.com/api/v10/channels/${encodeURIComponent(id)}/messages`, { headers: { authorization: `Bot ${token}` }, body });
  if (!r.ok) return { ok: false, error: { code: 'discord_api', message: `Discord ${r.status}: ${s(r.json?.message || r.text, 200)}` } };
  return { ok: true, messageId: r.json?.id || null, status: r.status };
};

export const sendSlack = async (cfg, { channel, text, threadTs = null, blocks = null }, fetchFn = fetch) => {
  const token = cfg.get('channels.slack.token');
  const to = s(channel || cfg.get('channels.slack.channel') || '', 80);
  if (!token) return { ok: false, error: { code: 'not_configured', message: 'channels.slack.token (xoxb-...) missing — nothing was sent' } };
  if (!to) return { ok: false, error: { code: 'not_configured', message: 'Slack channel missing (e.g. #general or C0123ABC)' } };
  const body = { channel: to, text: s(text, 3000) };
  if (threadTs) body.thread_ts = threadTs;
  if (blocks) body.blocks = blocks;
  const r = await post(fetchFn, 'https://slack.com/api/chat.postMessage', { headers: { authorization: `Bearer ${token}` }, body });
  if (!r.ok || r.json?.ok === false) return { ok: false, error: { code: 'slack_api', message: `Slack: ${s(r.json?.error || r.text, 200)}` } };
  return { ok: true, ts: r.json?.ts || null, status: r.status };
};

export const sendMatrix = async (cfg, { room, text, homeserver = null }, fetchFn = fetch) => {
  const token = cfg.get('channels.matrix.token');
  const hs = s(homeserver || cfg.get('channels.matrix.homeserver') || '', 120);
  const roomId = s(room || cfg.get('channels.matrix.room') || '', 120);
  if (!token || !hs) return { ok: false, error: { code: 'not_configured', message: 'channels.matrix.token + .homeserver required — nothing was sent' } };
  if (!roomId) return { ok: false, error: { code: 'not_configured', message: 'Matrix room id missing (e.g. !abc:matrix.org)' } };
  const txn = crypto.randomBytes(6).toString('hex');
  const r = await post(fetchFn, `${hs.replace(/\/$/, '')}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}` },
    body: { msgtype: 'm.text', body: s(text, 8000) },
  });
  if (!r.ok) return { ok: false, error: { code: 'matrix_api', message: `Matrix ${r.status}: ${s(r.json?.error || r.text, 200)}` } };
  return { ok: true, eventId: r.json?.event_id || null, status: r.status };
};

/* STRING-LEVEL canonical check — deliberately NOT new URL(url).hostname,
   because the WHATWG host parser NORMALIZES 127.1, 2130706433, zero-padded
   octets into 127.0.0.1 and would thus launder obfuscated forms through us.
   Only to-the-letter canonical loopback passes; credentials (@), integer
   encodings, netmask shorthands, IPv4-mapped IPv6 and typo-domains all fail. */
export function isLoopbackUrl(url) {
  return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?(\/|$)/i.test(String(url || ''));
}

export const sendWebhook = async (cfg, { url, payload = {}, headersExtra = {}, secret = null }, fetchFn = fetch) => {
  /* http is forbidden — EXCEPT loopback: an attacker cannot route 127.0.0.1
     elsewhere, and local bots/receivers (our own integration tests, Home
     Assistant etc.) live there. Everything else stays https-only. */
  const httpsOk = /^https:\/\//.test(url || '');
  const loopOk = /^http:\/\//.test(url || '') && isLoopbackUrl(url);
  if (!httpsOk && !loopOk) return { ok: false, error: { code: 'forbidden', message: 'Webhook-URL must be https:// — http only for loopback receivers (127.0.0.1/localhost/[::1]); posting payloads over plain http to the open network is forbidden' } };
  const bodyStr = JSON.stringify(payload ?? {});
  const headers = { ...headersExtra };
  if (secret) headers['x-majin-signature'] = 'sha256=' + crypto.createHmac('sha256', String(secret)).update(bodyStr).digest('hex');
  const r = await post(fetchFn, url, { headers, body: bodyStr });
  if (!r.ok) return { ok: false, error: { code: 'webhook_api', message: `Webhook ${r.status}: ${s(r.text, 200)}` } };
  return { ok: true, status: r.status };
};

/* Email: zero-dep approach — via a configured relay-compatible service is out
   of scope here; SMTP without a dependency would mean hand-rolled TLS-auth
   state machine (security hazard). Honest stance: provider-API path via
   Mailgun-compatible relay when channels.email.relayUrl is set. */
export const sendEmail = async (cfg, { to, subject, text }, fetchFn = fetch) => {
  const relay = s(cfg.get('channels.email.relayUrl') || '', 200);
  const key = cfg.get('channels.email.apiKey');
  const from = s(cfg.get('channels.email.from') || '', 200);
  if (!relay || !key || !from) {
    return { ok: false, error: { code: 'not_configured', message: 'channels.email.relayUrl + apiKey + from required (provider-API relay: Mailgun/Postmark-compatible v3 endpoint) — SMTP: deliberately not hand-rolled without a vetted dependency' } };
  }
  if (!to || !subject) return { ok: false, error: { code: 'bad_input', message: 'email requires to + subject' } };
  const params = new URLSearchParams({ from, to: s(to, 200), subject: s(subject, 500), text: s(text, 20000) });
  const r = await post(fetchFn, relay, {
    method: 'POST',
    headers: { authorization: 'Basic ' + Buffer.from(`api:${key}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!r.ok) return { ok: false, error: { code: 'email_api', message: `Email relay ${r.status}: ${s(r.text, 200)}` } };
  return { ok: true, id: r.json?.id || null, status: r.status };
};

export const CHANNELS_OUT = { discord: sendDiscord, slack: sendSlack, matrix: sendMatrix, webhook: sendWebhook, email: sendEmail };
