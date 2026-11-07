/**
 * MAJIN — schemaläggning.
 * Ett jobb = { when, task, deliver }.  "07:30 daily", "every 30m", "10:00 mån",
 * eller femfältscron (0/15 min m å man). Cron parsas här — ingen dependency.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dirs } from './paths.js';
import { bus } from './log.js';

const FILE = path.join(dirs.root, 'schedule.json');
const CRON_NAMES = { daily: '0 0 * * *', hourly: '0 * * * *', weekly: '0 0 * * 1', monthly: '0 0 1 * *' };

export function parseWhen(input) {
  const raw = String(input || '').trim();
  if(raw.length>500)throw new Error('schedule expression exceeds 500 characters');
  const s = raw.toLowerCase().replace(/\s+/g, ' ');
  if (CRON_NAMES[s]) return { kind: 'cron', spec: CRON_NAMES[s], display: s };
  const every = /(?:^|\s)(?:varje|var|every)\s+(\d+)\s*(s|sec|second|seconds|sek|sekund|sekunder|m|min|minute|minutes|minuter|h|hour|hours|tim|timme|timmar|d|day|days|dag|dagar)\b/.exec(s);
  if (every) {
    const n = Number(every[1]);
    const unit = { s: 1000, sec:1000, second:1000, seconds:1000, sek: 1000, sekund: 1000, sekunder: 1000, m: 60000, min: 60000, minute:60000, minutes:60000, minuter: 60000, h: 3600000, hour:3600000, hours:3600000, tim: 3600000, timme: 3600000, timmar: 3600000, d: 86400000, day:86400000, days:86400000, dag: 86400000, dagar: 86400000 }[every[2]];
    if (!Number.isSafeInteger(n * unit) || n * unit < 1000 || n * unit > 8640000000000000) throw new Error(`invalid interval: "${raw}"`);
    const label = unit === 60000 ? ' min' : unit === 3600000 ? ' h' : unit === 86400000 ? ' dag' : ' s';
    return { kind: 'every', everyMs: n * unit, display: `var ${n}${label}` };
  }
  const at = /^(?:(?:kl|at|on) )?(\d{4}-\d{2}-\d{2})[t ](\d{1,2}):(\d{2})$/.exec(s);
  if (at) {
    const t = new Date(`${at[1]}T${String(at[2]).padStart(2, '0')}:${at[3]}:00`).getTime();
    const date=new Date(t), [year,month,day]=at[1].split('-').map(Number);
    if (!Number.isFinite(t) || date.getFullYear()!==year || date.getMonth()+1!==month || date.getDate()!==day || date.getHours()!==Number(at[2]) || date.getMinutes()!==Number(at[3])) throw new Error(`invalid date: ${raw}`);
    return { kind: 'at', at: t, display: `kl ${at[1]} ${at[2]}:${at[3]}` };
  }
  const clock = /^(\d{1,2}):(\d{2})(\s*(daily|varje dag|dagligen|every day|om dagen))?$/.exec(s);
  if (clock) {
    const h = Number(clock[1]);
    const m = Number(clock[2]);
    if (h > 23 || m > 59) throw new Error(`orimlig klocktid: ${raw}`);
    return { kind: 'cron', spec: `${m} ${h} * * *`, display: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} varje dag` };
  }
  const dayTime = /^(\d{1,2}):(\d{2})\s+(\S+)$/.exec(s);
  if (dayTime) {
    const dayNames = { sun: 0, sön: 0, mon:1, man: 1, mån: 1, tis: 2, tue: 2, ons: 3, wed: 3, tor: 4, tors: 4, thu: 4, fre: 5, fri: 5, lör: 6, sat: 6 };
    const key = String(dayTime[3]).slice(0, 3).toLowerCase();
    const dow = dayNames[key];
    const h = Number(dayTime[1]);
    const m = Number(dayTime[2]);
    if (h <= 23 && m <= 59 && dow !== undefined) return { kind: 'cron', spec: `${m} ${h} * * ${dow}`, display: `${dayTime[1]}:${dayTime[2]} ${dayTime[3]}` };
  }
  const cron = s.split(/\s+/);
  if (cron.length === 5 && parseCron(cron.join(' '))) return { kind: 'cron', spec: cron.join(' '), display: cron.join(' ') };
  throw new Error(`could not parse "${raw}" — use "07:30 daily", "every 30m", "10:00 mån", "2026-01-01 09:00" or cron "0/15 * * * *"`);
}

export function nextRun(spec, from = Date.now()) {
  if(!Number.isFinite(from))throw new Error('invalid schedule clock');
  if (spec.kind === 'every') {
    if(!Number.isSafeInteger(spec.everyMs) || spec.everyMs<1000 || !Number.isFinite(new Date(from+spec.everyMs).getTime()))throw new Error('invalid schedule interval');
    return from + spec.everyMs;
  }
  if (spec.kind === 'at') {
    if(!Number.isFinite(spec.at) || !Number.isFinite(new Date(spec.at).getTime()))throw new Error('invalid schedule date');
    return spec.at > from ? spec.at : null;
  }
  return nextCron(spec.spec, from);
}

const CRON_FIELD = (field, min, max) => {
  const set = new Set();
  if(String(field).length>100)return null;
  for (const part of String(field).split(',')) {
    const m = /^\*(?:\/(\d+))?$|^(\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return null;
    if (m[0].startsWith('*')) {
      const step = Number(m[1] || 1);
      if(!Number.isSafeInteger(step) || step<1)return null;
      for (let v = min; v <= max; v += step) set.add(v);
    } else {
      const a = Number(m[2]);
      const b = m[3] ? Number(m[3]) : m[4] ? max : a;
      const step = Number(m[4] || 1);
      if(!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(step) || a<min || b>max || a>b || step<1)return null;
      for (let v = a; v <= b; v += step) set.add(v);
    }
  }
  return set;
};

export function cronMatch(spec, date) {
  const fields=parseCron(spec);
  return fields ? matchCron(fields,date) : false;
}

function parseCron(spec) {
  if(String(spec).length>500)return null;
  const parts = String(spec).trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const fields=parts.map((p,i)=>CRON_FIELD(p,[0,0,1,1,0][i],[59,23,31,12,6][i]));
  return fields.every(Boolean) ? fields : null;
}
function matchCron([mi,ho,dom,mo,dow],date) {
  return mi.has(date.getMinutes()) && ho.has(date.getHours()) && dom.has(date.getDate()) && mo.has(date.getMonth() + 1) && dow.has(date.getDay());
}

function nextCron(spec, from) {
  const fields=parseCron(spec);
  if(!fields)throw new Error('invalid cron schedule');
  const d = new Date(from);
  d.setSeconds(0, 0);
  for (let i = 0; i < 60 * 24 * 400; i += 1) {
    d.setMinutes(d.getMinutes() + 1);
    if (matchCron(fields, d)) return d.getTime();
  }
  return null;
}

export class Scheduler {
  constructor(cfg, { runTask, file = FILE, now = () => Date.now(), resumeReadOnlyOnBoot = false }) {
    this.cfg = cfg;
    this.runTask = runTask;
    this.file=path.resolve(file);
    this.now=now;
    this.jobs = load(this.file,this.now());
    this.timer = null;
    this.enabled = cfg.get('schedule.enabled') !== false;
    this.running = new Set();
    let recovered=false;
    for(const job of this.jobs)if(job.running===true){
      job.running=false;job.lastStatus='interrupted';
      job.history=[...(Array.isArray(job.history)?job.history:[]),{runId:job.runId,at:new Date(this.now()).toISOString(),status:'interrupted'}].slice(-50);
      if(resumeReadOnlyOnBoot && job.readOnly===true)job.nextRun=this.now();else job.paused=true;
      recovered=true;
    }
    if(recovered)this.save();
  }

  list() {
    return this.jobs.map((j) => ({ ...j, nextRunHuman: j.nextRun ? new Date(j.nextRun).toLocaleString('sv-SE') : null }));
  }

  add({ name, when, task, deliver = 'silent', model = null, readOnly = null, metadata = null, maxRuns = null }) {
    if(maxRuns!==null && (!Number.isSafeInteger(maxRuns)||maxRuns<1||maxRuns>10000))throw new Error('maxRuns must be between 1 and 10000');
    const spec = parseWhen(when);
    const job = {
      id: `j-${crypto.randomUUID()}`,
      name: name || String(task).slice(0, 48),
      when: spec.display,
      spec,
      task,
      deliver,
      readOnly: readOnly == null ? Boolean(this.cfg.get('schedule.readOnlyDefault')) : Boolean(readOnly),
      model,
      metadata,
      maxRuns,
      runCount: 0,
      createdAt: new Date().toISOString(),
      lastRun: null,
      lastStatus: null,
      nextRun: nextRun(spec,this.now()),
      paused: false,
    };
    this.jobs.push(job);
    try { this.save(); } catch(error) { this.jobs.pop(); throw error; }
    this.arm();
    bus.info('schedule.add', { id: job.id, when: job.when });
    return { ...job, nextRunHuman: job.nextRun ? new Date(job.nextRun).toLocaleString('sv-SE') : null };
  }

  remove(id) {
    const previous=this.jobs;
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.id !== id && j.name !== id);
    try { this.save(); } catch(error) { this.jobs=previous; throw error; }
    this.arm();
    return this.jobs.length < before;
  }

  update(id, changes) {
    const j=this.jobs.find(x=>x.id===id);
    if(!j)throw new Error('unknown job');
    if(this.running.has(id))throw new Error('pause/cancel the running task before editing');
    const previous=structuredClone(j);
    try{
      if(changes.when!==undefined){j.spec=parseWhen(changes.when);j.when=j.spec.display;j.nextRun=nextRun(j.spec,this.now());}
      for(const key of ['name','task','metadata'])if(changes[key]!==undefined)j[key]=structuredClone(changes[key]);
      if(changes.maxRuns!==undefined){if(!Number.isSafeInteger(changes.maxRuns)||changes.maxRuns<1||changes.maxRuns>10000)throw new Error('invalid run budget');j.maxRuns=changes.maxRuns;}
      this.save();
    }catch(error){Object.keys(j).forEach(k=>delete j[k]);Object.assign(j,previous);throw error;}
    this.arm();return structuredClone(j);
  }

  setPaused(id, paused) {
    const j = this.jobs.find((x) => x.id === id || x.name === id);
    if (!j) return false;
    const previous={paused:j.paused,nextRun:j.nextRun};
    j.paused = paused;
    if (!paused) j.nextRun = nextRun(j.spec,this.now());
    try { this.save(); } catch(error) { Object.assign(j,previous); throw error; }
    this.arm();
    return true;
  }

  async runNow(id) {
    const j = this.jobs.find((x) => x.id === id || x.name === id);
    if (!j) return { error: `unknown job ${id}` };
    return this.fire(j, { manual: true });
  }

  save() {
    const temporary=this.file+'.tmp-'+crypto.randomUUID();
    try {
      fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});
      const descriptor=fs.openSync(temporary,'wx',0o600);
      try {fs.writeFileSync(descriptor,JSON.stringify(this.jobs,null,1));fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
      fs.renameSync(temporary,this.file);
    } catch (err) {
      bus.warn('schedule.save_failed', { error: err.message });
      throw err;
    } finally {
      try { fs.unlinkSync(temporary); } catch(error) { if(error.code!=='ENOENT')bus.warn('schedule.temp_cleanup_failed',{error:error.message}); }
    }
  }

  arm() {
    if (this.timer) clearTimeout(this.timer);
    if (!this.enabled) return;
    const soon = this.jobs.filter((j) => !j.paused && j.nextRun).reduce((a, b) => (a && a.nextRun <= b.nextRun ? a : b), null);
    if (!soon) return;
    const wait = Math.max(500, Math.min(soon.nextRun - this.now(), 2 ** 31 - 1));
    this.timer = setTimeout(() => void this.tick().catch(error=>{this.stop();bus.error('schedule.stopped',{error:error.message});}), wait);
    this.timer.unref?.();
  }

  async tick() {
    const now = this.now();
    for (const j of this.jobs) {
      if (j.paused || !j.nextRun || j.nextRun > now || this.running.has(j.id)) continue;
      await this.fire(j);
    }
    this.arm();
  }

  async fire(j, { manual = false } = {}) {
    if(this.running.has(j.id))return {error:'job already running',code:'already_running'};
    if(j.maxRuns!=null && (j.runCount||0)>=j.maxRuns){j.paused=true;this.save();return {error:'run budget exhausted',code:'run_budget'};}
    this.running.add(j.id);
    const previous={lastRun:j.lastRun,running:j.running,runId:j.runId,runCount:j.runCount};
    j.lastRun = new Date(this.now()).toISOString();j.running=true;j.runId=crypto.randomUUID();
    j.runCount=(j.runCount||0)+1;
    // A failed start checkpoint must never dispatch an unrecorded action.
    try{this.save();}catch(error){Object.assign(j,previous);this.running.delete(j.id);throw error;}
    try {
      const res = await this.runTask({ input: j.task, session: `schedule:${j.id}`, source: { type: 'schedule', job: j.name }, deliver: j.deliver, model: j.model, readOnly: Boolean(j.readOnly),jobId:j.id,runId:j.runId });
      j.lastStatus = res.error ? `error: ${res.error}` : res.status || 'ok';
      if(res.status==='awaiting_approval')j.paused=true;
      j.lastSummary = String(res.text || '').slice(0, 400);
      bus.info('schedule.done', { id: j.id, status: j.lastStatus, chars: (res.text || '').length });
      return res;
    } catch (err) {
      j.lastStatus = `error: ${err.message}`;
      bus.error('schedule.failed', { id: j.id, error: err.message });
      return { error: err.message };
    } finally {
      this.running.delete(j.id);j.running=false;
      if(j.maxRuns!=null && j.runCount>=j.maxRuns)j.paused=true;
      j.history=[...(Array.isArray(j.history)?j.history:[]),{runId:j.runId,at:new Date(this.now()).toISOString(),status:j.lastStatus,summary:j.lastSummary||null}].slice(-50);
      j.nextRun = manual ? j.nextRun : nextRun(j.spec,this.now());
      this.save();
    }
  }

  start() {
    if(this.interval)clearInterval(this.interval);
    this.enabled = true;
    this.arm();
    this.interval = setInterval(() => void this.tick().catch(error=>{this.stop();bus.error('schedule.stopped',{error:error.message});}), 30000);
    this.interval.unref?.();
    return this.jobs.length;
  }

  stop() {
    this.enabled = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
    this.timer=null;this.interval=null;
  }
}

function load(file,now) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if(!Array.isArray(raw))throw new Error('schedule store must contain an array');
    const ids=new Set();
    return raw.map((j) => {
      if(!j || typeof j!=='object' || typeof j.id!=='string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(j.id) || ids.has(j.id))throw new Error('invalid or duplicate schedule identifier');
      ids.add(j.id);
      if(j.maxRuns!=null&&(!Number.isSafeInteger(j.maxRuns)||j.maxRuns<1||j.maxRuns>10000))throw new Error('invalid stored run budget');
      if(j.runCount!=null&&(!Number.isSafeInteger(j.runCount)||j.runCount<0))throw new Error('invalid stored run count');
      if(j.nextRun!==undefined && j.nextRun!==null && !Number.isFinite(j.nextRun))throw new Error('invalid next schedule time');
      const spec=j.spec || parseWhen(j.when);
      nextRun(spec,now); // Reject corrupt/unsafe expressions before any timer is armed.
      return {...j,spec,nextRun:j.nextRun===undefined?nextRun(spec,now):j.nextRun};
    });
  } catch(error) {
    if(error.code==='ENOENT')return [];
    throw new Error('Cannot load schedule store: '+error.message);
  }
}
