/**
 * MAJIN — WhatsApp.
 * Två transports, samma gränssnitt:
 *   baileys  · din personliga nummer via QR, ingen Meta-app, inga avgifter
 *   cloud    · Meta WhatsApp Cloud API (webhook behövs för inkommande)
 * Baileys är en valfri npm-dep — MAJIN startar utan den och säger till vad som saknas.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dirs } from '../paths.js';
import { bus as globalBus } from '../log.js';

export function waOut(text) {
  return String(text ?? '')
    .replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, _l, body) => `\`\`\`\n${body.trim()}\n\`\`\``)
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const chunkText = (t, max = 3800) => {
  const parts = [];
  let rest = String(t || '');
  while (rest.length > max) {
    const cut = rest.lastIndexOf('\n', max);
    parts.push(rest.slice(0, cut > max * 0.4 ? cut : max));
    rest = rest.slice(cut > 0 ? cut + 1 : max);
  }
  if (rest.trim()) parts.push(rest);
  return parts.length ? parts : [String(t || '')];
};

export class WhatsApp {
  constructor(cfg, { onMessage, bus = globalBus } = {}) {
    this.cfg = cfg;
    this.onMessage = onMessage;
    this.bus = bus;
    this.state = 'stopped';
    this.qr = null;
    this.sock = null;
    this.lastError = null;
    this.received = 0;
    this.sent = 0;
    this.linked = null;
  }

  get transport() {
    return this.cfg.get('channels.whatsapp.transport') || 'baileys';
  }

  status() {
    return {
      online: this.state === 'connected',
      state: this.state,
      transport: this.transport,
      qr: this.qr,
      linked: this.linked,
      received: this.received,
      sent: this.sent,
      lastError: this.lastError,
      hint: this.state === 'stopped' ? 'pair from the window (majin pair whatsapp) or fill in a cloud token in config' : null,
    };
  }

  async start() {
    if (!this.cfg.get('channels.whatsapp.enabled')) {
      this.state = 'disabled';
      return false;
    }
    if (this.transport === 'cloud') return this.startCloud();
    return this.startBaileys();
  }

  startCloud() {
    const c = this.cfg.get('channels.whatsapp.cloud') || {};
    if (!c.accessToken || !c.phoneNumberId) {
      this.state = 'no-token';
      this.lastError = 'cloud: accessToken + phoneNumberId missing';
      return false;
    }
    this.state = 'connected';
    this.linked = `cloud:${c.phoneNumberId}`;
    this.bus.info('whatsapp.cloud-ready', { phoneNumberId: c.phoneNumberId, webhook: `http://<host>:${this.cfg.get('server.port')}${this.cfg.get('channels.webhook.path')}` });
    return true;
  }

  async cloudSend(to, text) {
    const c = this.cfg.get('channels.whatsapp.cloud') || {};
    const url = `https://graph.facebook.com/${c.apiVersion || 'v23.0'}/${c.phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: String(to).replace(/[^0-9]/g, ''), type: 'text', text: { preview_url: false, body: waOut(text) } }),
    }).catch((e) => null);
    if (!res) return { ok: false, error: 'network error towards Meta' };
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `${res.status} ${j.error?.message || ''}`.trim() };
    this.sent += 1;
    return { ok: true, id: j.messages?.[0]?.id };
  }

  /** Meta webhook-validering (GET hub.challenge). */
  verifyWebhook(query) {
    const c = this.cfg.get('channels.whatsapp.cloud') || {};
    if (!c.verifyToken) return { ok: false, error: 'channels.whatsapp.cloud.verifyToken is not set' };
    if (query['hub.mode'] !== 'subscribe' || query['hub.verify_token'] !== c.verifyToken) return { ok: false, error: 'verify_token mismatch' };
    return { ok: true, challenge: query['hub.challenge'] };
  }

  /** Kroppen från Meta — anropas av servern. */
  ingest(body) {
    try {
      const entry = body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      const msg = value?.messages?.[0];
      if (!msg) return { ok: true, ignored: true };
      const from = msg.from;
      const allowed = this.cfg.get('channels.whatsapp.allowedJids') || [];
      if (allowed.length && !allowed.map(String).includes(String(from))) {
        this.bus.warn('whatsapp.blocked', { from });
        return { ok: true, blocked: true };
      }
      this.received += 1;
      const text = msg.text?.body || msg.caption || '';
      const media = msg.document || msg.image || msg.audio || msg.video;
      this.onMessage?.({
        channel: 'whatsapp',
        chatId: from,
        text,
        files: media ? [{ name: media.filename || 'media', kind: media.mime_type || 'media', url: media.id }] : [],
        from,
        reply: async (t) => this.cloudSend(from, t),
        raw: msg,
      });
      return { ok: true };
    } catch (err) {
      this.bus.warn('whatsapp.ingest', { error: err.message });
      return { ok: false, error: err.message };
    }
  }

  async startBaileys() {
    let baileys;
    try {
      baileys = await import('@whiskeysockets/baileys');
    } catch {
      try {
        baileys = await import('baileys');
      } catch {
        this.state = 'missing-dep';
        this.lastError = 'baileys is not installed';
        this.bus.warn('whatsapp.missing', { hint: 'run: npm i @whiskeysockets/baileys qrcode' });
        return false;
      }
    }
    const { default: qrcode } = await import('qrcode').then((m) => ({ default: m.default || m })).catch(() => ({ default: null }));
    this.qrcode = qrcode;

    const authDir = path.join(dirs.creds, this.cfg.get('channels.whatsapp.baileys.sessionDir') || 'whatsapp');
    fs.mkdirSync(authDir, { recursive: true });
    const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = baileys;
    const { state: auth, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = (await fetchLatestBaileysVersion?.()) || {};
    const sock = makeWASocket({
      version,
      auth,
      printQRInTerminal: false,
      browser: ['MAJIN', 'chrome', '1.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    this.sock = sock;
    this.state = 'pairing';
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        this.qrString = qr;
        this.state = 'pairing';
        if (this.qrcode?.toDataURL) this.qrcode.toDataURL(qr, { margin: 1, width: 320 }).then((d) => (this.qr = d)).catch(() => (this.qr = null));
        this.bus.emit('whatsapp.qr', { qr, png: Boolean(this.qr), attempt: (this.qrAttempts = (this.qrAttempts || 0) + 1) });
      }
      if (connection === 'open') {
        this.state = 'connected';
        this.retries = 0;
        this.qr = null;
        this.qrString = null;
        this.linked = sock.user?.id || 'unknown';
        this.bus.info('whatsapp.connected', { jid: this.linked });
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason?.loggedOut;
        this.retries = (this.retries || 0) + 1;
        const cap = Number(this.cfg.get('channels.whatsapp.maxRetries') || 6);
        // A QR nobody scans must not retry every 3 s forever: log spam, CPU and needless
        // WebSocket connections against WhatsApp. Back off, and stop once we clearly
        // never got paired.
        if (!loggedOut && !this.linked && this.retries > cap) {
          this.state = 'stopped';
          this.lastError = `gave up after ${cap} attempts (never paired)`;
          this.bus.warn('whatsapp.gaveup', { attempts: this.retries, code });
          return;
        }
        this.state = loggedOut ? 'logged-out' : 'reconnecting';
        this.lastError = `closed (${code})`;
        this.bus.warn('whatsapp.close', { code, loggedOut, retries: this.retries });
        if (!loggedOut && this.cfg.get('channels.whatsapp.enabled')) {
          const delay = Math.min(3000 * 2 ** Math.max(0, this.retries - 1), 300000);
          setTimeout(() => this.startBaileys().catch(() => {}), delay).unref?.();
        }
      }
    });
    sock.ev.on('messages.upsert', ({ type, messages }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        if (!m.key || m.key.fromMe) continue;
        const text = m.message?.conversation || m.message?.extendedTextMessage?.text || m.message?.imageMessage?.caption || m.message?.documentMessage?.caption || '';
        const from = m.key.remoteJid;
        const allowed = this.cfg.get('channels.whatsapp.allowedJids') || [];
        if (allowed.length && !allowed.map(String).includes(String(from))) {
          this.bus.warn('whatsapp.blocked', { from, code: `send "pair ${from.split('@')[0]}" to grant access` });
          continue;
        }
        this.received += 1;
        this.onMessage?.({
          channel: 'whatsapp',
          chatId: from,
          text: String(text),
          from: m.pushName || from?.split('@')?.[0],
          files: m.message?.documentMessage ? [{ name: m.message.documentMessage.fileName || 'document', kind: m.message.documentMessage.mimetype, msg: m }] : [],
          reply: async (t) => this.baileysSend(from, t),
          raw: m,
        });
      }
    });
    return true;
  }

  async baileysSend(jid, text) {
    if (!this.sock) return { ok: false, error: 'no baileys session' };
    const parts = chunkText(waOut(text));
    let last;
    for (const p of parts) {
      last = await this.sock.sendMessage(jid, { text: p }).catch((e) => ({ error: e.message }));
    }
    this.sent += 1;
    return { ok: !last?.error, id: last?.key?.id, error: last?.error };
  }

  async sendDocument(jid, filePath, caption = '') {
    if (!fs.existsSync(filePath)) return { ok: false, error: 'the file is missing' };
    if (!this.sock) return { ok: false, error: 'no whatsapp session' };
    const res = await this.sock.sendMessage(jid, { document: { url: filePath }, caption: waOut(caption) }).catch((e) => ({ error: e.message }));
    return res?.error ? { ok: false, error: res.error } : { ok: true };
  }

  async allow(jid) {
    const list = [...new Set([...(this.cfg.get('channels.whatsapp.allowedJids') || []), String(jid)])];
    this.cfg.patch({ channels: { whatsapp: { allowedJids: list } } });
    return list;
  }

  async stop() {
    try {
      this.sock?.end?.();
    } catch {
      /* red */
    }
    this.sock = null;
    this.state = 'stopped';
    this.qr = null;
  }
}
