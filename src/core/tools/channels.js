/**
 * MAJIN W8 — channel.send: one honest tool out to Discord/Slack/Matrix/Webhook/Email.
 * risk='exec' → external comms always go through the approval gate.
 */
import { def } from './registry.js';
import { journal } from '../browser.js';
import { CHANNELS_OUT } from '../channels/send.js';

export const channelTools = [
  def({
    name: 'channel.send',
    required: ['channel', 'text'], // url/subject/to/embeds/blocks depend on the selected channel
    group: 'channels',
    risk: 'exec',
    desc: 'Send a message to a configured outbound channel (discord/slack/matrix/email/webhook). Missing credentials NEVER pretend: you get a not_configured diagnosis instead. Configure under channels.<name>.* in majin config.',
    params: {
      channel: 'string which channel — discord|slack|matrix|email|webhook',
      to: 'string target — Discord channel ID, Slack channel, Matrix room or email address (optional, may be configured)',
      url: 'string webhook URL (only for channel="webhook", optional for all other channels)',
      subject: 'string email subject (optional)',
      text: 'string the message body (required)',
      embeds: 'object: discord embeds array (optional, passed through)',
      blocks: 'string: JSON-encoded slack blocks (optional)',
      dryRun: 'string "true" = build and return the exact outgoing request body without sending [true|false] (optional)',
    },
    examples: ['channel.send({channel:"discord", to:"1234567890123456", text:"build complete", dryRun:"true"})'],
    async run({ channel, to, url, subject = '', text = '', embeds, blocks, dryRun }, ctx) {
      const session = ctx.session || 'default';
      journal.guard(session, `channel.send:${String(channel).slice(0, 20)}`);
      const kind = String(channel || '').toLowerCase();
      const fn = CHANNELS_OUT[kind];
      if (!fn) return { ok: false, error: { code: 'bad_channel', message: `channel "${channel}" unknown — available: ${Object.keys(CHANNELS_OUT).join(', ')}` } };
      if (!String(text || '').trim() && kind !== 'email') return { ok: false, error: { code: 'bad_input', message: 'empty message — nothing sent' } };
      if (String(dryRun) === 'true') {
        const preview = {
          discord: { url: `https://discord.com/api/v10/channels/${to || '<cfg>'}/messages`, body: { content: String(text).slice(0, 1900) } },
          slack: { url: 'https://slack.com/api/chat.postMessage', body: { channel: to || '<cfg>', text: String(text).slice(0, 3000) } },
          matrix: { url: '<homeserver>/_matrix/client/v3/rooms/…/send/m.room.message/<txn>', body: { msgtype: 'm.text', body: String(text).slice(0, 8000) } },
          email: { url: '<relayUrl>', body: { to, subject, text: String(text).slice(0, 200) + '…' } },
          webhook: { url: url || '<url>', body: { payload: '<object>', signature: 'sha256=… (when secret set)' } },
        };
        return { ok: true, result: `DRY-RUN ${kind}: ${JSON.stringify(preview[kind] || {})}`, meta: { preview: preview[kind] || null }, summary: `dry-run ${kind}` };
      }
      let res;
      if (kind === 'discord') res = await fn(ctx.cfg, { channelId: to, text, embeds: embeds || null });
      else if (kind === 'slack') res = await fn(ctx.cfg, { channel: to, text, blocks: blocks ? JSON.parse(blocks) : null });
      else if (kind === 'matrix') res = await fn(ctx.cfg, { room: to, text });
      else if (kind === 'email') res = await fn(ctx.cfg, { to, subject, text });
      else res = await fn(ctx.cfg, { url: url || ctx.cfg.get('channels.webhook.url'), secret: ctx.cfg.get('channels.webhook.secret'), payload: { text, source: 'majin' }, headersExtra: {} });
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, result: `${kind} sent${res.messageId ? ' (message ' + res.messageId + ')' : res.ts ? ' (ts ' + res.ts + ')' : res.eventId ? ' (event ' + res.eventId + ')' : ''}`, meta: res, summary: `${kind} → ok (${res.status})` };
    },
  }),
];
