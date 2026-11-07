/**
 * MAJIN — Slack inbound (zero-dep REST polling).
 *
 * Mirror of the Telegram-pattern: conversations.history polling of
 * explicitly configured channels only (channels.slack.channelIds = the
 * allowlist), ts-cursor persisted to disk, replies via the existing
 * send.js lane. No RTM socket, no bolt framework — fetch only.
 *
 * HONEST LIMITS in status(): the bot must be a MEMBER of each channel
 * (else history returns not_in_channel — that diagnosis is surfaced, not
 * swallowed) and polling granularity is pollSec (default 4s, Slack tier
 * limits respected; this adapter never drops below 1s).
 */
import fs from 'node:fs';
import path from 'node:path';
import { bus as globalBus } from '../log.js';
import { dirs } from '../paths.js';
import { sendSlack } from './send.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SlackChannel {
  constructor(cfg, { onMessage, bus = globalBus, fetchFn = null, autostart = true, cursorRoot = null } = {}) {
    this.cfg = cfg;
    this.onMessage = onMessage;
    this.bus = bus;
    this.fetchFn = fetchFn || ((...a) => fetch(...a));
    this.running = false;
    this.state = 'stopped';
    this.lastError = null;
    this.startedAt = null;
    this.received = 0;
    this.sent = 0;
    this.lastSeen = new Map(); // channelId -> ts (microtime string, lexicographically sortable at same length)
    this.seenTs = new Set();
    this.channelNok = new Map(); // channelId -> error string (not_in_channel etc.)
    this.autostart = autostart;
    this._firstPoll = true;
    this.cursorRoot = cursorRoot;
  }

  get token() { return this.cfg.get('channels.slack.token') || this.cfg.get('channels.slack.botToken'); }
  get channelIds() { return (this.cfg.get('channels.slack.channelIds') || []).map(String).filter(Boolean); }
  get allowedUsers() { return (this.cfg.get('channels.slack.allowedUserIds') || []).map(String); }
  get pollSec() { return Math.max(1, Number(this.cfg.get('channels.slack.pollSec') || 4)); }
  apiBase() { return (this.cfg.get('channels.slack.apiBase') || 'https://slack.com/api').replace(/\/+$/, ''); }

  api(method, body) {
    return this.fetchFn(`${this.apiBase()}/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  cursorFile() { return path.join(this.cursorRoot || dirs.workspace || process.cwd(), 'channels', 'slack-cursor.json'); }
  loadCursor() {
    try {
      const j = JSON.parse(fs.readFileSync(this.cursorFile(), 'utf8'));
      for (const [k, v] of Object.entries(j.lastSeen || {})) this.lastSeen.set(k, String(v));
    } catch { /* fresh: baseline tails newest ts */ }
  }
  saveCursor() {
    try {
      fs.mkdirSync(path.dirname(this.cursorFile()), { recursive: true });
      fs.writeFileSync(this.cursorFile(), JSON.stringify({ lastSeen: Object.fromEntries(this.lastSeen) }, null, 2));
    } catch (e) { this.bus.warn('slack.cursorSave', { error: e.message }); }
  }

  async start() {
    if (!this.token) { this.state = 'no-token'; this.lastError = 'channels.slack.token is empty'; return false; }
    if (!this.channelIds.length) { this.state = 'no-channels'; this.lastError = 'channels.slack.channelIds is empty — explicit channels only'; return false; }
    try {
      const j = await (await this.api('auth.test')).json().catch(() => ({}));
      if (!j || j.ok !== true) { this.state = 'error'; this.lastError = `auth.test: ${j?.error || 'no response'} — wrong token or network`; return false; }
      this.me = { id: j.user_id, botId: j.bot_id || null, team: j.team };
    } catch (e) { this.state = 'error'; this.lastError = e.message; return false; }
    this.loadCursor();
    this.running = true;
    this.state = 'polling';
    this.startedAt = new Date().toISOString();
    if (this.autostart) this.loop().catch((err) => { this.state = 'error'; this.lastError = err.message; this.bus.error('slack.loop', { error: err.message }); });
    this.bus.info('slack.up', { team: this.me.team, channels: this.channelIds.length });
    return true;
  }

  stop() { this.running = false; this.state = 'stopped'; this.saveCursor(); }

  async loop() {
    while (this.running) { this._pollJustDone = this.pollOnce(); await this._pollJustDone; if (this.running) await sleep(this.pollSec * 1000); }
    this.state = 'stopped';
  }

  /** Samma idé som i DiscordChannel: en svep-metod, en sanning. */
  async pollOnce() {
    const first = this._firstPoll;
    {
      for (const cid of this.channelIds) {
        try {
          const last = this.lastSeen.get(cid);
          const body = { channel: cid, limit: 100 };
          if (last) { body.oldest = last; body.inclusive = false; }
          else body.limit = 1; // tail-baseline — aldrig historik-flood
          const j = await (await this.api('conversations.history', body)).json().catch(() => ({}));
          if (!j || j.ok !== true) {
            this.channelNok.set(cid, j?.error || 'no-response');
            if (j?.error === 'not_in_channel') this.bus.warn('slack.not_in_channel', { channel: cid, hint: 'Invite the bot: /invite @<bot>' });
            this.lastError = `${cid}: ${j?.error || 'no-response'}`;
            continue;
          }
          this.channelNok.delete(cid);
          const msgs = (j.messages || []).slice().sort((a, b) => a.ts < b.ts ? -1 : 1); // history = newest-first
          for (const m of msgs) {
            this.lastSeen.set(cid, m.ts);
            const key = `${m.ts}`;
            if (this.seenTs.has(key)) continue;
            this.seenTs.add(key);
            if (this.seenTs.size > 500) this.seenTs = new Set([...this.seenTs].slice(-250));
            if (first && !last) continue;
            await this.handle(cid, m);
          }
          this.saveCursor();
          this.lastError = null;
        } catch (err) {
          this.lastError = err.message;
          this.bus.warn('slack.poll', { channel: cid, error: err.message });
        }
        await sleep(250);
      }
    }
    this._firstPoll = false;
  }

  async handle(channelId, m) {
    if (m.bot_id || m.subtype === 'bot_message') return; // loop-skydd
    if (this.me && String(m.user) === String(this.me.id)) return;
    if (m.subtype && !['thread_broadcast'].includes(m.subtype)) return; // joins/leaves = inga agent-turns
    const uid = String(m.user || '');
    if (this.allowedUsers.length && !this.allowedUsers.includes(uid)) return;
    const text = String(m.text ?? '').trim();
    if (!text) return;
    this.received += 1;
    await this.onMessage?.({
      channel: 'slack', chatId: String(channelId),
      from: uid, text,
      reply: async (t) => {
        const r = await sendSlack(this.cfg, { channel: channelId, text: String(t) }, this.fetchFn);
        if (r.ok) this.sent += 1;
        return r.ok;
      },
      meta: { ts: m.ts, threadTs: m.thread_ts || m.ts },
    });
  }

  status() {
    return {
      state: this.state, running: this.running,
      channels: this.channelIds.length, team: this.me?.team || null,
      received: this.received, sent: this.sent,
      channelIssues: Object.fromEntries(this.channelNok),
      lastError: this.lastError, startedAt: this.startedAt,
      notes: 'REST-poll — bot must be invited into each channel (not_in_channel is surfaced honestly)',
    };
  }
}
