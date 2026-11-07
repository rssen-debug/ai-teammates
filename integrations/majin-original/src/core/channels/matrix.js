/**
 * MAJIN — Matrix inbound (zero-dep /sync polling).
 *
 * Matrix has the native poll API (GET /sync, since-token) — fetch is all
 * the wheel required; matrix-js-sdk (488 files, absorb-scanned 2026-10-21,
 * Apache-2.0) was the pattern reference for the event shape, never a
 * dependency. Timeline messages of type m.room.message/msgtype m.text in
 * JOINED rooms become agent turns; own events are skipped (loop-guard);
 * the since-cursor is persisted so restarts resume, never re-read floods.
 *
 * HONEST LIMITS in status(): room allowlist channels.matrix.roomIds (empty =
 * every joined room — "all joined" is the matrix-idiomatic default; narrow
 * it in shared homes). No E2EE: encrypted rooms arrive as m.room.encrypted
 * and are reported as skipped (never decrypted-garbage fed to the agent).
 */
import fs from 'node:fs';
import path from 'node:path';
import { bus as globalBus } from '../log.js';
import { dirs } from '../paths.js';
import { sendMatrix } from './send.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class MatrixChannel {
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
    this.since = null;
    this.skippedEncrypted = 0;
    this.seenIds = new Set();
    this.autostart = autostart;
    this._baselineTook = false;
    this.cursorRoot = cursorRoot;
  }

  get token() { return this.cfg.get('channels.matrix.accessToken') || this.cfg.get('channels.matrix.token'); }
  get homeserver() { return (this.cfg.get('channels.matrix.homeserver') || '').replace(/\/+$/, ''); }
  get roomIds() { return (this.cfg.get('channels.matrix.roomIds') || []).map(String).filter(Boolean); }
  get allowedUsers() { return (this.cfg.get('channels.matrix.allowedUserIds') || []).map(String); }
  get pollSec() { return Math.max(1, Number(this.cfg.get('channels.matrix.pollSec') || 10)); }

  api(p, { method = 'GET', body = null } = {}) {
    return this.fetchFn(`${this.homeserver}${p}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  cursorFile() { return path.join(this.cursorRoot || dirs.workspace || process.cwd(), 'channels, matrix-cursor.json'.replace('channels, ','channels/')); }
  loadCursor() {
    try { this.since = JSON.parse(fs.readFileSync(this.cursorFile(), 'utf8')).since || null; } catch { this.since = null; }
  }
  saveCursor() {
    try {
      fs.mkdirSync(path.dirname(this.cursorFile()), { recursive: true });
      fs.writeFileSync(this.cursorFile(), JSON.stringify({ since: this.since }, null, 2));
    } catch (e) { this.bus.warn('matrix.cursorSave', { error: e.message }); }
  }

  async start() {
    if (!this.token) { this.state = 'no-token'; this.lastError = 'channels.matrix.accessToken is empty'; return false; }
    if (!this.homeserver) { this.state = 'no-homeserver'; this.lastError = 'channels.matrix.homeserver is empty'; return false; }
    try {
      const j = await (await this.api('/_matrix/client/v3/account/whoami')).json().catch(() => ({}));
      if (!j || !j.user_id) { this.state = 'error'; this.lastError = 'whoami failed — wrong token/homeserver or no network'; return false; }
      this.me = j;
    } catch (e) { this.state = 'error'; this.lastError = e.message; return false; }
    this.loadCursor();
    /* Tail-baseline: first sync without cursor requests a just-tails filter
       (limit:0 timeline) so the first since token lands at NOW. */
    this.running = true;
    this.state = 'polling';
    this.startedAt = new Date().toISOString();
    if (this.autostart) this.loop().catch((err) => { this.state = 'error'; this.lastError = err.message; this.bus.error('matrix.loop', { error: err.message }); });
    this.bus.info('matrix.up', { user: this.me.user_id, roomsAllowlist: this.roomIds.length || 'all-joined' });
    return true;
  }

  stop() { this.running = false; this.state = 'stopped'; this.saveCursor(); }

  /** /sync-långpollsloopen delar metod-kärna med testdrivaren (pollOnce). */
  async loop() {
    while (this.running) { this._pollJustDone = this.pollOnce(); await this._pollJustDone; }
    this.state = 'stopped';
  }

  async pollOnce() {
    try {
      const qs = new URLSearchParams({ timeout: String(this.pollSec * 1000) });
      if (!this.since && !this._baselineTook) qs.set('filter', JSON.stringify({ room: { timeline: { limit: 0 } } }));
      if (this.since) qs.set('since', this.since);
      const j = await (await this.api(`/_matrix/client/v3/sync?${qs}`)).json().catch(() => null);
      if (!j || !j.next_batch) { this.lastError = (j && (j.error || j.errcode)) || 'sync payload unexpected'; await sleep(3); return; }
      const hadCursor = Boolean(this.since);
      this.since = j.next_batch;
      this._baselineTook = true;
      if (hadCursor) {
        for (const [roomId, room] of Object.entries(j.rooms?.join || {})) {
          for (const ev of room.timeline?.events || []) await this.handle(roomId, ev);
        }
      }
      this.saveCursor();
      this.lastError = null;
    } catch (err) {
      this.lastError = err.message;
      this.bus.warn('matrix.poll', { error: err.message });
    }
  }

  async handle(roomId, ev) {
    if (this.roomIds.length && !this.roomIds.includes(String(roomId))) return;
    if (ev.type === 'm.room.encrypted') { this.skippedEncrypted += 1; return; } // ärligt: ingen E2EE-lager här
    if (ev.type !== 'm.room.message') return;
    if (this.me && String(ev.sender) === String(this.me.user_id)) return;
    if (ev.event_id && this.seenIds.has(ev.event_id)) return;
    if (ev.event_id) { this.seenIds.add(ev.event_id); if (this.seenIds.size > 500) this.seenIds = new Set([...this.seenIds].slice(-250)); }
    if (this.allowedUsers.length && !this.allowedUsers.includes(String(ev.sender))) return;
    const c = ev.content || {};
    if (c.msgtype !== 'm.text') return;
    const text = String(c.body ?? '').trim();
    if (!text) return;
    this.received += 1;
    await this.onMessage?.({
      channel: 'matrix', chatId: String(roomId),
      from: String(ev.sender || ''), text,
      reply: async (t) => {
        const r = await sendMatrix(this.cfg, { room: roomId, text: String(t) }, this.fetchFn);
        if (r.ok) this.sent += 1;
        return r.ok;
      },
      meta: { eventId: ev.event_id },
    });
  }

  status() {
    return {
      state: this.state, running: this.running,
      rooms: this.roomIds.length || 'all-joined', user: this.me?.user_id || null,
      received: this.received, sent: this.sent, skippedEncrypted: this.skippedEncrypted,
      lastError: this.lastError, startedAt: this.startedAt,
      notes: '/sync since-cursor persisted; encrypted rooms are counted as skipped, never decoded as garbage',
    };
  }
}
