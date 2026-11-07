/**
 * MAJIN — Telegram.
 * Long polling (ingen webhook, ingen publik IP behövs), HTML-formaterat svar,
 * filer fram och tillbaka (ladda ner en misstänkt exe → skicka den till MAJIN).
 */
import fs from 'node:fs';
import path from 'node:path';
import { bus as globalBus } from '../log.js';
import { dirs } from '../paths.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function toTelegramHtml(md) {
  let s = String(md ?? '');
  const code = [];
  s = s.replace(/```([\s\S]*?)```/g, (_, body) => {
    code.push(body.replace(/^\n/, '').replace(/\n$/, ''));
    return `\u0000${code.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<i>$2</i>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/(?:^|\n)#{1,6}\s*(.+)$/gm, '\n<b>$1</b>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<pre><code>${esc(code[Number(i)])}</code></pre>`);
  return s;
}

export function chunk(text, max = 3900) {
  const clean = String(text || '');
  if (clean.length <= max) return [clean];
  const parts = [];
  let rest = clean;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.4) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}

export class Telegram {
  constructor(cfg, { onMessage, bus = globalBus } = {}) {
    this.cfg = cfg;
    this.onMessage = onMessage;
    this.bus = bus;
    this.offset = 0;
    this.running = false;
    this.state = 'stopped';
    this.lastError = null;
    this.pairingCode = null;
    this.startedAt = null;
    this.sent = 0;
    this.received = 0;
  }

  get token() {
    return this.cfg.get('channels.telegram.botToken');
  }

  api(method, body) {
    const base = (this.cfg.get('channels.telegram.apiBase') || 'https://api.telegram.org').replace(/\/+$/, '');
    return fetch(`${base}/bot${this.token}/${method}`, {
      method: body ? 'POST' : 'GET',
      headers: body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : undefined,
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    });
  }

  async getMe() {
    const r = await this.api('getMe');
    const j = await r.json().catch(() => ({}));
    return j.ok ? j.result : null;
  }

  async start() {
    if (!this.token) {
      this.state = 'no-token';
      this.lastError = 'channels.telegram.botToken is empty';
      return false;
    }
    const me = await this.getMe();
    if (!me) {
      this.state = 'error';
      this.lastError = 'getMe failed — wrong token or no network access';
      return false;
    }
    this.me = me;
    this.state = 'polling';
    this.running = true;
    this.startedAt = new Date().toISOString();
    this.pairingCode = this.pairingCode || Math.random().toString(36).slice(2, 8).toUpperCase();
    this.loop().catch((err) => {
      this.state = 'error';
      this.lastError = err.message;
      this.bus.error('telegram.loop', { error: err.message });
    });
    this.bus.info('telegram.up', { username: me.username, pairingCode: this.pairingCode });
    return true;
  }

  stop() {
    this.running = false;
    this.state = 'stopped';
  }

  async loop() {
    const timeout = this.cfg.get('channels.telegram.pollTimeoutSec') || 30;
    while (this.running) {
      try {
        const q = new URLSearchParams({ timeout: String(timeout), allowed_updates: JSON.stringify(['message', 'edited_message', 'document']) });
        const base = (this.cfg.get('channels.telegram.apiBase') || 'https://api.telegram.org').replace(/\/+$/, '');
        const res = await fetch(`${base}/bot${this.token}/getUpdates?${q}`, { method: 'POST', signal: AbortSignal.timeout((timeout + 15) * 1000) });
        const j = await res.json().catch(() => ({}));
        if (!j.ok) {
          this.lastError = j.description || 'error';
          await sleep(3000);
          continue;
        }
        for (const up of j.result || []) {
          this.offset = Math.max(this.offset, up.update_id + 1);
          await this.handle(up);
        }
      } catch (err) {
        this.lastError = err.message;
        this.bus.warn('telegram.poll', { error: err.message });
        await sleep(4000);
      }
    }
    this.state = 'stopped';
  }

  async handle(up) {
    const msg = up.message || up.edited_message;
    if (!msg) return;
    const chat = msg.chat?.id;
    if (!chat) return;
    const allowed = (this.cfg.get('channels.telegram.allowedChatIds') || []).map(Number);
    const text = String(msg.text || msg.caption || '').trim();
    const from = msg.from?.username || msg.from?.first_name || String(chat);

    if (/^\/(start|pair)\b/i.test(text)) {
      const code = text.split(/\s+/)[1] || '';
      if (!allowed.includes(Number(chat)) && this.cfg.get('channels.telegram.pairing') !== false) {
        if (code.toUpperCase() !== String(this.pairingCode).toUpperCase()) {
          await this.send(chat, `Not paired. Send <code>pair ${this.pairingCode}</code> to connect this chat to MAJIN. (Full access to the machine — do not add strangers.)`);
          return;
        }
        const list = [...new Set([...allowed, Number(chat)])];
        this.cfg.patch({ channels: { telegram: { allowedChatIds: list } } });
        this.pairingCode = Math.random().toString(36).slice(2, 8).toUpperCase();
        await this.send(chat, `Parat. ${list.length} chat(s) allowed. New pairing code: <code>${this.pairingCode}</code>\nWrite /status to see what is running.`);
        this.bus.info('telegram.paired', { chat, from });
        return;
      }
      await this.send(chat, `MAJIN is ready. <b>${this.registryCount?.() ?? 'All'} tools on</b>, MOA ${this.cfg.get('moa.policy')}. /status /tools /stop /help`);
      return;
    }
    if (/^\/help\b/i.test(text)) {
      await this.send(chat, '<b>MAJIN</b>\n/status — what is on\n/tools — every tool\n/model — routing\n/stop — cancel the current turn\n/pair — new code\nJust write normally: "use deepseek pro for code always", "analyse the file I sent", "check the status".');
      return;
    }
    if (/^\/stop\b/i.test(text)) {
      this.onControl?.('stop', { chat, from });
      await this.send(chat, 'Avbrut.');
      return;
    }
    if (!allowed.includes(Number(chat))) {
      if (this.cfg.get('channels.telegram.pairing') === false) {
        // pairing avstängt = öppen bot — farligt men användarens val
      } else {
        await this.send(chat, `Unknown chat. Send <code>pair ${this.pairingCode}</code> to pair.`);
        this.bus.warn('telegram.unpaired', { chat, from });
        return;
      }
    }
    this.received += 1;
    const files = await this.collectFiles(msg);
    this.onMessage?.({
      channel: 'telegram',
      chatId: chat,
      text: text || (files.length ? '(bilaga)' : ''),
      files,
      from,
      reply: async (t, opts) => this.send(chat, t, opts),
      sendDocument: (p, caption) => this.sendDocument(chat, p, caption),
      sendChatAction: (a) => this.api('sendChatAction', { chat_id: chat, action: a || 'typing' }).catch(() => {}),
      raw: msg,
    });
  }

  registryCount() {
    return this.countFn?.() ?? null;
  }

  async collectFiles(msg) {
    const out = [];
    const items = [msg.document, msg.photo?.at(-1), msg.video, msg.audio, msg.voice].filter(Boolean);
    for (const f of items) {
      try {
        const r = await this.api(`getFile?file_id=${encodeURIComponent(f.file_id)}`);
        const j = await r.json();
        if (!j.ok) continue;
        const base = (this.cfg.get('channels.telegram.apiBase') || 'https://api.telegram.org').replace(/\/+$/, '');
        const res = await fetch(`${base}/file/bot${this.token}/${j.result.file_path}`);
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        const safe = path.basename(String(f.file_name || j.result.file_path || 'file.bin')).replace(/[^\w.\-]/g, '_').slice(0, 120);
        const dest = path.join(dirs.uploads, `tg-${Date.now()}-${safe}`);
        fs.mkdirSync(dirs.uploads, { recursive: true });
        fs.writeFileSync(dest, buf);
        out.push({ name: safe, path: dest, size: buf.length, kind: f.mime_type || 'file' });
      } catch (err) {
        this.bus.warn('telegram.file', { error: err.message });
      }
    }
    return out;
  }

  async send(chatId, text, { parse = true, replyTo = null } = {}) {
    if (!this.token) return { ok: false, error: 'no token' };
    const body = toTelegramHtml(text);
    const parts = chunk(body);
    let last = null;
    for (const p of parts) {
      const res = await this.api('sendMessage', {
        chat_id: chatId,
        text: p,
        parse_mode: parse && this.cfg.get('channels.telegram.parseMode') !== 'none' ? 'HTML' : undefined,
        disable_web_page_preview: true,
        reply_to_message_id: replyTo || undefined,
      }).catch((e) => ({ json: async () => ({ ok: false, description: e.message }) }));
      last = await res.json().catch(() => ({}));
      this.sent += 1;
      if (!last.ok && /parse|entities/i.test(last.description || '')) {
        const fallback = await this.api('sendMessage', { chat_id: chatId, text: stripTags(p), disable_web_page_preview: true }).catch(() => null);
        last = await fallback?.json?.().catch(() => ({}));
      } else if (!last.ok) {
        this.bus.warn('telegram.send', { error: last.description, chatId });
        return { ok: false, error: last.description };
      }
    }
    return { ok: true, id: last?.result?.message_id };
  }

  async sendDocument(chatId, filePath, caption = '') {
    if (!fs.existsSync(filePath)) return { ok: false, error: `no file ${filePath}` };
    const buf = fs.readFileSync(filePath);
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    if (caption) fd.append('caption', stripTags(chunk(caption, 900)[0]));
    fd.append('document', new Blob([buf], { type: 'application/octet-stream' }), path.basename(filePath));
    const res = await this.api('sendDocument', fd).catch((e) => null);
    if (!res) return { ok: false, error: 'sending failed' };
    const j = await res.json().catch(() => ({}));
    if (!j.ok) return { ok: false, error: j.description };
    return { ok: true, size: buf.length };
  }

  async setTyping(chatId, on = true) {
    if (!on) return;
    const timer = setInterval(() => this.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}), 5000);
    timer.unref?.();
    this.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    return () => clearInterval(timer);
  }

  status() {
    return {
      online: this.state === 'polling',
      state: this.state,
      bot: this.me ? `@${this.me.username}` : null,
      chats: (this.cfg.get('channels.telegram.allowedChatIds') || []).length,
      pairingCode: this.pairingCode,
      received: this.received,
      sent: this.sent,
      lastError: this.lastError,
      startedAt: this.startedAt,
    };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripTags = (s) => String(s).replace(/<\/?(b|i|u|s|code|pre|a)[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
