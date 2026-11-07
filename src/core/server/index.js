/**
 * MAJIN — server.
 * Bara node:http. Inget ramverk. Samma port serverar UI:et, API:t, SSE-flödet
 * och WhatsApp-webhooken. Token låser dörren; webbläsarfönstret får den automatiskt.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bus } from '../log.js';
import { dirs, safeJoin } from '../paths.js';
import { listChats, activity as chatActivity, rename as chatRename, setArchived as chatSetArchived, deleteChat, ensureChat as chatEnsure, sanitizeId as chatSanitizeId } from '../chats.js';
import { readHistory } from '../context.js';
import { tasks, fileLocks, eta } from '../tasks.js';
import { parseTaskCommand, statusText } from '../intent-tasks.js';
import { analyzeMetaAccount, marketingStatus, checkMarketingConfig, wantsMarketingSetup } from '../marketing.js';
import { channelStatus } from '../marketing-channels.js';
import { parseIntent } from '../routes.js';
import { PRESETS, needsKeyFor } from '../presets.js';
import { complete, explainError } from '../provider/chat.js';
import { discoverModels } from '../provider/catalog.js';
import { importPricing } from '../pricing.js';

const SELF_DIR = (() => {
  try {
    if (typeof __dirname !== 'undefined') return __dirname;
  } catch {
    /* bundlad CJS */
  }
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
})();
const UI_CANDIDATES = [path.resolve(SELF_DIR, 'ui'), path.resolve(SELF_DIR, '../../ui'), path.join(path.dirname(process.execPath), 'ui'), path.resolve(process.cwd(), 'src/ui')];
const UI_DIR = UI_CANDIDATES.find((d) => fs.existsSync(path.join(d, 'index.html'))) || UI_CANDIDATES[0];
/* The Edge/Chrome --app window gets its TITLE BAR and TASKBAR icon from the
 * favicon served by this HTTP server, NOT from MAJIN-Setup.exe's icon.
 * Older releases served src/ui/logo.png while the installer used a separate
 * assets/majin.png -> .ico. That mismatch produced the white/black M shown in
 * Windows even when MAJIN's header had the pink logo. Use one canonical PNG.
 */
const BRAND_ICON_CANDIDATES = [
  path.resolve(UI_DIR, '../assets/majin.png'),       // dist/ui -> dist/assets
  path.resolve(UI_DIR, '../../assets/majin.png'),    // src/ui -> assets
  path.resolve(SELF_DIR, 'assets/majin.png'),
  path.join(path.dirname(process.execPath), 'assets', 'majin.png'),
];
const BRAND_ICON = BRAND_ICON_CANDIDATES.find((f) => fs.existsSync(f)) || null;
const MAX_BODY = 64 * 1024 * 1024;

/* ------------------------- deterministic fleet commands ------------------ */
function noStreamFlag(body, url) {
  return body.stream === false || body.stream === 'false'
    || ['false', '0'].includes(String(url.searchParams.get('stream') || '').toLowerCase());
}

/* A fleet command never touches the model: stop is an AbortController call,
   status is the registry, pauses/resumes/assists are follow-up turns into
   ALREADY-EXISTING sessions, so every context survives unbroken. Long turns
   run in the background; the dashboard (/api/tasks) is where you watch them. */
async function executeTaskCommand(cmd, { agent }) {
  const live = tasks.activeOldestFirst();
  switch (cmd.action) {
    case 'status':
      return { ok: true, action: 'status', text: statusText(live) };
    case 'stop': {
      if (!cmd.target.ok) return { ok: false, error: cmd.target.error, text: cmd.target.error };
      const t = cmd.target.task;
      agent.stop(t.session);
      tasks.stop(t.id);
      return { ok: true, action: 'stopped', task: t.id, text: `Agent ${t.id} stopped ("${t.input.slice(0, 60)}"). The others keep working.` };
    }
    case 'pause': {
      if (!cmd.target.ok) return { ok: false, error: cmd.target.error, text: cmd.target.error };
      const t = cmd.target.task;
      agent.stop(t.session);
      tasks.setStatus(t.id, 'paused');
      return { ok: true, action: 'paused', task: t.id, text: `Agent ${t.id} paused — its whole context is kept. Say "resume agent ${live.indexOf(t) + 1}" (or its id) to continue it.` };
    }
    case 'resume': {
      if (!cmd.target.ok) return { ok: false, error: cmd.target.error, text: cmd.target.error };
      const t = cmd.target.task;
      tasks.setStatus(t.id, 'running');
      agent.turn({ input: 'Continue from the step you were on when you paused. Do not restart from zero — the earlier context in this session is the shared state of work.', session: t.session, source: 'fleet-resume', aware: tasks.awareText({ excludeId: t.id }), onEvent: (ev) => tasks.event(t.id, ev.type, null) })
        .then((r) => tasks.setStatus(t.id, r.error ? 'error' : 'done'))
        .catch(() => tasks.setStatus(t.id, 'error'));
      return { ok: true, action: 'resuming', task: t.id, text: `Agent ${t.id} is working again from where it paused.` };
    }
    case 'assist': {
      if (!cmd.target.ok) return { ok: false, error: cmd.target.error, text: cmd.target.error };
      const t = cmd.target.task;
      let helpers;
      if (!cmd.helper.ok) {
        return { ok: false, error: cmd.helper.error, text: cmd.helper.error };
      } else if (cmd.helper.all) {
        helpers = live.filter((h) => h.id !== t.id); // "alla hjälpa X" / bare "hjälp X" = every other active agent
      } else {
        helpers = [cmd.helper.task];
      }
      helpers = helpers.filter((h) => h.id !== t.id);
      if (!helpers.length) return { ok: false, error: 'no helper available — only the target agent is running', text: 'no helper available — only the target agent is running' };
      const brief = `The user has asked you to HELP agent ${t.id} with its task: "${t.input}". That agent is already working on the whole. Take a concrete, separable part of it — divide the labour so nothing is done twice (the workspace is shared; the file locks stop duplicate writes, respecting them is your job too). Say at the start which part you take, then work.`;
      for (const h of helpers) {
        tasks.setStatus(h.id, 'running');
        agent.turn({ input: brief, session: h.session, source: 'fleet-assist', aware: tasks.awareText({ excludeId: h.id }), onEvent: (ev) => tasks.event(h.id, ev.type, null) })
          .then((r) => tasks.setStatus(h.id, r.error ? 'error' : 'done'))
          .catch(() => tasks.setStatus(h.id, 'error'));
      }
      return { ok: true, action: 'assist', task: t.id, helpers: helpers.map((h) => h.id), text: `${helpers.length === 1 ? 'Agent ' + helpers[0].id : helpers.length + ' agents'} is now helping ${t.id} with "${t.input.slice(0, 50)}".` };
    }
    default:
      return { ok: false, error: `unknown fleet action: ${cmd.action}`, text: `unknown fleet action: ${cmd.action}` };
  }
}
import { VERSION } from '../version.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.yar': 'text/plain; charset=utf-8',
};

export function createServer(rt) {
  const { cfg, agent, registry, memory, skills, usage, approvals, scheduler, channels, dataset } = rt;
  const pairs = new Map();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      bus.error('http.error', { url: req.url, error: err.message });
      if (!res.headersSent) json(res, 500, { ok: false, error: err.message, hint: err.hint || null });
      else res.end();
    });
  });

  /** SPA-djuplänk: /panel, /session/xyz … ger index.html, okända filer ger 404. */
  const wantsIndex = (pp) => pp === '/' || pp === '/index.html' || pp === '/app'
    || (!pp.startsWith('/api/') && !path.extname(pp) && !fs.existsSync(path.join(UI_DIR, pp.replace(/\.\./g, ''))));

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const token = String(cfg.get('server.token') || '');
    const peer = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    const authed = authOk(req, url, token, cfg, peer);

    res.setHeader('x-powered-by', 'MAJIN');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,authorization', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS' });
      return res.end();
    }

    /* ---------- publika ---------- */
    if (p === '/healthz') return json(res, 200, { ok: true, name: cfg.get('name'), version: VERSION, up: Math.round(process.uptime()) });
    if (p === '/api/hello') return json(res, 200, { ok: true, name: cfg.get('name'), version: VERSION, needToken: !authed, tokenOk: authed });

    /* WhatsApp Cloud-webhook (Meta verifierar med eget token, ingen MAJIN-token) */
    if (p === '/whatsapp' || p === '/api/webhook/whatsapp') {
      if (!channels) return json(res, 503, { ok: false, error: 'channels are not running' });
      if (req.method === 'GET') {
        const q = Object.fromEntries(url.searchParams);
        const v = channels.whatsapp.verifyWebhook(q);
        if (!v.ok) return text(res, 403, v.error || 'avvisad');
        return text(res, 200, String(v.challenge || ''));
      }
      const raw = (await readBody(req, 2 * 1024 * 1024)).toString('utf8');
      const secret = cfg.get('channels.whatsapp.cloud.appSecret');
      if (secret) {
        const sig = String(req.headers['x-hub-signature-256'] || '');
        const want = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
        if (!sig || sig !== want) return text(res, 403, 'bad signature');
      }
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return json(res, 400, { ok: false, error: 'the request body is not valid JSON' });
      }
      const r = channels.whatsapp.ingest(body);
      return json(res, 200, r.ok !== false ? { ok: true } : { ok: false });
    }

    if (p === '/api/keys/claim') {
      const code = String(url.searchParams.get('code') || '').toUpperCase();
      const hit = pairs.get(code);
      if (!hit || hit.expires < Date.now()) return json(res, 404, { ok: false, error: 'the code is invalid or expired' });
      pairs.delete(code);
      return json(res, 200, { ok: true, token });
    }

    if (!authed) {
      if (p === '/' || p === '/index.html') {
        return html(res, 200, `<!doctype html><meta charset=utf-8><title>MAJIN — key required</title>
<style>body{background:#04070a;color:#9fe8ff;font:15px/1.6 ui-monospace,Menlo,Consolas,monospace;display:grid;place-items:center;height:100vh;margin:0}
a{color:#fff}b{color:#fff}pre{background:#0a1420;padding:10px 14px;border:1px solid #14384d;border-radius:8px;color:#c9f5ff}</style>
<div><b>MAJIN</b> needs the one-time key.<br>Run <pre>majin window</pre> to open a window with the key baked in.<br>Or open <pre>http://${req.headers.host}/?t=${token}</pre> just this once.</div>`);
      }
      return json(res, 401, { ok: false, error: 'token required', hint: `open with ?t=${token} or send the header \"authorization: Bearer ${token}\"` });
    }

    /* ---------- UI + statiska ---------- */
    // A single image for the MAJIN header, Edge app-mode titlebar, taskbar,
    // shortcuts and EXE. Never serve the old src/ui/logo.png at this URL.
    if (p === '/logo.png') {
      if (!BRAND_ICON) return json(res, 404, { ok: false, error: 'MAJIN brand icon missing' });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store, max-age=0' });
      return fs.createReadStream(BRAND_ICON).pipe(res);
    }
    if (wantsIndex(p)) {
      const file = path.join(UI_DIR, 'index.html');
      if (!fs.existsSync(file)) return html(res, 200, '<pre>UI missing — run: npm run ui</pre>');
      const raw = fs.readFileSync(file, 'utf8').replace(/'__MAJIN_TOKEN__'/g, JSON.stringify(token)).replace(/'__MAJIN_VERSION__'/g, JSON.stringify(VERSION)).replace(/__MAJIN_FAVICON_VERSION__/g, VERSION).replace(/__MAJIN___/g, cfg.get('name') || 'MAJIN');
      res.setHeader('set-cookie', `majin=${token}; Path=/; SameSite=Lax`);
      return html(res, 200, raw);
    }
    if (!p.startsWith('/api/')) {
      const clean = p.replace(/\.\./g, '');
      const file = path.join(UI_DIR, clean);
      if (file.startsWith(UI_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
        return fs.createReadStream(file).pipe(res);
      }
      return json(res, 404, { ok: false, error: `not found: ${p}` });
    }

    /* ---------- state ---------- */
    if (p === '/api/state') return json(res, 200, rt.state({ includeTools: url.searchParams.get('tools') !== '0' }));
    /* the autopilot dashboard feed: who works on what, and who holds which
       file right now. Zero-LLM data, cheap enough to poll. */
    if (p === '/api/tasks') return json(res, 200, { ok: true, tasks: tasks.snapshot(), locks: fileLocks.heldList(), telemetry: eta.summary() });
    /* Credentials never become agent tool arguments or model-visible data.
       Existing MAJIN bearer auth is required above this point. */
    if (p === '/api/marketing/channel') {
      const state = () => channelStatus(cfg.get('marketing') || {});
      if (req.method === 'GET') return json(res, 200, {ok:true,channels:state()});
      if (req.method !== 'POST') return json(res,405,{ok:false,error:'method not allowed'});
      const body=await readJson(req);
      const platform=String(body.platform||'').toLowerCase();
      if(!['google','tiktok'].includes(platform))return json(res,400,{ok:false,error:'platform must be google or tiktok'});
      if(body.action!=='save' && body.action!=='disconnect')return json(res,400,{ok:false,error:'action must be save or disconnect'});
      const patch=body.action==='disconnect'?
        platform==='tiktok'?{advertiserId:'',accessToken:''}:{customerId:'',accessToken:'',developerToken:''}:
        platform==='tiktok'?
          {advertiserId:String(body.advertiserId||'').trim(),currency:String(body.currency||'').toUpperCase(),
            ...(body.accessToken?{accessToken:String(body.accessToken).trim()}: {})}:
          {customerId:String(body.customerId||'').trim(),currency:String(body.currency||'').toUpperCase(),
            loginCustomerId:String(body.loginCustomerId||'').trim(),
            ...(body.accessToken?{accessToken:String(body.accessToken).trim()}:{}),
            ...(body.developerToken?{developerToken:String(body.developerToken).trim()}: {})};
      if(body.action==='save'){
        if(!/^[A-Z]{3}$/.test(patch.currency))return json(res,422,{ok:false,error:'Use the currency shown in the ad account, e.g. SEK or USD.'});
        if(!/^[0-9]{3,25}$/.test(String(platform==='tiktok'?patch.advertiserId:patch.customerId)))return json(res,422,{ok:false,error:'Enter a valid numeric ad account ID.'});
        for(const key of ['accessToken','developerToken'])if(patch[key] && patch[key].length>8192)return json(res,422,{ok:false,error:'Credential is unexpectedly long.'});
      }
      const saved=cfg.patch({marketing:{[platform]:patch}},{source:'marketing.connect'});
      if(!saved.ok)return json(res,422,{ok:false,error:saved.errors.map(e=>e.msg).join('; ')});
      return json(res,200,{ok:true,channels:state(),note:'Credentials saved locally, but the platform has NOT yet verified this authorization. No ads changed.'});
    }
    if (p === '/api/marketing') {
      if (req.method === 'GET') return json(res, 200, { ok: true, ...marketingStatus(cfg) });
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
      const body = await readJson(req);
      if (body.action === 'analyze') {
        try {
          const r = await analyzeMetaAccount(cfg);
          return json(res, r.ok ? 200 : 422, r);
        } catch (e) {
          return json(res, 502, { ok: false, error: e.message });
        }
      }
      if (body.action === 'disconnect') {
        const result = cfg.patch({ marketing: { meta: { accessToken: '', accountId: '' } } }, { source: 'marketing.disconnect' });
        return json(res, result.ok ? 200 : 422, { ok: result.ok, ...marketingStatus(cfg) });
      }
      if (body.action !== 'save') return json(res, 400, { ok: false, error: 'action must be save, analyze or disconnect' });
      const cur = cfg.get('marketing') || {};
      const economics = {};
      for (const key of ['price','cogs','shipping','fees','refundRate','targetProfit','dailyCap']) economics[key] = Number(body.economics?.[key]);
      const meta = { accountId: String(body.accountId || ''), currency: String(body.currency || '').toUpperCase() };
      if (body.accessToken) meta.accessToken = String(body.accessToken).trim();
      const merged = { meta: { ...(cur.meta || {}), ...meta }, economics };
      const issues = checkMarketingConfig(merged);
      if (issues.length) return json(res, 422, { ok: false, error: issues.join(' ') });
      const saved = cfg.patch({ marketing: { meta, economics } }, { source: 'marketing.panel' });
      if (!saved.ok) return json(res, 422, { ok: false, error: saved.errors.map((e) => e.msg).join('; ') });
      return json(res, 200, { ok: true, ...marketingStatus(cfg) });
    }
    if (p === '/api/tasks/action' && req.method === 'POST') {
      /* card buttons (⏸/▶): pause runs through the same engine as the NL
         command; resume is the chat follow-up path client-side (streams onto
         the card for free) — the endpoint is the pause half + refusals. */
      const body2 = await readJson(req);
      const t = tasks.get(String(body2.task || ''));
      if (!t) return json(res, 200, { ok: false, error: 'unknown task: ' + (body2.task || '(none)') });
      if (body2.action === 'pause') {
        if (t.status !== 'running' && t.status !== 'waiting') {
          return json(res, 200, { ok: false, error: 'agent ' + t.id + ' is ' + t.status + ' — only running agents pause' });
        }
        return json(res, 200, await executeTaskCommand({ action: 'pause', target: { ok: true, task: t } }, { agent }));
      }
      if (body2.action === 'resume') {
        if (t.status !== 'paused') return json(res, 200, { ok: false, error: 'agent ' + t.id + ' is ' + t.status + ' — only paused agents resume' });
        return json(res, 200, await executeTaskCommand({ action: 'resume', target: { ok: true, task: t } }, { agent }));
      }
      return json(res, 200, { ok: false, error: 'unknown action: ' + JSON.stringify(body2.action || null) + ' (pause|resume)' });
    }
    if (p === '/api/update' && req.method === 'GET') {
      return json(res, 200, { ok: true, version: VERSION, update: rt.update.info, current: VERSION });
    }
    if (p === '/api/update' && req.method === 'POST') {
      const body = await readJson(req);
      const action = ['download', 'install'].includes(body.action) ? body.action : 'check';
      if (action === 'install') {
        const r = await rt.update.install({ dir: body.dir || undefined, url: body.url || undefined });
        // Exit the old runtime before Inno upgrades the executable. The
        // detached installer watchdog restarts the new process afterwards.
        if (r.ok) setTimeout(() => rt.shutdown('update').finally(() => process.emit('SIGTERM', 'SIGTERM')), 1200);
        return json(res, r.ok ? 200 : 502, { ok: r.ok, action, ...r, restarting: Boolean(r.ok) });
      }
      if (action === 'download') {
        const r = await rt.update.download({ dir: body.dir || undefined, url: body.url || undefined });
        return json(res, r.ok ? 200 : 502, { ok: r.ok, action, ...r });
      }
      const info = await rt.update.check({ force: body.force !== false });
      return json(res, 200, { ok: !info.error, action, update: info, error: info.error || null });
    }
    if (p === '/api/config' && req.method === 'GET') return json(res, 200, { ok: true, config: cfg.redacted(), file: cfg.file, diffReady: true });
    if (p === '/api/logs') return json(res, 200, { ok: true, events: bus.tail(Number(url.searchParams.get('n') || 200), Number(url.searchParams.get('after') || 0)) });
    if (p === '/api/usage') return json(res, 200, { ok: true, ...usage.summary(), routes: cfg.routeTable().length });
    if (p === '/api/memory' && req.method === 'GET') {
      const q = url.searchParams.get('q');
      return json(res, 200, { ok: true, facts: q ? memory.recall(q, 20) : memory.facts(), events: memory.recentEvents(25), stats: memory.stats() });
    }
    if (p === '/api/skills' && req.method === 'GET') return json(res, 200, { ok: true, skills: skills.list() });
    if (p === '/api/dataset' && req.method !== 'POST') return json(res, 200, { ok: true, capture: dataset.on, share: 'no upload path exists', ...dataset.stats() });
    if (p === '/api/tools') return json(res, 200, { ok: true, count: registry.list().length, groups: registry.groups(), tools: registry.visible().map((t) => ({ name: t.name, group: t.group, risk: t.risk, desc: t.desc, params: Object.keys(t.raw || {}), parameters: t.parameters })) });
    if (p === '/api/schedule' && req.method === 'GET') return json(res, 200, { ok: true, jobs: scheduler ? scheduler.list() : [], enabled: Boolean(scheduler) });
    if (p === '/api/channels') return json(res, 200, { ok: true, ...(channels ? channels.status() : { telegram: { online: false, state: 'off' }, whatsapp: { online: false, state: 'off' } }) });
    if (p === '/api/approvals') return json(res, 200, { ok: true, pending: approvals.list(), recent: approvals.recent(12) });
    /* --- MAJIN chats: canonical durable index (owner spec A, P0) --- */
    if (p === '/api/chats' && req.method === 'GET') {
      const view = url.searchParams.get('view') || 'active';
      const search = url.searchParams.get('search') || '';
      return json(res, 200, { ok: true, chats: listChats(dirs, { view, search }), view });
    }
    if (p === '/api/chats/rename' && req.method === 'POST') {
      const body = await readJson(req);
      try { const c = chatRename(dirs, body.id, body.title); return json(res, 200, { ok: true, chat: c }); }
      catch (e) { return json(res, 422, { ok: false, error: e.message }); }
    }
    if (p === '/api/chats/archive' && req.method === 'POST') {
      const body = await readJson(req);
      try { const c = chatSetArchived(dirs, body.id, body.archived !== false); return json(res, 200, { ok: true, chat: c }); }
      catch (e) { return json(res, 422, { ok: false, error: e.message }); }
    }
    if (p === '/api/chats/delete' && req.method === 'POST') {
      const body = await readJson(req);
      try {
        const r = deleteChat(dirs, body.id, body.title);
        return json(res, 200, { ok: true, deleted: r });
      } catch (e) { return json(res, 422, { ok: false, error: e.message }); }
    }
    if (p === '/api/sessions') {
      let files = [];
      try {
        files = fs.readdirSync(dirs.sessions).filter((f) => f.endsWith('.jsonl'));
      } catch {
        /* ingen historik ännu */
      }
      const sessions = files
        .map((f) => {
          const abs = path.join(dirs.sessions, f);
          const st = fs.statSync(abs);
          const msgs = readHistory(path.basename(f, '.jsonl'), 3);
          const last = msgs[msgs.length - 1];
          return { id: path.basename(f, '.jsonl'), file: f, bytes: st.size, mtime: st.mtime.toISOString(), messages: msgs.length ? countLines(abs) : 0, lastRole: last?.role || null, lastAt: last?.ts || null, lastText: String(last?.content || '').slice(0, 120) };
        })
        .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
      return json(res, 200, { ok: true, sessions, dir: dirs.sessions });
    }
    if (p === '/api/session/clear' && req.method === 'POST') {
      const body = await readJson(req);
      const id = String(body.session || 'desktop').replace(/[^\w.:-]/g, '_');
      const abs = path.join(dirs.sessions, `${id}.jsonl`);
      try {
        if (fs.existsSync(abs)) fs.renameSync(abs, `${abs}.${Date.now()}.bak`);
        return json(res, 200, { ok: true, session: id });
      } catch (err) {
        return json(res, 422, { ok: false, error: err.message });
      }
    }
    if (p === '/api/history') {
      const s = url.searchParams.get('session') || 'desktop';
      return json(res, 200, { ok: true, session: s, messages: readHistory(s, Number(url.searchParams.get('n') || 200)) });
    }
    if (p === '/api/keys/pair' && req.method === 'POST') {
      const code = Math.random().toString(36).slice(2, 8).toUpperCase();
      pairs.set(code, { code, expires: Date.now() + 5 * 60_000 });
      return json(res, 200, { ok: true, code, expiresSec: 300, url: `http://${req.headers.host}/?t=${token}` });
    }
    if (p === '/api/report' && req.method === 'GET') {
      const file = url.searchParams.get('file') || '';
      const abs = safeJoin(dirs.out, file);
      if (!abs || !fs.existsSync(abs)) return json(res, 404, { ok: false, error: 'the report does not exist' });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${path.basename(abs)}"` });
      return fs.createReadStream(abs).pipe(res);
    }
    if (p === '/api/file') {
      const want = url.searchParams.get('path') || '';
      const configuredWorkspace = path.resolve(cfg.get('workspace'));
      const normalPath = want.replace(/\\/g, '/');
      // File tools sometimes report \"workspace/project/index.html\" while
      // their actual write root is already the \"workspace\" directory.
      const prefix = path.basename(configuredWorkspace).toLowerCase() + '/';
      const relative = normalPath.toLowerCase().startsWith(prefix)
        ? normalPath.slice(prefix.length) : normalPath;
      const original = path.isAbsolute(want) ? path.resolve(want) : path.resolve(configuredWorkspace, normalPath);
      const prefixed = path.isAbsolute(want) ? original : path.resolve(configuredWorkspace, relative);
      const abs = !fs.existsSync(original) && fs.existsSync(prefixed) ? prefixed : original;
      // Agent fs.write resolves relative paths against the configured workspace.
      // The directory created at startup (dirs.workspace) may differ when the
      // user changes workspace in Settings. Honour both, but never escape them.
      const roots = [cfg.get('workspace'), dirs.workspace, dirs.out, dirs.uploads, dirs.cache, dirs.memory, dirs.sessions, dirs.rules]
        .filter((root) => typeof root === 'string' && root.trim());
      const within = (file, root) => file === root || file.startsWith(root + path.sep);
      const allowed = roots.some((root) => within(abs, path.resolve(root)));
      if (!allowed) return json(res, 403, { ok: false, error: 'path not allowed' });
      if (!fs.existsSync(abs)) return json(res, 404, { ok: false, error: 'file not found' });
      // A symlink inside the workspace must not expose files outside it.
      let real;
      try { real = fs.realpathSync(abs); }
      catch { return json(res, 404, { ok: false, error: 'file not found' }); }
      const safe = roots.some((root) => {
        try { return within(real, fs.realpathSync(root)); }
        catch { return false; }
      });
      if (!safe || !fs.statSync(real).isFile()) return json(res, 403, { ok: false, error: 'path not allowed' });
      const st = fs.statSync(real);
      res.writeHead(200, { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'content-length': st.size, 'content-disposition': `attachment; filename="${path.basename(abs)}"` });
      return fs.createReadStream(abs).pipe(res);
    }

    /* ---------- SSE-flöden ---------- */
    if (p === '/api/events') {
      sseHead(res);
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      (async () => {
        try {
          for await (const ev of bus.stream({ fromSeq: bus.seq, signal: ac.signal })) {
            if (res.writableEnded || res.destroyed) break;
            res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
          }
        } catch {
          /* klienten stängde */
        }
        res.end();
      })();
      return;
    }
    if (p === '/api/chat') {
      const body = await readJson(req);
      const last = Array.isArray(body.messages) ? body.messages.filter((m) => m && m.role === 'user').slice(-1)[0] : null;
      const input = String(body.input || body.text || body.prompt || body.content || (last && last.content) || '').trim();
      if (!input) return json(res, 400, { ok: false, error: 'empty input', hint: 'send {input:"…"} (or messages:[{role:"user",content:"…"}])' });
      let session = String(body.session || 'desktop');
      /* P0: every real send is recorded in the durable chat index. Materialize
         the chat entry + bump lastActivityAt; the auto title policy takes the
         first user text exactly once (manual renames always win). uiActivity
         flag == false for internal listeners that must not reorder the list. */
      const sessionIdSafe = chatSanitizeId(session);
      const sendIsUserInitiated = body.uiActivity !== false && body.internal !== true;
      if (sendIsUserInitiated) {
        try {
          const prior = listChats(dirs, { view: 'all' }).find((c) => c.id === sessionIdSafe);
          chatActivity(dirs, sessionIdSafe, { firstUserText: prior && prior.titlePolicy === 'manual' ? null : input });
        } catch { /* a durable-index failure never blocks a chat turn */ }
        session = sessionIdSafe;
      }
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];
      // First-use connection, solely for explicit ad-management requests.
      // Asking for credentials is deterministic and costs ZERO model tokens.
      // The token itself is collected by an authenticated form, not chat.
      // Only explicit management/report requests trigger a contextual, private
      // connection step. Generic advice ("what is TikTok Ads?") stays normal chat.
      const askChannel=/(^|[\s,.!?])(tiktok|google)\s*(ads|annonser|annons|reklam|marketing|marknadsf)/i.exec(input);
      const wantsChannelWork=/(analy[sz]|granska|optim|sköt|hantera|marknadsför|visa|rapport|kör|starta|connect|koppla|reconnect|återanslut|manage|run|audit|review|my ads|mina annonser)/i.test(input);
      const platform=askChannel&&wantsChannelWork?askChannel[2].toLowerCase():null;
      const forceConnect=/(reconnect|koppla om|anslut igen|byt nyckel|connect again|återanslut)/i.test(input);
      if(body.task==null&&platform&&(!channelStatus(cfg.get('marketing')||{})[platform].configured||forceConnect)){
        const reply=platform==='google'
          ?'To read your Google Ads reports I need your Google Ads customer ID, developer token and an authorized OAuth access token. Enter them privately below; Google OAuth tokens expire and no ads will be changed.'
          :'To read TikTok Ads reports I need your advertiser ID and an authorized TikTok Business API token. Enter them privately below; no ads will be changed.';
        if(noStreamFlag(body,url))return json(res,200,{ok:true,needsMarketingChannelSetup:platform,text:reply});
        sseHead(res);
        res.write('event: delta\n'+'data: '+JSON.stringify({type:'delta',text:reply})+'\n\n');
        res.write('event: answer\n'+'data: '+JSON.stringify({type:'answer',text:reply})+'\n\n');
        res.write('event: marketing_channel_setup\n'+'data: '+JSON.stringify({type:'marketing_channel_setup',platform,request:input})+'\n\n');
        res.write('event: done\n'+'data: '+JSON.stringify({ok:true,channelSetup:platform})+'\n\n');
        return res.end();
      }
      if (body.task == null && wantsMarketingSetup(input) && !marketingStatus(cfg).connected) {
        const reply = 'I can analyze your Facebook/Instagram ads. First I need your Meta ad account and product costs. Complete the secure connection here; your token will not be sent to the AI model. No ads will be changed.';
        if (noStreamFlag(body, url)) return json(res, 200, { ok: true, needsMarketingSetup: true, text: reply });
        sseHead(res);
        res.write('event: delta\ndata: ' + JSON.stringify({ type: 'delta', text: reply }) + '\n\n');
        res.write('event: answer\ndata: ' + JSON.stringify({ type: 'answer', text: reply }) + '\n\n');
        res.write('event: marketing_setup\ndata: ' + JSON.stringify({ type: 'marketing_setup', request: input }) + '\n\n');
        res.write('event: done\ndata: ' + JSON.stringify({ ok: true, marketingSetup: true }) + '\n\n');
        return res.end();
      }
      /* Autopilot: an independent message can become its own task = its own
         session, and the engine serializes per session, so different tasks
         truly run in parallel with isolated history and per-task stop.
         A follow-up message (body.task) rejoins the SAME session instead —
         it can never spawn an accidental duplicate. body.autopilot=true opts
         an API caller into a fresh task; the classic session path is tracked
         in the registry too, without changing its behaviour. */
      /* deterministic fleet commands run BEFORE the model ever sees them
         (no LLM for routing — the task ids are right here in memory) */
      const cmd = body.task == null ? parseTaskCommand(input, tasks.activeOldestFirst()) : null;
      if (cmd) {
        const report = await executeTaskCommand(cmd, { agent });
        if (noStreamFlag(body, url)) return json(res, 200, report);
        sseHead(res);
        res.write(`event: route\ndata: ${JSON.stringify({ job: 'fleet', model: 'none', deterministic: true })}\n\n`);
        res.write(`event: answer\ndata: ${JSON.stringify({ text: report.text || JSON.stringify(report), meta: { fleet: cmd.action, task: (report.task||report.target||null) } })}\n\n`);
        res.write('event: done\ndata: ' + JSON.stringify({ ok: !report.error }) + '\n\n');
        return res.end();
      }
      const follow = body.task != null ? tasks.sessionOf(body.task) : null;
      if (body.task != null && !follow) return json(res, 404, { ok: false, error: `unknown task: ${body.task}`, hint: 'tasks expire when done for 6h — start a new one instead' });
      let task;
      if (follow) {
        task = tasks.get(body.task);
        session = follow;
        tasks.beginFollowup(task.id);
      } else {
        task = tasks.create({ input, source: body.source || 'ui' });
        if (body.autopilot === true) session = task.session;
        else task.session = session; // observe-only: one name, one behaviour
      }
      const taskRun = task.run;
      const track = (ev) => {
        if (task.run !== taskRun) return;
        tasks.event(task.id, ev.type, (ev.type === 'tool' || ev.type === 'tool_begin') ? { tool: ev.name || ev.tool || null }
          : ev.type === 'tool_result' ? { tool: ev.tool || null, ms: ev.ms ?? null }
          : null, taskRun);
        if (ev.type === 'tool_result' && ev.tool && Number.isFinite(ev.ms)) eta.record(ev.tool, ev.ms);
      };
      const noStream = body.stream === false || body.stream === 'false'
        || ['false', '0'].includes(String(url.searchParams.get('stream') || '').toLowerCase());
      if (noStream) {
        const r = await agent.turn({ input, session, attachments, source: 'api', onEvent: track, aware: tasks.awareText({ excludeId: task.id }) });
        tasks.setStatus(task.id, r.error ? 'error' : 'done', taskRun);
        return json(res, 200, { ok: !r.error, task: task.id, ...r });
      }
      sseHead(res);
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      res.write(`event: task\ndata: ${JSON.stringify({ task: task.id, session, followup: Boolean(follow) })}\n\n`);
      try {
        const r = await agent.turn({
          input,
          session,
          attachments,
          source: 'ui',
          aware: tasks.awareText({ excludeId: task.id }),
          onEvent: (ev) => {
            track(ev);
            res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
          },
        });
        tasks.setStatus(task.id, r.error ? 'error' : 'done', taskRun);
        res.write(`event: done\ndata: ${JSON.stringify({ ok: !r.error, task: task.id, steps: r.steps, tools: r.tools?.length || 0, usage: r.usage, moa: r.moa, job: r.job })}\n\n`);
      } catch (err) {
        tasks.setStatus(task.id, 'error', taskRun);
        res.write(`event: error\ndata: ${JSON.stringify({ message: err.message, hint: err.hint || null })}\n\n`);
      }
      return res.end();
    }

    /* ---------- skrivningar ---------- */
    if (p === '/api/chat/stop' && req.method === 'POST') {
      const body = await readJson(req);
      /* stopping ONE task: everything else keeps running (autopilot test E) */
      const sess = body.task != null ? tasks.sessionOf(body.task) : String(body.session || 'desktop');
      if (body.task != null && !sess) return json(res, 404, { ok: false, error: `unknown task: ${body.task}` });
      agent.stop(sess);
      if (body.task != null) tasks.stop(body.task);
      return json(res, 200, { ok: true, session: sess });
    }
    if (p === '/api/config' && (req.method === 'PATCH' || req.method === 'POST')) {
      const patch = await readJson(req);
      if (!Object.keys(patch || {}).length) return json(res, 400, { ok: false, error: 'empty patch — send JSON' });
      const r = cfg.patch(patch, { source: 'ui' });
      return json(res, r.ok ? 200 : 422, { ok: r.ok, diff: r.diff || [], errors: r.errors || [], config: cfg.redacted() });
    }
    if (p === '/api/config/dry' && req.method === 'POST') {
      const patch = await readJson(req);
      const r = cfg.patch(patch, { dry: true });
      return json(res, 200, { ok: r.ok, diff: r.diff, errors: r.errors, preview: r.preview && { moa: r.preview.moa?.policy, routes: r.preview.models?.routes } });
    }
    if (p === '/api/intent' && req.method === 'POST') {
      const body = await readJson(req);
      const i = parseIntent(String(body.text || ''), cfg);
      const dry = i.matched ? cfg.patch(i.patch, { dry: true }) : { ok: false, errors: [], diff: [] };
      return json(res, 200, { ok: i.matched, matched: i.matched, notes: i.notes, patch: i.patch, diff: dry.diff, errors: dry.errors });
    }
    if (p === '/api/provider' && req.method === 'POST') {
      const body = await readJson(req);
      /* list | models | delete går genom samma verktyg som agenten har, så att
         UI och agent aldrig kan få olika uppfattning om vad en provider är. */
      if (body.action && body.action !== 'add' && body.action !== 'save') {
        const out = await registry.exec('majin.provider', { action: body.action, ...((body.name || body.preset) ? { name: body.name || body.preset } : {}), ...(body.preset ? { preset: body.preset } : {}), ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}), ...(body.apiKey ? { apiKey: body.apiKey } : {}), ...(body.env ? { env: body.env } : {}), ...(body.models ? { models: Array.isArray(body.models) ? body.models.join(',') : body.models } : {}), ...(body.kind ? { kind: body.kind } : {}) }, { ...rt.ctx, session: 'ui-provider', step: 1 });
        if (out.ok === false) return json(res, 422, { ok: false, error: out.error?.message || 'provider action failed', hint: out.error?.hint || null });
        return json(res, 200, { ok: true, action: body.action, result: out.result, meta: out.meta || null, providers: cfg.providerStatus() });
      }
      const preset = PRESETS[body.preset];
      const name = String(body.name || (preset ? body.preset : 'custom')).replace(/[^a-z0-9_-]/gi, '').toLowerCase().slice(0, 24);
      if (!name) return json(res, 400, { ok: false, error: 'the provider-specific name is missing' });
      const entry = {
        label: body.label || preset?.label || name,
        kind: body.kind || preset?.kind || 'openai',
        baseUrl: body.baseUrl || preset?.baseUrl || '',
        // No-key local presets still need a usable local auth placeholder.
        apiKey: body.apiKey || preset?.apiKey || (/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(body.baseUrl || '') ? 'local' : ''),
        models: Array.isArray(body.models) && body.models.length ? body.models : preset?.models || [],
        ...(preset?.headers ? { headers: preset.headers } : {}),
      };
      if (!entry.baseUrl && entry.kind !== 'mock') return json(res, 422, { ok: false, error: 'baseUrl is required for a custom provider' });
      /* ett tomt nyckelfalt ar inte "spara" — en vanlig manniska trycker pa
         spara for att det ska vara klart, sa losen ska vara en mening */
      if (needsKeyFor(entry, preset)) {
        return json(res, 422, {
          ok: false,
          error: `no key pasted — ${entry.label} needs one`,
          hint: `${preset?.keyUrl ? `Get a key at ${preset.keyUrl}, copy the whole line, and paste it in the box. ` : 'Paste the key from the provider page into the box. '}Nothing was changed — the old setup still works.`,
          needsKey: true,
        });
      }
      const r = cfg.patch({ providers: { [name]: entry } }, { source: 'ui' });
      if (!r.ok) return json(res, 422, { ok: false, errors: r.errors });
      return json(res, 200, { ok: true, provider: name, status: cfg.providerStatus().find((p2) => p2.name === name) });
    }
    if (p === '/api/provider/test' && req.method === 'POST') {
      const body = await readJson(req);
      /* "testa provider X" utan modellnamn måste välja någon — annars skickas "x/" och
         gatewayen svarar 400 okänd modell, vilket ser ut som att MAJIN är trasigt */
      const want = String(body.ref || '').trim();
      const named = String(body.provider || cfg.get('models.provider') || '');
      const ref = want.includes('/') ? want : want || `${named}/${(cfg.get(`providers.${named}.models`) || [])[0] || 'default'}`;
      const route = cfg.resolveModel(ref, 'router');
      const t0 = Date.now();
      try {
        const r = await complete({ route, job: 'test', messages: [{ role: 'user', content: 'Answer with exactly: OK' }], maxTokens: String(ref).startsWith('opencode/') ? 600 : 64, temperature: 0, retries: 0 });
        return json(res, 200, { ok: true, ms: Date.now() - t0, text: String(r.text).slice(0, 60), usage: r.usage });
      } catch (err) {
        const info = err.majin || explainError(err, route);
        return json(res, 200, {
          ok: false, error: info.human || err.message, code: err.code || null, kind: info.kind,
          hint: err.hint || null, ms: Date.now() - t0,
        });
      }
    }
    if (p === '/api/models' && req.method === 'GET') {
      const name = String(url.searchParams.get('provider') || cfg.get('models.provider'));
      const prov = (cfg.get('providers') || {})[name];
      if (!prov) return json(res, 404, { ok: false, error: 'unknown provider' });
      const { payload, ...result } = await discoverModels(prov);
      if (result.ok) {
        cfg.patch({ providers: { [name]: { models: result.models } } }, { source: 'catalog' });
        await importPricing(cfg, name, payload, { source: name + ':/models' }).catch(() => {});
      }
      return json(res, 200, { ...result, provider: name });
    }
    if (p === '/api/approve' && req.method === 'POST') {
      const body = await readJson(req);
      const ok = approvals.respond(String(body.id), Boolean(body.approved), String(body.note || 'ui'));
      return json(res, 200, { ok, pending: approvals.list().length });
    }
    if (p === '/api/schedule' && req.method === 'POST') {
      if (!scheduler) return json(res, 503, { ok: false, error: 'the scheduler is off' });
      const body = await readJson(req);
      try {
        return json(res, 200, { ok: true, job: scheduler.add({ when: body.when, task: body.task, deliver: body.deliver || 'silent', model: body.model || null, name: body.name || '' }) });
      } catch (err) {
        return json(res, 422, { ok: false, error: err.message });
      }
    }
    if (p === '/api/schedule' && req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      return json(res, 200, { ok: scheduler ? scheduler.remove(id) : false });
    }
    if (p === '/api/schedule/run' && req.method === 'POST') {
      const body = await readJson(req);
      const r = scheduler ? await scheduler.runNow(body.id) : { error: 'ingen scheduler' };
      return json(res, r.error ? 422 : 200, { ok: !r.error, ...r });
    }
    if (p === '/api/skills' && req.method === 'POST') {
      const body = await readJson(req);
      const r = skills.save(body);
      return json(res, r.ok ? 200 : 422, r);
    }
    if (p === '/api/memory' && req.method === 'POST') {
      const body = await readJson(req);
      if (body.action === 'forget') return json(res, 200, memory.forget(String(body.query || '')));
      return json(res, 200, memory.remember(String(body.text || ''), body.tags || []));
    }
    if (p === '/api/channels/telegram' && req.method === 'POST') {
      const body = await readJson(req);
      if (body.botToken) cfg.patch({ channels: { telegram: { botToken: String(body.botToken).trim(), enabled: true } } });
      if (!channels) return json(res, 503, { ok: false, error: 'channels are not running (restart MAJIN with channels enabled)' });
      const ok = body.action === 'stop' ? channels.stopTelegram() : await channels.startTelegram();
      return json(res, 200, { ok: Boolean(ok), status: channels.telegram.status(), pairingCode: channels.telegram.status().pairingCode });
    }
    if (p === '/api/channels/whatsapp' && req.method === 'POST') {
      const body = await readJson(req);
      if (body.transport) cfg.patch({ channels: { whatsapp: { transport: body.transport === 'cloud' ? 'cloud' : 'baileys', enabled: true, ...(body.cloud || {}) } } });
      if (!channels) return json(res, 503, { ok: false, error: 'channels are not running' });
      if (body.action === 'stop') await channels.stopWhatsapp();
      else await channels.startWhatsapp();
      return json(res, 200, { ok: true, status: channels.whatsapp.status() });
    }
    if (p === '/api/channels/allow' && req.method === 'POST') {
      const body = await readJson(req);
      if (body.channel === 'telegram') {
        const list = [...new Set([...(cfg.get('channels.telegram.allowedChatIds') || []), Number(body.chatId)])].filter(Boolean);
        cfg.patch({ channels: { telegram: { allowedChatIds: list } } });
        return json(res, 200, { ok: true, list });
      }
      if (channels) await channels.whatsapp.allow(body.jid);
      return json(res, 200, { ok: true, list: cfg.get('channels.whatsapp.allowedJids') || [] });
    }
    if (p === '/api/re/upload' && req.method === 'POST') {
      const name = sanitize(String(url.searchParams.get('name') || 'prov.bin'));
      const cap = cfg.get('tools.re.maxFileBytes') || 6e8;
      const buf = await readBody(req, cap);
      if (buf.length > cap) return json(res, 413, { ok: false, error: `file too large (${buf.length} > ${cap})` });
      const abs = path.join(dirs.uploads, `${Date.now()}-${name}`);
      fs.mkdirSync(dirs.uploads, { recursive: true });
      fs.writeFileSync(abs, buf);
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      return json(res, 200, { ok: true, path: abs, name, size: buf.length, sha256: sha });
    }
    if (p === '/api/re/analyze' && req.method === 'POST') {
      const body = await readJson(req);
      const out = await registry.exec('re.analyze', { path: String(body.path || ''), maxStrings: Number(body.maxStrings) || 0, rules: body.rules || 'builtin+user' }, { ...rt.ctx, session: 'ui-api', step: 1 });
      if (!out.ok) return json(res, 422, { ok: false, error: out.error?.message || 'the analysis failed', hint: out.error?.hint || null });
      return json(res, 200, { ok: true, result: out.result, meta: out.meta, spilled: out.spilled });
    }
    if (p === '/api/selftest' && req.method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      const out = await registry.exec('majin.selftest', { level: body.level === 'full' ? 'full' : 'quick' }, { ...rt.ctx, session: 'ui-api', step: 1 });
      return json(res, 200, { ok: out.ok !== false, text: out.result, meta: out.meta || null, error: out.error?.message || null });
    }
    if (p === '/api/dataset' && req.method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      const out = await registry.exec('majin.dataset', { ...body }, { ...rt.ctx, session: 'ui-api', step: 1 });
      return json(res, out.ok === false ? 422 : 200, { ok: out.ok !== false, text: out.result, meta: out.meta || null, error: out.error?.message || null, hint: out.error?.hint || null });
    }
    if (p.startsWith('/api/flows/hook/') && req.method === 'POST') {
      /* W5: webhook intake — same token gate as every other route; flow actions
         run through the shared approval guard (approval-required -> recorded). */
      const flowIdStr = decodeURIComponent(p.slice('/api/flows/hook/'.length));
      const body = await readJson(req);
      const r = await registry.exec('flows.webhook.recorded', { id: flowIdStr, payload: body || {} }, { ...rt.ctx, session: 'flows-hook', step: 1 });
      return json(res, r.ok ? 200 : 404, r.ok ? { ok: true, meta: r.meta } : { ok: false, error: r.error?.message || 'no such flow' });
    }
    if (p === '/api/tool' && req.method === 'POST') {
      const body = await readJson(req);
      const name = String(body.tool || body.name || '');
      if (!name) return json(res, 400, { ok: false, error: 'tool missing' });
      const out = await registry.exec(name, body.args || {}, { ...rt.ctx, session: 'ui-api', step: 1 });
      return json(res, 200, { ok: out.ok !== false, result: out.result, meta: out.meta || null, error: out.error || null, ms: out.ms });
    }
    if (p === '/api/usage/reset' && req.method === 'POST') {
      const ok = usage.reset ? usage.reset() : false;
      return json(res, 200, { ok, note: ok ? 'month reset' : 'usage.reset is not in this build' });
    }
    if (p === '/api/restart' && req.method === 'POST') {
      json(res, 200, { ok: true, restart: true, note: 'shutting down with code 75 — majin start will bring it back' });
      setTimeout(() => {
        try {
          server.close();
        } catch {
          /* */
        }
        process.exit(75);
      }, 250);
      return;
    }
    if (p === '/api/shutdown' && req.method === 'POST') {
      json(res, 200, { ok: true, bye: true });
      setTimeout(() => process.emit('SIGTERM', 'SIGTERM'), 120);
      return;
    }
    return json(res, 404, { ok: false, error: `unknown route ${p}`, hint: 'see /api/state for everything that exists' });
  }

  return server;
}

/* ------------------------------- helpers --------------------------------- */

/**
 * Local-first: localhost (och sandbox-förhandsvisningen .e2b.app) litar vi på utan
 * token i URL:en — allt annat kräver nyckeln. Stäng av med server.trustLocal:false.
 */
// Betrodda värdar utan token: loopback (lokalhost, 127.x, ::1) och sandbox-förhandsvisning.
const TRUSTED = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0|[\w-]+\.e2b\.app)$/i;

const LOCAL_PEER = /^(127\.|::1$)/;

export function authOk(req, url, token, cfg, peer = '') {
  if (!token) return true;
  if (url.searchParams.get('t') === token || url.searchParams.get('token') === token) return true;
  const h = req.headers.authorization || '';
  if (h === `Bearer ${token}` || h === `majin ${token}`) return true;
  if ((req.headers.cookie || '').split(/;\s*/).includes(`majin=${token}`)) return true;
  if (req.headers['x-majin-token'] === token) return true;
  const host = String(req.headers.host || '').split(':')[0];
  if (!TRUSTED.test(host)) return false;
  // Betrodd värd räcker bara om paketet faktiskt kommer lokalt (eller att remote uttryckligen
  // tillåtits) — annars räcker det att lura ett DNS-namn för att bli "localhost".
  const fromLocalHost = peer === '' || LOCAL_PEER.test(peer);
  if (cfg?.get?.('server.allowRemote') === true) return true;
  if (cfg?.get?.('server.trustLocal') !== false && fromLocalHost) return true;
  return false;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'access-control-allow-origin': '*' });
  return res.end(body);
}

function text(res, code, s) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
  return res.end(s);
}

function html(res, code, s) {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(s), 'cache-control': 'no-store' });
  return res.end(s);
}

function sseHead(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
    'x-accel-buffering': 'no',
  });
  res.write(': majin\n\nretry: 15000\n\n');
}

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > max) {
        reject(Object.assign(new Error(`body too large (${n} > ${max})`), { code: 'too_big' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 20 * 1024 * 1024);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return Object.fromEntries(new URLSearchParams(buf.toString('utf8')).entries());
  }
}

function countLines(abs) {
  try {
    let n = 0;
    const buf = fs.readFileSync(abs, 'utf8');
    for (let i = 0; i < buf.length; i += 1) if (buf[i] === '\n') n += 1;
    return n;
  } catch {
    return 0;
  }
}

function sanitize(name) {
  return path.basename(String(name)).replace(/[^\w.\-+()]/g, '_').slice(0, 140) || 'prov.bin';
}

export { VERSION };
