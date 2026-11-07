/**
 * MAJIN — kanalbussen.
 * Telegram + WhatsApp blir samma samtalsyta som skrivbordet: in → agent.turn(),
 * ut → kanalen. Godkännandefrågor följer med till chatten där du faktiskt är.
 */
import { Telegram } from './telegram.js';
import { WhatsApp } from './whatsapp.js';
import { DiscordChannel } from './discord.js';
import { SlackChannel } from './slack.js';
import { MatrixChannel } from './matrix.js';
import { sendDiscord, sendSlack, sendMatrix } from './send.js';
import { approvals } from '../guard.js';
import { bus as globalBus } from '../log.js';
import { readHistory } from '../context.js';

export class Channels {
  constructor({ cfg, agent = null, registry = null, scheduler = null, bus = globalBus, runTask = null }) {
    this.cfg = cfg;
    this.agent = agent;
    this.registry = registry;
    this.scheduler = scheduler;
    this.bus = bus;
    this.runTask = runTask;
    this.active = new Map();
    this.queue = Promise.resolve();
    this.telegram = new Telegram(cfg, { onMessage: (m) => this.enqueue(m), bus });
    this.whatsapp = new WhatsApp(cfg, { onMessage: (m) => this.enqueue(m), bus });
    /* W8 receive-parity: samma samtalsyta (channel:chatId-sessioner) med
       samma queue/approval-routing som telegram/whatsapp. */
    this.discord = new DiscordChannel(cfg, { onMessage: (m) => this.enqueue(m), bus });
    this.slack = new SlackChannel(cfg, { onMessage: (m) => this.enqueue(m), bus });
    this.matrix = new MatrixChannel(cfg, { onMessage: (m) => this.enqueue(m), bus });
    this.telegram.onControl = (what, m) => {
      if (what === 'stop') agent?.stop(`${'telegram'}:${m.chat}`);
    };
    this.telegram.countFn = () => registry?.list?.().length ?? null;
    this.off = null;
  }

  async start() {
    const tg = this.cfg.get('channels.telegram.enabled') ? await this.telegram.start().catch((e) => (this.bus.warn('telegram.start', { error: e.message }), false)) : false;
    const wa = this.cfg.get('channels.whatsapp.enabled') ? await this.whatsapp.start().catch((e) => (this.bus.warn('whatsapp.start', { error: e.message }), false)) : false;
    const dc = this.cfg.get('channels.discord.enabled') ? await this.discord.start().catch((e) => (this.bus.warn('discord.start', { error: e.message }), false)) : false;
    const sl = this.cfg.get('channels.slack.enabled') ? await this.slack.start().catch((e) => (this.bus.warn('slack.start', { error: e.message }), false)) : false;
    const mx = this.cfg.get('channels.matrix.enabled') ? await this.matrix.start().catch((e) => (this.bus.warn('matrix.start', { error: e.message }), false)) : false;
    this.off = this.bus.on('approval:request', (ev) => this.toApproval(ev));
    this.bus.info('channels.start', { telegram: tg, whatsapp: wa, discord: dc, slack: sl, matrix: mx });
    return { telegram: tg, whatsapp: wa, discord: dc, slack: sl, matrix: mx };
  }

  stop() {
    this.off?.();
    this.telegram.stop();
    this.whatsapp.stop().catch(() => {});
    this.discord.stop();
    this.slack.stop();
    this.matrix.stop();
  }

  status() {
    return { telegram: this.telegram.status(), whatsapp: this.whatsapp.status(), discord: this.discord.status(), slack: this.slack.status(), matrix: this.matrix.status(), busy: [...this.active.values()].length };
  }

  /** Väntande godkännande i rätt chat. */
  toApproval(ev) {
    const session = ev.session;
    if (!session || !session.includes(':')) return;
    const [channel, chatId] = session.split(':');
    const text = [
      `⚠️ ${ev.reason || 'Confirmation required'}`,
      ev.detail ? `\`${String(ev.detail).slice(0, 300)}\`` : '',
      '',
      `Reply with /ja ${ev.id} to allow it  ·  /nej to refuse`,
    ]
      .filter(Boolean)
      .join('\n');
    if (channel === 'telegram') this.telegram.send(Number(chatId), text).catch(() => {});
    if (channel === 'whatsapp') this.whatsapp.cloudSend(chatId, text).catch(() => {});
    if (channel === 'discord') sendDiscord(this.cfg, { channelId: chatId, text }).catch(() => {});
    if (channel === 'slack') sendSlack(this.cfg, { channel: chatId, text }).catch(() => {});
    if (channel === 'matrix') sendMatrix(this.cfg, { room: chatId, text }).catch(() => {});
  }

  enqueue(msg) {
    this.queue = this.queue.then(() => this.handle(msg)).catch((err) => this.bus.error('channel.handle', { error: err.message }));
    return this.queue;
  }

  async handle(msg) {
    const session = `${msg.channel}:${msg.chatId}`;
    const text = String(msg.text || '').trim();
    if (!text && !msg.files?.length) return;

    const approval = /^(\/?(ja|nej|godk[aä]nn|avsl[åa]|approve|deny|allow))\s+(apr_[a-z0-9]+)\b/i.exec(text);
    if (approval) {
      const yes = /^(\/?(ja|godk[aä]nn|approve|allow))/i.test(approval[1]);
      const ok = approvals.respond(approval[2], yes, `channel ${msg.channel}`);
      await msg.reply(ok ? (yes ? 'Cleared — go.' : 'Nej, stoppat.') : 'That approval was already resolved or has expired.');
      return;
    }
    if (/^\/?(status|state)\b/i.test(text)) {
      const st = this.status();
      const moa = this.cfg.get('moa');
      await msg.reply(
        [
          `MAJIN · ${st.telegram.online ? '🟢 telegram' : '⚪️ telegram'} · ${st.whatsapp.online ? '🟢 whatsapp' : st.whatsapp.state === 'pairing' ? '🟡 para mig' : '⚪️ whatsapp'}`,
          `model ${this.cfg.get('models.provider')} · routes ${this.cfg.routeTable().length} · tools ${this.registry?.list?.().length ?? '?'}`,
          `MOA ${moa.policy} (${moa.width} referenser → ${moa.aggregator}) · guard ${this.cfg.get('guard.mode')}`,
          this.scheduler ? schemText(this.scheduler) : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
      return;
    }
    if (/^\/?(tools|verktyg)\b/i.test(text)) {
      const groups = this.registry?.groups?.() || {};
      await msg.reply(Object.entries(groups).map(([g, list]) => `*${g}* (${list.length}): ${list.map((t) => t.name).join(', ')}`).join('\n\n').slice(0, 3600) || 'ingen registry');
      return;
    }
    if (/^\/?(avbryt|stop|cancel)\b/i.test(text)) {
      this.agent?.stop(session);
      await msg.reply('Cancelling the current turn.');
      return;
    }
    if (/^pair\b/i.test(text) && msg.channel === 'whatsapp') {
      const jid = String(text.split(/\s+/)[1] || msg.chatId);
      await this.whatsapp.allow(jid.includes('@') ? jid : `${jid}@s.whatsapp.net`);
      await msg.reply('Number allowed. Write /status when you want to run.');
      return;
    }
    if (/^\/?para\s+([A-Z0-9]{4,10})$/i.test(text) && msg.channel === 'whatsapp') {
      const ok = text.toUpperCase() === String(this.telegram.pairingCode || '').toUpperCase();
      await msg.reply(ok ? 'code accepted, but telegram is its own channel — use /pair inside Telegram.' : 'unknown code.');
      return;
    }

    if (!this.agent) {
      await msg.reply('The agent is not wired to this channel yet.');
      return;
    }
    this.active.set(session, msg);
    let stopTyping = null;
    try {
      if (msg.sendChatAction) stopTyping = await msg.sendChatAction('typing');
      const t0 = Date.now();
      const nudge = setInterval(() => {
        const busy = this.busyInfo(session);
        msg.reply(`⏳ still working (${busy.steps} steps, ${busy.tools} tools)…`).catch(() => {});
      }, 90000);
      nudge.unref?.();
      const res = await this.agent.turn({
        input: text || 'Analysera bilagan.',
        session,
        attachments: (msg.files || []).map((f) => ({ ...f, note: f.kind ? `typ ${f.kind}` : '' })),
        source: msg.channel,
        history: readHistory(session, 40),
        onEvent: (ev) => {
          if (ev.type === 'tool_result' && !ev.ok) msg.reply(`⚠️ ${ev.tool}: ${String(ev.error?.message || ev.error || 'error').slice(0, 300)}`).catch(() => {});
          if (ev.type === 'answer' && this.cfg.get('channels.shared.replyWhileStreaming')) {
            const head = String(ev.text || '').slice(0, 90);
            if (head) msg.reply(`${head}…`).catch(() => {});
          }
        },
      });
      clearInterval(nudge);
      const prefix = this.cfg.get('channels.whatsapp.replyPrefix') || '';
      const tail = this.cfg.get('channels.shared.forwardToChat') === false ? '' : footer(res, Date.now() - t0);
      await msg.reply(`${prefix}${res.text || '(empty answer)'}${tail}`);
    } catch (err) {
      await msg.reply(`Error: ${err.message}${err.hint ? `\n${err.hint}` : ''}`);
    } finally {
      if (typeof stopTyping === 'function') stopTyping();
      this.active.delete(session);
    }
  }

  busyInfo(session) {
    const ev = this.bus.tail(40).filter((e) => e.session === session);
    return { steps: ev.filter((e) => e.type === 'agent.step').length, tools: ev.filter((e) => e.type === 'tool_result').length };
  }

  /** schema/agent-driven utskick (scheduler + notifieringar). */
  async deliver(session, text) {
    const [channel, chatId] = String(session || '').split(':');
    if (!chatId) return false;
    if (channel === 'telegram') return (await this.telegram.send(Number(chatId), text)).ok;
    if (channel === 'whatsapp') return (await this.whatsapp.cloudSend(chatId, text)).ok !== false;
    if (channel === 'discord') return (await sendDiscord(this.cfg, { channelId: chatId, text })).ok;
    if (channel === 'slack') return (await sendSlack(this.cfg, { channel: chatId, text })).ok;
    if (channel === 'matrix') return (await sendMatrix(this.cfg, { room: chatId, text })).ok;
    return false;
  }

  async sessions() {
    const out = [];
    for (const id of this.cfg.get('channels.telegram.allowedChatIds') || []) out.push({ channel: 'telegram', chatId: id, session: `telegram:${id}`, last: readHistory(`telegram:${id}`, 1).at(-1)?.content?.slice(0, 80) || '' });
    for (const id of this.cfg.get('channels.whatsapp.allowedJids') || []) out.push({ channel: 'whatsapp', chatId: id, session: `whatsapp:${id}`, last: readHistory(`whatsapp:${id}`, 1).at(-1)?.content?.slice(0, 80) || '' });
    for (const id of (this.cfg.get('channels.discord.channelIds') || [])) out.push({ channel: 'discord', chatId: id, session: `discord:${id}`, last: readHistory(`discord:${id}`, 1).at(-1)?.content?.slice(0, 80) || '' });
    for (const id of (this.cfg.get('channels.slack.channelIds') || [])) out.push({ channel: 'slack', chatId: id, session: `slack:${id}`, last: readHistory(`slack:${id}`, 1).at(-1)?.content?.slice(0, 80) || '' });
    for (const id of (this.cfg.get('channels.matrix.roomIds') || [])) out.push({ channel: 'matrix', chatId: id, session: `matrix:${id}`, last: readHistory(`matrix:${id}`, 1).at(-1)?.content?.slice(0, 80) || '' });
    return out;
  }

  /** UI:ja/knappar. */
  async approve(id, yes) {
    return approvals.respond(id, yes, 'ui');
  }

  startTelegram() {
    return this.telegram.start();
  }

  stopTelegram() {
    this.telegram.stop();
    return true;
  }

  startWhatsapp() {
    return this.whatsapp.start();
  }

  stopWhatsapp() {
    return this.whatsapp.stop();
  }
}

function footer(res, ms) {
  if (!res || res.fastPath) return '';
  const bits = [];
  if (res.steps) bits.push(`${res.steps} steg`);
  if (res.tools?.length) bits.push(`${res.tools.length} tools`);
  if (res.moa?.agreement != null) bits.push(`MOA ${(res.moa.agreement * 100).toFixed(0)}%`);
  if (res.usage?.costUsd) bits.push(`$${res.usage.costUsd.toFixed(4)}`);
  bits.push(`${(ms / 1000).toFixed(1)}s`);
  return `\n\n— ${bits.join(' · ')}`;
}

function schemText(scheduler) {
  const jobs = scheduler.list?.() || [];
  if (!jobs.length) return '';
  return `Scheman:\n${jobs.map((j) => `- ${j.display || j.when} → ${String(j.task).slice(0, 60)}`).join('\n')}`;
}
