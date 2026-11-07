/**
 * MAJIN — Discord inbound (zero-dep REST polling).
 *
 * Deliberately mirrors the Telegram adapter shape (long-poll → cursor →
 * onMessage) instead of pulling a 700-file gateway SDK: guild bots can read
 * channel history via REST, which needs only fetch. No websocket, no public
 * webhook, no new dependency.
 *
 * HONEST LIMITS (surfaced in status(), never hidden):
 *  - Reading message CONTENT requires the bot's "Message Content" privileged
 *    gateway intent enabled in the Dev Portal — otherwise events arrive with
 *    empty content and we say so.
 *  - This adapter polls explicitly CONFIGURED channels only
 *    (channels.discord.channelIds) — that list IS the allowlist.
 *  - REST polling is not real time: pollSec floor 3s by default, Discord
 *    buckets rate-limit channel reads — never hammered below 1s.
 */
import fs from 'node:fs';
import path from 'node:path';
import { bus as globalBus } from '../log.js';
import { dirs } from '../paths.js';
import { sendDiscord } from './send.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class DiscordChannel {
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
    this.lastSeen = new Map(); // channelId -> last message id (snowflake, string-compare ok)
    this.seenIds = new Set();  // rolling dedupe window
    this.autostart = autostart;
    this._firstPoll = true;
    this.cursorRoot = cursorRoot;
  }

  get token() { return this.cfg.get('channels.discord.token') || this.cfg.get('channels.discord.botToken'); }
  get channelIds() { return (this.cfg.get('channels.discord.channelIds') || []).map(String).filter(Boolean); }
  get allowedUsers() { return (this.cfg.get('channels.discord.allowedUserIds') || []).map(String); }
  get pollSec() { return Math.max(1, Number(this.cfg.get('channels.discord.pollSec') || 5)); }
  apiBase() { return (this.cfg.get('channels.discord.apiBase') || 'https://discord.com/api/v10').replace(/\/+$/, ''); }

  api(p, { method = 'GET', body = null } = {}) {
    return this.fetchFn(`${this.apiBase()}${p}`, {
      method,
      headers: { authorization: `Bot ${this.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  cursorFile() { return path.join(this.cursorRoot || dirs.workspace || process.cwd(), 'channels', 'discord-cursor.json'); }
  loadCursor() {
    try {
      const j = JSON.parse(fs.readFileSync(this.cursorFile(), 'utf8'));
      for (const [k, v] of Object.entries(j.lastSeen || {})) this.lastSeen.set(k, String(v));
    } catch { /* fresh start: baseline is taken from history tail, never resets to zero */ }
  }
  saveCursor() {
    try {
      fs.mkdirSync(path.dirname(this.cursorFile()), { recursive: true });
      fs.writeFileSync(this.cursorFile(), JSON.stringify({ lastSeen: Object.fromEntries(this.lastSeen) }, null, 2));
    } catch (e) { this.bus.warn('discord.cursorSave', { error: e.message }); }
  }

  async start() {
    if (!this.token) { this.state = 'no-token'; this.lastError = 'channels.discord.token is empty'; return false; }
    if (!this.channelIds.length) { this.state = 'no-channels'; this.lastError = 'channels.discord.channelIds is empty — polling everything would be unsafe (and rate-limited)'; return false; }
    try {
      const meRaw = await (await this.api('/users/@me')).json().catch(() => ({}));
      if (!meRaw || !meRaw.id) { this.state = 'error'; this.lastError = '/users/@me failed — wrong token or no network access'; return false; }
      this.me = meRaw;
    } catch (e) { this.state = 'error'; this.lastError = e.message; return false; }
    this.loadCursor();
    this.running = true;
    this.state = 'polling';
    this.startedAt = new Date().toISOString();
    if (this.autostart) this.loop().catch((err) => { this.state = 'error'; this.lastError = err.message; this.bus.error('discord.loop', { error: err.message }); });
    this.bus.info('discord.up', { user: this.me.username, channels: this.channelIds.length });
    return true;
  }

  stop() { this.running = false; this.state = 'stopped'; this.saveCursor(); }

  async loop() {
    while (this.running) { this._pollJustDone = this.pollOnce(); await this._pollJustDone; if (this.running) await sleep(this.pollSec * 1000); }
    this.state = 'stopped';
  }

  /** En svep över alla kanaler. loop() använder samma väg — pollOnce är även
      den kontrollerade testpunkten (approve: aldrig bra med två poll-logiker). */
  async pollOnce() {
    const first = this._firstPoll;
    {
      for (const cid of this.channelIds) {
        try {
          const last = this.lastSeen.get(cid);
          // Baseline: without a cursor we tail the most recent message — NOT
          // the entire history (a backlog flood is not progress). Snowflake
          // ids sort lexicographically at equal length; discord ids are
          // 17-19 digits, so numeric compare is the honest sort.
          const url = last ? `/channels/${cid}/messages?after=${last}&limit=100` : `/channels/${cid}/messages?limit=1`;
          const j = await (await this.api(url)).json().catch(() => []);
          if (!Array.isArray(j)) { this.lastError = (j && j.message) || 'unexpected api payload'; continue; }
          // history returns newest-first; feed oldest-first
          const msgs = j.slice().sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
          for (const m of msgs) {
            this.lastSeen.set(cid, m.id);
            if (this.seenIds.has(m.id)) continue;
            this.seenIds.add(m.id);
            if (this.seenIds.size > 500) this.seenIds = new Set([...this.seenIds].slice(-250));
            if (first && !last) continue; // tail-baseline: på-första-poll-etablerad, inte agerad-på
            await this.handle(cid, m);
          }
          this.saveCursor();
          this.lastError = null;
        } catch (err) {
          this.lastError = err.message;
          this.bus.warn('discord.poll', { channel: cid, error: err.message });
        }
        await new Promise((r) => setTimeout(r, 250)); // mild spacing mellan kanaler, inga bucket-spikes
      }
    }
    this._firstPoll = false;
  }

  async handle(channelId, m) {
    if (m.author?.bot) return; // aldrig svara på andra/egna bots — loop-skydd
    if (this.me && String(m.author?.id) === String(this.me.id)) return;
    const uid = String(m.author?.id || '');
    if (this.allowedUsers.length && !this.allowedUsers.includes(uid)) return;
    const text = String(m.content ?? '').trim();
    if (!text) {
      /* Message Content intent saknas: eventet når oss tomt. Säg det — ett
         tomt svar skulle se ut som ett frozen-agent, ett diagnos-svar är
         never-stuck-beteendet: vi berättar VARFÖR vi inte kan läsa. */
      this.bus.warn('discord.empty-content', { channel: channelId, hint: 'Enable the Message Content privileged intent in the Dev Portal or MAJIN cannot read messages' });
      return;
    }
    this.received += 1;
    await this.onMessage?.({
      channel: 'discord', chatId: String(channelId),
      from: m.author?.username || uid, text,
      reply: async (t) => {
        const r = await sendDiscord(this.cfg, { channelId, text: String(t) }, this.fetchFn);
        if (r.ok) this.sent += 1;
        return r.ok;
      },
      meta: { messageId: m.id },
    });
  }

  status() {
    return {
      state: this.state, running: this.running,
      channels: this.channelIds.length, user: this.me?.username || null,
      received: this.received, sent: this.sent,
      lastError: this.lastError, startedAt: this.startedAt,
      notes: 'REST-poll — Message Content privileged intent must be enabled for readable content',
    };
  }
}
