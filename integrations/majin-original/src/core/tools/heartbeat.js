/**
 * MAJIN W9 heartbeat — control + honest status via majin.heartbeat tool.
 */
import { def } from './registry.js';
import { journal } from '../browser.js';
import { VERSION, Heartbeat } from '../heartbeat.js';

let INSTANCE = null;
function ensure(ctx) {
  const ws = ctx.cfg.get('workspace') || process.cwd();
  if (!INSTANCE || INSTANCE.ws !== ws) {
    INSTANCE?.stop();
    INSTANCE = new Heartbeat({
      workspaceDir: ws,
      cfg: ctx.cfg,
      tickMs: Number(ctx.cfg.get('heartbeat.tickSec') || 900) * 1000,
      minGapMs: Number(ctx.cfg.get('heartbeat.minGapSec') || 300) * 1000,
    });
    if (ctx.cfg.get('heartbeat.autoStart') !== false) INSTANCE.start();
  }
  return INSTANCE;
}

export const heartbeatTools = [
  def({
    name: 'majin.heartbeat',
    group: 'meta',
    // 'net' is not a V1 risk level (the valid set is read/write/exec/destructive),
    // so the guard could not classify this tool. It changes its own stored
    // settings and can deliver a digest, so 'write' is the honest level: it runs
    // without a prompt in the default mode, and strict mode still holds it.
    risk: 'write',
    desc: 'W9 heartbeat: status/enable/disable/tick (force a digest of accumulated real events)/test (dry-run the alert text exactly as it would be sent). Only real bus events alert; missing channels never pretend.',
    params: {
      action: 'string: status | enable | disable | tick | test. optional (default: status) [status|enable|disable|tick|test]',
      event: 'string: for action=test — a synthetic test event name (optional)',
    },
    examples: ['majin.heartbeat({action:"status"})', 'majin.heartbeat({action:"tick"})'],
    async run({ action = 'status', event }, ctx) {
      const session = ctx.session || 'default';
      journal.guard(session, `majin.heartbeat:${String(action).slice(0, 12)}`);
      const hb = ensure(ctx);
      const act = String(action).toLowerCase();
      if (act === 'status') return { ok: true, result: JSON.stringify(hb.status(), null, 2), summary: `heartbeat ${hb.status().running ? 'on' : 'off'}` };
      if (act === 'enable') { hb.autoStart = true; hb.resume(); return { ok: true, result: `heartbeat running (tick ${hb.tickMs / 1000}s, silent unless real events)`, summary: 'on' }; }
      if (act === 'disable') { hb.stop(); return { ok: true, result: 'heartbeat stopped (no proactive alerts — you hear nothing until re-enabled)', summary: 'off' }; }
      if (act === 'test') { const r=event?{ok:true,sent:false,dryRun:true,synthetic:true,text:hb.digestText([{event:String(event),detail:{message:'Synthetic preview only; no event was queued.'}}])}:await hb.tick({dryRun:true});return {ok:true,result:JSON.stringify(r,null,2),summary:'dry-run'}; }
      if (act === 'tick') { const r = await hb.tick(); return { ok: true, result: JSON.stringify(r, null, 2), summary: r.sent ? `sent (${r.count} events)` : 'held' }; }
      return { ok: false, error: { code: 'bad_input', message: 'action must be status|enable|disable|tick|test' } };
    },
  }),
];
