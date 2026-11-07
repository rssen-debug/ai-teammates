/**
 * MAJIN W9 HEARTBEAT — proactive, honest, rate-limited alerting.
 *
 * Watches the bus for events that matter (errors, stalls, turn timeouts,
 * approvals waiting, scheduled runs, budget warnings), aggregates them into
 * bounded digests and surfaces them through: (1) the desktop UI stream,
 * (2) optional outbound channel (discord/slack/... via channels/send).
 *
 * Ground rules (Master Directive W9: "proactive — warn BEFORE failure"):
 *  - ONLY real events — never invented health.
 *  - Rate-limited + deduped + sized caps. Silence is the default state.
 *  - All sends go through approval-gated tools or the same channel senders
 *    with explicit config; missing config = honest 'no channel' note, not spam.
 *  - Everything measurable: state dir heartbeats/ with log + last-sent stamp.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { bus as globalBus } from './log.js';
import { CHANNELS_OUT } from './channels/send.js';
import { protectAuditFile } from '../v2/audit/permissions.js';

export const VERSION = 'majin-heartbeat/1';

const DEFAULT_WATCH = [
  'loop.turn_timeout', 'loop.repeat_block', 'loop.budget', 'loop.provider',
  'approval:request', 'scheduler.run.budget_blocked', 'exec.error',
  'research.*.failed', 'channels.*.error',
];

export class Heartbeat {
  constructor({
    workspaceDir,
    cfg = null,
    bus = globalBus,
    fetchFn = fetch,
    tickMs = 15 * 60_000,     /* 15 min default digest rhythm */
    minGapMs = 5 * 60_000,     /* spam protection: never outpace 5 min between two alerts */
    cap = 50,
    now = () => Date.now(),
    quietPatterns = DEFAULT_WATCH,
    deliverFn = null,
  } = {}) {
    this.ws = workspaceDir;
    this.cfg = cfg;
    this.bus = bus;
    this.fetchFn = fetchFn;
    this.deliverFn = deliverFn;
    this.tickMs = tickMs;
    this.minGapMs = minGapMs;
    this.cap = cap;
    this.now = now;
    this.queue = [];           /* pending event digests */
    this.seen = new Map();     /* dedupe: key -> at */
    this.lastSentAt = null;
    this.off = [];
    this.timer = null;
    this._patterns = quietPatterns;
    this.lastError=null;this.deliveryFailures=0;this.deliveryPaused=false;this.busy=false;
    try{
      const state=JSON.parse(fs.readFileSync(this.statePath(),'utf8'));
      if(state.queue!==undefined){
        if(!Array.isArray(state.queue)||state.queue.length>cap||!Array.isArray(state.seen)||state.seen.length>500||!state.queue.every(e=>typeof e.id==='string'&&typeof e.event==='string')||!state.seen.every(e=>Array.isArray(e)&&typeof e[0]==='string'&&Number.isFinite(e[1])))throw Error('Invalid durable heartbeat state');
        this.queue=state.queue;this.seen=new Map(state.seen);
        if(state.lastSentAt!==null&&!Number.isFinite(state.lastSentAt))throw Error('Invalid heartbeat delivery clock');
        this.lastSentAt=state.lastSentAt;this.deliveryFailures=Number(state.deliveryFailures)||0;this.deliveryPaused=state.deliveryPaused===true;
      }
    }catch(error){if(error.code!=='ENOENT')throw error;}
  }

  dir() { return path.join(this.ws, 'heartbeats'); }
  statePath() { return path.join(this.dir(), 'state.json'); }
  logPath() { return path.join(this.dir(), 'log.jsonl'); }

  matches(pattern, event) {
    if (!pattern) return false;
    const escaped=String(pattern).split('*').map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*');
    return new RegExp('^'+escaped+'$').test(event);
  }

  start() {
    if (this.timer || this._noAudio) return this;
    fs.mkdirSync(this.dir(), { recursive: true });
    /* bus.on() only matches exact types — wildcard patterns live here, on top
       of the raw sub() stream, so 'research.*.failed' style config actually
       works instead of silently dead-listening. */
    const off = this.bus.sub((ev) => {
      const t = String(ev?.type || '');
      for (const pat of this._patterns) {
        if (this.matches(pat, t)) { this.ingest(t, ev); return; }
      }
    });
    this.off.push(off);
    this.timer = setInterval(() => void this.tick().catch(() => {}), this.tickMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    this.off.forEach((fn) => { try { fn?.(); } catch { /* */ } });
    this.off = [];
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    return this;
  }

  /* Deduped, hop-counted event ingestion — nothing stored that is not
     a real bus event with a real payload. */
  ingest(pattern, ev) {
    // Event-bus timestamps differ between identical events on a fast machine,
    // especially Windows. Deduplicate by semantic payload, not volatile clock
    // metadata. Keep the original event in the queue for accurate evidence.
    const stable = ev && typeof ev === 'object' ? { ...ev } : ev;
    if (stable && typeof stable === 'object') {
      delete stable.ts;
      delete stable.timestamp;
    }
    if(stable&&typeof stable==='object'){if(typeof stable.seq==='number'&&stable.id===stable.seq)delete stable.id;delete stable.seq;}
    const detail=stable&&typeof stable==='object'?Object.fromEntries(Object.entries(stable).sort(([a],[b])=>a.localeCompare(b)).slice(0,20).map(([k,v])=>[k,typeof v==='string'?v.slice(0,512):typeof v==='number'||typeof v==='boolean'||v===null?v:'[structured detail omitted]'])):String(stable??'').slice(0,512);
    const key = `${pattern}:${JSON.stringify(detail)}`;
    const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
    const prevAt = this.seen.get(hash);
    if (prevAt !== undefined && this.now() - prevAt < this.minGapMs) return false;
    this.seen.set(hash, this.now());
    if (this.seen.size > 500) { const first = this.seen.keys().next().value; if (first) this.seen.delete(first); }
    this.queue.push({id:crypto.randomUUID(),at:new Date(this.now()).toISOString(),event:String(pattern).slice(0,120),detail});
    if (this.queue.length > this.cap) this.queue = this.queue.slice(-this.cap);
    this.saveState();
    return true;
  }

  /* Compose the user-facing alert text (bounded; never token-hungry). */
  digestText(entries) {
    const lines = entries.slice(0, 8).map((e) => {
      const label = String(e.event);
      const m = e.detail?.message || e.detail?.error || e.detail?.text || '';
      return `• ${label}${m ? ` — ${String(m).slice(0, 140)}` : ''}`;
    });
    const more = entries.length > 8 ? `\n  … +${entries.length - 8} more` : '';
    return `MAJIN heartbeat: ${entries.length} notable event(s) since last check-in\n${lines.join('\n')}${more}`;
  }

  async deliver(text, { dryRun = false, digestId = null, entries = [] } = {}) {
    const targets = (() => {
      const out = [];
      const outPref = this.cfg?.get?.('heartbeat.channels');
      if (Array.isArray(outPref) && outPref.length) {
        for (const ch of outPref) if (CHANNELS_OUT[ch]) out.push(ch);
      }
      return out;
    })();
    if (dryRun) return { ok: true, dryRun: true, targets, text: String(text).slice(0, 600) };
    if(this.deliverFn)return this.deliverFn(text,{digestId,entries});
    if (!targets.length) {
      /* Honest: no channel configured = desktop-only via bus stream. */
      this.bus.info('heartbeat.alert', { channels: 'desktop-only', textLength: String(text).length });
      return { ok: true, channels: 'desktop-only', textLength: String(text).length };
    }
    const results = [];
    for (const ch of targets) {
      const fn = CHANNELS_OUT[ch];
      try {
        const r = await fn(this.cfg, { channelId: this.cfg.get(`channels.${ch}.channelId`) || this.cfg.get(`channels.${ch}.channel`) || this.cfg.get(`channels.${ch}.room`), channel: this.cfg.get(`channels.${ch}.channel`), room: this.cfg.get(`channels.${ch}.room`), text }, this.fetchFn);
        results.push({ ch, ok: r.ok || false, status: r.status ?? null, error: r.error?.message ?? null });
      } catch (e) {
        results.push({ ch, ok: false, error: String(e?.message || e).slice(0, 160) });
      }
    }
    return { ok: results.some((r) => r.ok) || !results.length, channels: 'configured', results };
  }

  persist(entry) {
    try {
      this.saveState(entry.at);
      fs.appendFileSync(this.logPath(),JSON.stringify(entry)+'\n',{mode:0o600});
    }catch(error){this.lastError='Heartbeat persistence failed; queued state may be incomplete.';throw error;}
  }

  saveState(lastAt=new Date(this.now()).toISOString()){
    const temporary=this.statePath()+'.'+crypto.randomUUID()+'.tmp';
    try{
      fs.mkdirSync(this.dir(),{recursive:true,mode:0o700});
      if(!this.privateReady){protectAuditFile(this.dir());this.privateReady=true;}
      const fd=fs.openSync(temporary,'wx',0o600);
      try{fs.writeFileSync(fd,JSON.stringify({version:VERSION,lastAt,queue:this.queue,queued:this.queue.length,seen:[...this.seen],lastSentAt:this.lastSentAt,deliveryFailures:this.deliveryFailures,deliveryPaused:this.deliveryPaused}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fs.renameSync(temporary,this.statePath());this.lastError=null;
    }catch(error){this.lastError='Heartbeat persistence failed; queued state may be incomplete.';throw error;}
    finally{try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')this.lastError='Heartbeat temporary-state cleanup failed.';}}
  }

  resume(){this.deliveryPaused=false;this.deliveryFailures=0;this.saveState();return this.start();}
  discard(predicate){const kept=this.queue.filter(entry=>!predicate(entry));if(kept.length!==this.queue.length){this.queue=kept;this.saveState();}}

  async tick(options={}){
    if(this.busy)return {ok:true,sent:false,reason:'digest delivery already running'};
    this.busy=true;
    try{return await this.tickOnce(options);}finally{this.busy=false;}
  }

  /* One tick = check rate + newer entries; send if anything real accumulated. */
  async tickOnce({ force = false, dryRun = false } = {}) {
    const since = [...this.queue];
    if(dryRun){const text=this.digestText(since);return {ok:true,sent:false,dryRun:true,text,count:since.length,delivery:await this.deliver(text,{dryRun:true})};}
    if(this.deliveryPaused)return {ok:false,sent:false,reason:'delivery paused after three failures; explicit resume required',held:since.length};
    if (!since.length) {
      const quiet = { ok: true, sent: false, reason: 'nothing real accumulated — silence is the default' };
      this.persist({ at: new Date(this.now()).toISOString(), tick: true, sent: false });
      return quiet;
    }
    const gap = this.now() - (this.lastSentAt??0);
    if (!force && this.lastSentAt!==null && gap < this.minGapMs) {
      const held = { ok: true, sent: false, reason: `rate-limited, ${Math.round((this.minGapMs - gap) / 1000)}s left of the mandatory quiet`, held: since.length };
      this.persist({ at: new Date(this.now()).toISOString(), tick: true, sent: false, held: since.length });
      return held;
    }
    const text = this.digestText(since);
    const digestId=crypto.createHash('sha256').update(JSON.stringify(since)).digest('hex');
    let delivery;
    try{delivery=await this.deliver(text,{digestId,entries:since});}catch{delivery={ok:false,channels:'failed'};}
    if(!delivery?.ok){this.deliveryFailures++;if(this.deliveryFailures>=3)this.deliveryPaused=true;this.persist({at:new Date(this.now()).toISOString(),tick:true,sent:false,count:since.length,delivery:{ok:false}});return {ok:false,sent:false,text,delivery,count:since.length};}
    const delivered=new Set(since.map(e=>e.id));this.queue=this.queue.filter(e=>!delivered.has(e.id));this.deliveryFailures=0;
    this.lastSentAt = this.now();
    this.persist({ at: new Date(this.now()).toISOString(), tick: true, sent: true, count: since.length, delivery: { ok: delivery.ok, channels: delivery.channels } });
    return { ok: true, sent: true, text, delivery, count: since.length };
  }

  status() {
    let state = null;
    try { state = JSON.parse(fs.readFileSync(this.statePath(), 'utf8')); } catch { state = null; }
    return {
      running: Boolean(this.timer),
      queued: this.queue.length,
      lastSentAt: this.lastSentAt ? new Date(this.lastSentAt).toISOString() : null,
      tickMs: this.tickMs,
      minGapMs: this.minGapMs,
      watch: this._patterns,
      persisted: state,
      version: VERSION,
      deliveryPaused:this.deliveryPaused,deliveryFailures:this.deliveryFailures,lastError:this.lastError,
    };
  }
}
