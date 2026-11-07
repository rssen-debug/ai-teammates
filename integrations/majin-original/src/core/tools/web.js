/**
 * MAJIN — web.
 * Search without an API key (duckduckgo/bing/searxng) plus a fetch that returns clean text.
 * `web.download` is the RE shortcut: fetch the sample, analyze it, skip the browser.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { def } from './registry.js';
import { resolveIn, writeAtomic } from './files.js';
import { bus } from '../log.js';
import { openFor, closeFor, isOpen, journal } from '../browser.js';
import { GROUND_JS, CLEAR_JS, rememberRefs, recallRef, clearRefs, renderElementsText, diffGroundSnapshot, findGroundedControls, VERSION as GROUND_V } from '../browser-ground.js';
import { VISIBLE_CONTROLS_JS, formatControlHints } from '../browser-control-hints.js';
import { noteBrowserAction, observeBrowserPage, clearBrowserStagnation } from '../browser-stagnation.js';
import { OUTLINE_JS, formatPageOutline } from '../browser-outline.js';
import { compactBrowserText } from '../browser-compact.js';
import { SEMANTIC_SNAPSHOT_JS, formatSemanticSnapshot } from '../browser-semantic.js';
import { VERIFY_JS, verificationCriteria, verifyObserved, browserRecoveryAdvice,FORM_STATE_JS,formatFormState } from '../browser-evidence.js';
import { browserActionReceipt } from '../browser-action-receipt.js';
import { observeForm, describeForm, fillForm, submitForm, clearForm } from '../browser-form.js';

const followedSafe = (fol) => (fol && fol.followed === true ? true : false);
// Only the latest per-session screenshot digest; prevents duplicate evidence files.
const recentShot = new Map();
function screenshotDigest(bytes){ return createHash('sha256').update(bytes).digest('hex'); }


const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 MAJIN/1.0';

async function httpGet(url, { headers = {}, timeoutSec = 25, maxBytes = 4_000_000, method = 'GET', body = null, signal = null } = {}) {
  signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxBytes) || maxBytes<1)throw new Error('maxBytes must be a positive safe integer');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutSec * 1000);
  t.unref?.();
  try {
    const res = await fetch(url, { method, body, redirect: 'follow', headers: { 'user-agent': UA, accept: '*/*', ...headers }, signal: signal ? AbortSignal.any([signal,ctrl.signal]) : ctrl.signal });
    const chunks=[];let bytes=0,truncated=false;
    if(res.body){
      const reader=res.body.getReader();
      try{
        for(;;){
          const next=await reader.read();if(next.done)break;
          const available=maxBytes-bytes,keep=Math.min(available,next.value.byteLength);
          if(keep){chunks.push(Buffer.from(next.value.subarray(0,keep)));bytes+=keep;}
          if(next.value.byteLength>available){truncated=true;await reader.cancel();break;}
        }
      }finally{reader.releaseLock();}
    }
    return { ok: res.ok, status: res.status, headers: Object.fromEntries(res.headers.entries()), body: Buffer.concat(chunks,bytes), truncated, url: res.url };
  } finally {
    clearTimeout(t);
  }
}

function decodeEntities(s) {
  return String(s)
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
      const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', eacute: 'é', auml: 'ä', ouml: 'ö', aring: 'å', copy: '©', deg: '°' };
      if (/^#x([0-9a-f]+)$/i.test(e)) return String.fromCodePoint(parseInt(/#x([0-9a-f]+)$/i.exec(e)[1], 16));
      if (/^#\d+$/.test(e)) return String.fromCodePoint(Number(e.slice(1)));
      return map[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ');
}

export function htmlToText(html) {
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|form|nav|footer|header|iframe)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/pre)[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function searchDuckDuckGo(query, count) {
  const r = await httpGet(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { timeoutSec: 20 });
  if (!r.ok) throw new Error(`duckduckgo ${r.status}`);
  const html = r.body.toString('utf8');
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,400}?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < count) {
    let url = decodeEntities(m[1]);
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]);
    out.push({ title: strip(m[2]), url, snippet: strip(m[3]) });
  }
  if (out.length) return { engine: 'duckduckgo', results: out };
  const loose = [...html.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]{4,120}?)<\/a>/g)]
    .filter((x) => !/duckduckgo\.com/.test(x[1]))
    .slice(0, count)
    .map((x) => ({ title: strip(x[2]), url: x[1], snippet: '' }));
  return { engine: 'duckduckgo(loose)', results: loose };
}

async function searchBing(query, count) {
  const r = await httpGet(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${count}`, { timeoutSec: 20, headers: { 'accept-language': 'en-US,en;q=0.9' } });
  const html = r.body.toString('utf8');
  const results = [];
  for (const m of html.matchAll(/<li class="b_algo"[\s\S]*?<h2><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]{0,700}?)<\/li>/g)) {
    results.push({ title: strip(m[2]), url: m[1], snippet: strip(m[3].replace(/<[^>]+>/g, ' ')) });
    if (results.length >= count) break;
  }
  return { engine: 'bing', results };
}

async function searchSearxng(query, count, base) {
  const r = await httpGet(`${String(base).replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json`, { timeoutSec: 20 });
  const j = JSON.parse(r.body.toString('utf8'));
  return { engine: 'searxng', results: (j.results || []).slice(0, count).map((x) => ({ title: strip(x.title), url: x.url, snippet: strip(x.content || '') })) };
}

async function searchBrave(query, count, key) {
  const r = await httpGet(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`, { headers: { 'x-subscription-token': key } });
  const j = JSON.parse(r.body.toString('utf8'));
  return { engine: 'brave', results: (j.web?.results || []).slice(0, count).map((x) => ({ title: strip(x.title), url: x.url, snippet: strip(x.description) })) };
}

function strip(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, '')).trim();
}

const cache = new Map();
const CACHE_MS = 15 * 60 * 1000;

export const webTools = [
  def({
    name: 'web.search',
    group: 'web',
    risk: 'read',
    desc: 'Search the web. No API key needed (duckduckgo/bing fallback). Returns title, url and snippet.',
    params: { query: 'string: what to look for', count: 'number: results to return (default: 8)', engine: 'string: auto | duckduckgo | bing | searxng | brave. optional (default: auto) [auto|duckduckgo|bing|searxng|brave]' },
    examples: ['web.search({query:"pe file format data directories"})'],
    async run({ query, count = 8, engine = 'auto' }, ctx) {
      const key = `search:${engine}:${query}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.res, meta: { ...hit.res.meta, cached: true } };
      const cfg = ctx.cfg;
      const braveKey = cfg.get('tools.web.braveKey');
      const searx = cfg.get('tools.web.searxng');
      const order = engine === 'auto' ? [searx && 'searxng', braveKey && 'brave', 'duckduckgo', 'bing'].filter(Boolean) : [engine];
      const errors = [];
      for (const e of order) {
        try {
          const res = e === 'searxng' ? await searchSearxng(query, count, searx) : e === 'brave' ? await searchBrave(query, count, braveKey) : e === 'bing' ? await searchBing(query, count) : await searchDuckDuckGo(query, count);
          if (res.results.length) {
            const body = res.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n');
            const out = { ok: true, result: `${res.engine}: ${res.results.length} results for "${query}"\n\n${body}`, meta: { engine: res.engine, count: res.results.length, query }, summary: `${res.engine} ${res.results.length} results` };
            cache.set(key, { at: Date.now(), res: out });
            return out;
          }
          errors.push(`${e}: 0 results`);
        } catch (err) {
          errors.push(`${e}: ${err.message}`);
        }
      }
      return { ok: false, error: { code: 'search_failed', message: `no search engine answered (${errors.join('; ')})`, hint: 'set tools.web.searxng or tools.web.braveKey in the config, or check internet access' } };
    },
  }),

  def({
    name: 'web.fetch',
    group: 'web',
    risk: 'read',
    desc: 'Read a URL with GET/HEAD as clean text (or json/raw). For POST/PUT/DELETE or other external actions use approval-gated net.http. Follows redirects, size-capped.',
    params: {
      url: 'string: http(s) address',
      extract: 'string: text | html | json | raw. optional (default: text) [text|html|json|raw]',
      maxChars: 'number: max characters in the response (default: 24000)',
      method: 'string: GET | HEAD. optional (default: GET) [GET|HEAD]',
      headers: 'object: extra headers (optional)',
    },
    examples: ['web.fetch({url:"https://api.deepseek.com/models"})'],
        required: ['url'],
async run({ url, extract = 'text', maxChars = 24000, method = 'GET', headers = {}, body }, ctx) {
      method=String(method).toUpperCase();
      if(!['GET','HEAD'].includes(method) || body != null || Object.keys(headers||{}).some(name=>/^(x-http-method-override|x-method-override|x-http-method|method-override)$/i.test(name)))return {ok:false,error:{code:'external_action_requires_approval',message:'web.fetch is read-only. Use net.http with an explicit approval for request bodies, method overrides or mutating HTTP methods.'}};
      if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://');
      const t0 = Date.now();
      const r = await httpGet(url, { timeoutSec: ctx.cfg.get('tools.web.timeoutSec') || 25, method, headers, body, signal:ctx.signal });
      const type = r.headers['content-type'] || '';
      let text;
      let note = r.truncated ? '(response byte limit reached; content is incomplete)' : '';
      if (extract === 'raw') text = r.body.subarray(0, 4000).toString('latin1');
      else if (extract === 'html' || (extract === 'text' && /json/i.test(type))) text = r.body.toString('utf8');
      else if (extract === 'text' && /html/i.test(type)) text = htmlToText(r.body.toString('utf8'));
      else text = r.body.toString('utf8');
      if (extract === 'json' || /json/i.test(type)) {
        try {
          text = JSON.stringify(JSON.parse(r.body.toString('utf8')), null, 1);
        } catch {
          note += ' (JSON could not be parsed)';
        }
      }
      const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}\n…[${text.length - maxChars} chars clipped]` : text;
      ctx.emit?.({ type: 'web', url, status: r.status, chars: text.length });
      if (!r.ok) return { ok: false, error: { code: `http_${r.status}`, message: `${r.status} for ${r.url}`, hint: r.status === 403 ? 'blocked (bot protection). Try another source or web.download.' : null } };
      return {
        ok: true,
        result: `${r.status} ${r.url} · ${type.split(';')[0] || 'unknown type'} · ${r.body.length} byte${note ? ` ${note}` : ''}\n\n${clipped}`,
        meta: { status: r.status, url: r.url, bytes: r.body.length, ms: Date.now() - t0, contentType: type, truncated:r.truncated },
        summary: `${r.status} ${new URL(r.url).host} (${r.body.length} byte)`,
      };
    },
  }),

  def({
    name: 'web.download',
    group: 'web',
    risk: 'write',
    desc: 'Download a file into the workspace (samples, archives, documents). Executables require an approval — an agent should not run something by accident.',
    params: { url: 'string: address', path: 'string: target file (default: under uploads/)', sha256: 'string: expected hash, verified when given (optional)' },
    async run({ url, path: p, sha256 }, ctx) {
      if (!/^https?:\/\//i.test(url)) throw new Error('url must be http(s)');
      const name = p || path.join('downloads', path.basename(new URL(url).pathname) || 'file.bin');
      const { abs } = resolveIn(ctx, name);
      const r = await httpGet(url, { timeoutSec: 120, maxBytes: ctx.cfg.get('tools.re.maxFileBytes') || 268435456, signal:ctx.signal });
      if (!r.ok) return { ok: false, error: { code: `http_${r.status}`, message: `${r.status} for ${url}` } };
      if(r.truncated)return {ok:false,error:{code:'response_too_large',message:'Download exceeded the configured byte limit; no file was written.'}};
      const crypto = await import('node:crypto');
      const digest = crypto.createHash('sha256').update(r.body).digest('hex');
      if (sha256 && digest !== sha256.toLowerCase()) {
        return { ok: false, error: { code: 'hash_mismatch', message: `sha256 ${digest} ≠ ${sha256}`, hint: 'the file changed or the link is wrong' } };
      }
      ctx.signal?.throwIfAborted();
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await writeAtomic(abs, r.body, {signal:ctx.signal});
      bus.info('download', { url, bytes: r.body.length, path: abs });
      return {
        result: `saved ${abs} (${r.body.length} bytes, sha256 ${digest})\nRun re.triage({path:"${abs}") to analyze it.`,
        meta: { path: abs, bytes: r.body.length, sha256: digest },
        summary: `downloaded ${path.basename(abs)} (${Math.round(r.body.length / 1024)} kB)`,
      };
    },
  }),

  /* -------------------------------- browser-use --------------------------------
     The agent drives the browser already on this machine via CDP: one window
     with one profile per agent session (never each other's tabs), a global
     instance cap, a deterministic loop guard and evidence-in-every-answer. */

  def({
    name: 'browser.open',
    group: 'web',
    risk: 'exec',
    desc: 'Open a URL in a MAJIN-controlled Chrome/Edge window, visible by default so the owner sees work. For forms use browser.form and browser.form_fill. NEVER invoke --remote-debugging-port or other Chrome switches as standalone commands: browser.open owns browser startup and CDP. Diagnose actual browser.open failures; do not ask the owner to start Chrome manually.',
    params: { url: 'string: http(s) address', headless: 'boolean: no visible window (default: false)' },
    examples: ['browser.open({url:"https://example.com"})'],
    async run({ url, headless = false }, ctx) {
      const session = ctx.session || 'default';
      journal.guard(session, `browser.open:${url}`);
      try {
        const b = await openFor({ session, url: String(url), headless, cfgGet: (k) => ctx.cfg.get(k), signal:ctx.signal });
        const meta = await b.eval('(() => ({ url: location.href, title: document.title }))()');
        const controls = await b.eval(VISIBLE_CONTROLS_JS).catch(() => []);
        const form=await observeForm(b,session).catch(()=>null);
        return {
          ok: true,
          result: `opened — page says: "${meta.title}" at ${meta.url}` + (form?.fields.length?'\nLive form: '+describeForm(form):formatControlHints(controls)),
          meta: { url: meta.url, title: meta.title },
          summary: `opened ${meta.title || meta.url}`,
        };
      } catch (err) {
        return { ok: false, error: { code: 'browser_open', message: err.message } };
      }
    },
  }),

  def({
    name: 'browser.read',
    group: 'web',
    risk: 'read',
    desc: 'Read visible text from the page (or one selector) — the actual words on the page, capped.',
    params: { selector: 'string: optional CSS selector — whole page when omitted', mode: 'string optional "structure" for compact accessibility outline without form values; "compact" for condensed full-page text' },
    async run({ selector = '', mode = '' }, ctx) {
      const session = ctx.session || 'default';
      if (!isOpen(session)) return { ok: false, error: { code: 'browser_closed', message: 'no browser is open for this task — run browser.open first' } };
      const b = await openFor({ session, cfgGet: (k) => ctx.cfg.get(k), signal:ctx.signal }).catch(() => null);
      if (!b) return { ok: false, error: { code: 'browser_closed', message: 'browser is not open' } };
      if(String(mode).toLowerCase()==='structure'){
        const payload=await b.eval(SEMANTIC_SNAPSHOT_JS).catch(e=>({error:String(e?.message||e)}));
        if(payload?.error)return {ok:false,error:{code:'structure_failed',message:payload.error}};
        const result=formatSemanticSnapshot(payload)+formatFormState(await b.eval(FORM_STATE_JS).catch(()=>[]));
        journal.guard(session,'browser.read:structure');
        return {ok:true,result,meta:{url:payload.url,title:payload.title,mode:'structure',count:payload.elements?.length||0},summary:'Page structure observed ('+(payload.elements?.length||0)+' elements)'};
      }
      const sel = JSON.stringify(String(selector || ''));
      const expr = `(() => {
        const t = ${sel} ? (document.querySelector(${sel})?.innerText ?? null) : null;
        const body = t == null ? (document.body ? document.body.innerText : '') : t;
        return { ok: ${sel} ? t != null : true, url: location.href, title: document.title, text: String(body).slice(0, 12000) };
      })()`;
      const r = await b.eval(expr);
      journal.guard(session, `browser.read:${selector}`);
      if (!r.ok && selector) return { ok: false, error: { code: 'no_such_element', message: `no element matches ${selector}` } };
      const controls = selector ? [] : await b.eval(VISIBLE_CONTROLS_JS).catch(() => []);
      const sourceText=r.text || '(page is empty)';
      const progress=observeBrowserPage(session,{url:r.url,title:r.title,text:sourceText,controls});
      const compressed=String(mode).toLowerCase()==='compact' ? compactBrowserText(sourceText) : null;
      const visibleText=compressed?.text || sourceText;
      const fieldState=await b.eval(FORM_STATE_JS).catch(()=>[]);
      return { ok: true, result: visibleText + formatControlHints(controls) + formatFormState(fieldState) + (progress.stagnant?'\n\nMAJIN browser observation: page unchanged after '+progress.unchangedActions+' actions. Inspect current controls and change strategy rather than replaying the same click.':''),
        meta: { url: r.url, title: r.title, chars: sourceText.length,
          groundedControls: Array.isArray(controls) ? controls.length : 0, stagnation:progress,
          ...(compressed ? { mode:'compact', visibleChars:compressed.outputChars,
            sourceChars:compressed.originalChars, truncated:compressed.truncated } : {}) },
        summary: compressed ? `compact page read ${compressed.outputChars}/${sourceText.length} chars from ${r.title||r.url}`
          : `${sourceText.length} chars from ${r.title || r.url}` };
    },
  }),

  def({
    name: 'browser.click',
    group: 'web',
    risk: 'exec',
    desc: 'Click an element by CSS selector and report what actually happened (element text + URL after the click). Screenshots via browser.shot when you need to look.',
    params: {
      selector: 'string: CSS selector of the thing to click (optional — or give ref)',
      ref: 'string: numbered element reference from browser.elements, e.g. "e3" (optional — or give selector)',
      role: 'string optional: button|link|checkbox|textbox, must also supply accessibleName',
      accessibleName: 'string optional: exact accessible label to select uniquely with role',
      expectSelector: 'string optional: unique selector that must be visible after the click',
      expectText: 'string optional: text that must appear inside expectSelector',
      expectUrl: 'string optional: URL fragment that must be present after the click',
      expectChecked: 'string optional true|false: expected checkbox state of expectSelector, or of the clicked selector/ref when expectSelector is omitted',
      verifyWaitMs: 'string optional 0–4000: maximum time for post-click verification (default 2500)',
    },
    examples: ['browser.click({selector:"button[type=submit]",expectSelector:"#success",expectText:"Saved"})', 'browser.click({ref:"e3",expectUrl:"/dashboard"})'],
    async run({ selector, ref, role, accessibleName, expectSelector, expectText, expectUrl, expectChecked, verifyWaitMs }, ctx) {
      ctx.signal?.throwIfAborted();
      const session = ctx.session || 'default';
      if (!isOpen(session)) return { ok: false, error: { code: 'browser_closed', message: 'no browser is open for this task — run browser.open first' } };
      const semantic=Boolean(role || accessibleName);
      if(semantic && (selector || ref || !['button','link','checkbox','textbox'].includes(String(role||'')) ||
         !String(accessibleName||'').trim() || String(accessibleName).length>140)){
        return {ok:false,error:{code:'bad_input',message:'Use role+accessibleName together, uniquely, without selector/ref'}};
      }
      if(!selector && !ref && !semantic) return {ok:false,error:{code:'bad_input',message:'Provide selector, live ref, or role+accessibleName'}};

      const requiresVerification=Boolean(expectSelector || expectText || expectUrl || expectChecked != null);
      const expected=requiresVerification?verificationCriteria({
        selector:expectSelector || (expectChecked != null && !semantic ?
          (ref ? `[data-majin-ref=${JSON.stringify(String(ref))}]` : selector) : undefined),
        text:expectText,url:expectUrl,checked:expectChecked
      }):null;
      if(requiresVerification && !expected.ok) return {
        ok:false,error:{code:'bad_expectation',message:expected.reason}
      };
      journal.guard(session, `browser.click:${selector || ref || role+":"+accessibleName}`);
      const b = await openFor({ session, cfgGet: (k) => ctx.cfg.get(k), signal:ctx.signal });
      let sel, identity = null;
      if (ref) {
        const cached = recallRef(session, ref);
        if (!cached) return { ok: false, error: { code: 'ref_unknown', message: `no element known for ref "${ref}" in this session — run browser.elements first to ground the page` } };
        // Grounding refs are ephemeral. Lock to the observed element identity
        // so a DOM rerender cannot silently reassign an old eN to another link.
        identity = { tag: String(cached.tag||'').toLowerCase(),
          id: String(cached.id||''), href: String(cached.href||''),
          name: String(cached.name||''), text: String(cached.text||'').slice(0,70) };
        sel = JSON.stringify(`[data-majin-ref=${JSON.stringify(String(ref))}]`);
      } else {
        sel = JSON.stringify(String(selector || ''));
      }
      const semanticTarget=JSON.stringify(semantic ? {role:String(role),name:String(accessibleName).trim()} : null);
      const expectedIdentity=JSON.stringify(identity);
      ctx.signal?.throwIfAborted();
      const targetsBeforeClick = await b.snapshotTargets?.().catch(() => null);
      const hit = await b.eval(`(() => {
        // Playwright-MCP-style unique target selection: acting on the first
        // of multiple matching buttons is unsafe, especially Submit/Buy.
        const semantic=${semanticTarget};
        // Stagehand-style grounded interaction across OPEN shadow boundaries:
        // never blindly pick the first match, preserve uniqueness checks.
        const queryDeep=(css)=>{
          const roots=[document],found=[];
          let scanned=0;
          for(let i=0;i<roots.length && i<16 && scanned<350;i++){
            const root=roots[i];
            found.push(...root.querySelectorAll(css));
            for(const node of [...root.querySelectorAll('*')].slice(0,350-scanned)){
              scanned++;
              if(node.shadowRoot && roots.length<16 && !roots.includes(node.shadowRoot))roots.push(node.shadowRoot);
            }
          }
          return found.slice(0,250);
        };
        let matches;
        if(semantic){
          const selectors={button:'button,[role="button"],input[type="button"],input[type="submit"]',
            link:'a[href],[role="link"]',checkbox:'input[type="checkbox"],[role="checkbox"]',
            textbox:'input:not([type="hidden"]):not([type="password"]),textarea,[role="textbox"]'};
          matches=queryDeep(selectors[semantic.role]).filter(el=>{
            const box=el.getBoundingClientRect(),sty=getComputedStyle(el);
            if(!box.width||!box.height||sty.display==='none'||sty.visibility==='hidden'||el.closest('[aria-hidden="true"],[inert]'))return false;
            const label=el.getAttribute('aria-label')||el.labels?.[0]?.textContent||el.getAttribute('title')||
              (['INPUT','TEXTAREA'].includes(el.tagName)?el.getAttribute('placeholder'):el.innerText)||'';
            return String(label).replace(/\\s+/g,' ').trim().toLocaleLowerCase()===semantic.name.toLocaleLowerCase();
          });
        }else matches=queryDeep(${sel});
        if (matches.length > 1) return {found:true,blocked:'ambiguous_target',
          matchCount:matches.length,tag:'',text:'Multiple matching controls'};
        const el = matches[0];
        if (!el) return { found: false };
        const expected = ${expectedIdentity};
        if (expected) {
          const current = {tag: el.tagName.toLowerCase(),id:el.id||'',
            href:el.href||'',name:el.name||'',
            text:String(el.innerText || el.getAttribute('aria-label') ||
              el.getAttribute('placeholder') || el.name || el.href || el.tagName)
              .replace(/\\s+/g,' ').trim().slice(0,70)};
          // Strong identity checks first; only compare text for anonymous
          // controls where the original text is their sole grounding key.
          const stableKey=expected.id || expected.href || expected.name;
          if (expected.tag!==current.tag || expected.id!==current.id ||
              expected.href!==current.href || expected.name!==current.name ||
              (!stableKey && ['button','a','summary'].includes(current.tag) && expected.text!==current.text))
            return {found:true,blocked:'ref_identity_changed',tag:current.tag,
              text:'stale element reference'};
        }

        el.scrollIntoView({ block: 'center' });
        // NEVER echo input.value: it can contain passwords, tokens, email or
        // uploaded data. Use rendered label/accessible name for click evidence.
        const t = String(el.innerText || el.labels?.[0]?.textContent ||
          el.getAttribute('aria-label') || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 80);
        const type = String(el.getAttribute('type') || '').toLowerCase();
        const isCheckbox = el.tagName === 'INPUT' && type === 'checkbox';
        const before = isCheckbox ? Boolean(el.checked) : null;
        // Inspired by Stagehand's observe-before-act contract: DOM .click()
        // succeeds even when a modal covers the button. Reject that false
        // success with actionable evidence rather than clicking blindly.
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if(style.display==='none' || style.visibility==='hidden' || Number(style.opacity)===0 ||
           rect.width<1 || rect.height<1) return {found:true,blocked:'hidden',tag:el.tagName.toLowerCase(),text:t};
        if(el.matches(':disabled,[aria-disabled="true"]') || el.closest('[inert]'))
          return {found:true,blocked:'disabled',tag:el.tagName.toLowerCase(),text:t};
        const x=Math.min(innerWidth-1,Math.max(0,rect.left+rect.width/2));
        const y=Math.min(innerHeight-1,Math.max(0,rect.top+rect.height/2));
        if(x<0 || y<0 || x>=innerWidth || y>=innerHeight)
          return {found:true,blocked:'outside_viewport',tag:el.tagName.toLowerCase(),text:t};
        const over=document.elementFromPoint(x,y);
        const associatedLabel=over?.closest?.('label');
        if(over && over!==el && !el.contains(over) && associatedLabel?.control!==el) {
          // Agent-browser-inspired obstruction diagnosis: inspect actual visible
          // dialog controls rather than blindly retrying the covered target.
          const overlay=over.closest('[role="dialog"],[aria-modal="true"],dialog') ||
            over.closest('[role="alertdialog"]') || over;
          const controls=[...overlay.querySelectorAll('button,[role="button"],a[href]')]
            .filter(n=>{
              const r=n.getBoundingClientRect(),css=getComputedStyle(n);
              return r.width>0&&r.height>0&&css.display!=='none'&&css.visibility!=='hidden';
            }).slice(0,6).map(n=>({
              role:n.tagName.toLowerCase()==='a'?'link':'button',
              label:String(n.getAttribute('aria-label')||n.innerText||n.getAttribute('title')||'').replace(/\\s+/g,' ').trim().slice(0,65)
            })).filter(n=>n.label);
          return {found:true,blocked:'occluded',tag:el.tagName.toLowerCase(),text:t,
            coveringTag:String(over.tagName||'').toLowerCase(),
            coveringRole:String(overlay.getAttribute('role')||'').slice(0,30),
            coveringId:String(over.id||'').slice(0,60),recoveryControls:controls};
        }
        // A DOM .click() is untrusted input and browsers may suppress the
        // default action for links (notably target=_blank). Use CDP pointer
        // input for anchors so navigation/new-tab behavior matches a real click.
        const physicalClick = el.tagName === 'A';
        if (!physicalClick) el.click();
        return { found: true, fromShadowRoot: Boolean(el.getRootNode?.()?.host), tag: String(el.tagName).toLowerCase(), text: t,
          x, y, physicalClick,
          checked: isCheckbox ? Boolean(el.checked) : null,
          changed: isCheckbox ? Boolean(el.checked) !== before : null };
      })()`, {signal:ctx.signal});
      if (hit.found && hit.blocked) {
        return {ok:false,error:{code:'click_blocked',
          message:'Browser click was NOT attempted: '+hit.blocked+' ('+hit.text+'). '+(
            hit.blocked==='occluded'?'Another page element overlaps the target. Inspect current controls or dismiss an actual visible dialog; do not blindly repeat the click.':
            hit.blocked==='disabled'?'Control is disabled or inert. Check required fields/permissions before retrying.':
            hit.blocked==='hidden'?'Target is not visible. Re-ground the page and find the visible control.':
            'Re-observe the current page before retrying.'
          ),
          reason:hit.blocked,coveringTag:hit.coveringTag||null,
          coveringRole:hit.coveringRole||null,coveringId:hit.coveringId||null,
          recoveryControls:hit.recoveryControls||[],
          recovery:(hit.recoveryControls?.length
            ? 'Visible overlapping controls: '+hit.recoveryControls.map(c=>c.role+' "'+c.label+'"').join('; ')+'. Refresh browser.elements and interact with the correct blocking control ONLY if appropriate.'
            : 'browser.elements({refresh:"true"}) then choose a NEW grounded action')},
          meta:{blocked:hit.blocked,tag:hit.tag,text:hit.text,receipt:browserActionReceipt({reason:hit.blocked})},
          summary:'click blocked: '+hit.blocked};
      }
      if (!hit.found) {
        const code = ref ? 'ref_stale' : semantic ? 'semantic_target_missing' : 'no_such_element';
        // Small free LLMs tend to retry guessed selectors such as
        // #apply-button despite a real button named #submit on the page.
        // Include CURRENT DOM-derived selectors in the failed action itself.
        const controls = await b.eval(VISIBLE_CONTROLS_JS).catch(() => []);
        const candidates = formatControlHints(controls);
        return { ok: false, error: { code,
          message: ref ? `element ${ref} vanished from the DOM (page re-rendered?) — do not guess a replacement` : `no clickable element matches ${selector}`,
          hint: 'Use an EXACT selector from the visible controls below (or browser.elements for live numbered refs). Avoid browser.open again unless navigation is required.' + candidates,
        } };
      }
      if (hit.physicalClick) {
        const point = { x: hit.x, y: hit.y, button: 'left', clickCount: 1 };
        await b.send('Input.dispatchMouseEvent', { ...point, type: 'mousePressed' }, { signal: ctx.signal });
        try {
          await b.send('Input.dispatchMouseEvent', { ...point, type: 'mouseReleased' }, { signal: ctx.signal });
        } catch (error) {
          // Always release a dispatched press before reporting an interrupted click.
          await b.send('Input.dispatchMouseEvent', { ...point, type: 'mouseReleased' }).catch(() => {});
          throw error;
        }
      }
      noteBrowserAction(session);
      /* a click may spawn a NEW tab (target=_blank, window.open): follow it
         so the agent lands where the page actually went */
      const fol = await (b.followNewTarget ? b.followNewTarget({ windowMs: 1500, beforeTargets: targetsBeforeClick }) : { followed: false });
      const after = fol.followed ? { url: fol.url, title: fol.title } : await b.eval('(() => ({ url: location.href, title: document.title }))()');
      // Stagehand-inspired deterministic action + evidence. No extra model
      // call and no second click. Only poll the outcome on the live page.
      let proof=null,attempts=0;
      if(requiresVerification){
        const script=VERIFY_JS.replace('__MAJIN_ARGS__',JSON.stringify(expected));
        const waitMs=Math.min(4000,Math.max(0,Math.trunc(Number(verifyWaitMs ?? 2500)||0)));
        const deadline=Date.now()+waitMs;
        for(;;){
          let observed;
          try{observed=await b.eval(script);}
          catch(e){return {ok:false,error:{code:'post_click_verify_error',message:String(e?.message||e)},
            meta:{clicked:hit.text,urlAfter:after.url,receipt:browserActionReceipt({dispatched:true,uncertain:true,reason:'verification_exception'})}};}
          attempts++;
          proof=verifyObserved(expected,observed);
          if(proof.ok || !observed?.valid || Date.now()>=deadline)break;
          await new Promise(resolve=>setTimeout(resolve,Math.min(200,Math.max(1,deadline-Date.now()))));
        }
        if(!proof.ok)return {ok:false,error:{
          code:'post_click_assertion_failed',
          message:'The click happened but its requested effect was NOT verified. Re-observe the page before trying a different approach.',
          failures:proof.failures
        },meta:{clicked:hit.text,attempts,observed:proof.observed,receipt:browserActionReceipt({dispatched:true,reason:'assertion_failed'})},summary:'click outcome NOT verified'};
      }
      const formState=await b.eval(FORM_STATE_JS).catch(()=>[]);
      return {
        ok: true,
        result: `Click dispatched on ${hit.tag} "${hit.text}"${typeof hit.checked === 'boolean' ? (hit.checked ? ' — checkbox CHECKED' : ' — checkbox UNCHECKED') : ''}${fol.followed ? ' (new tab followed)' : ''} — page now: "${after.title}" at ${after.url}${proof?.ok ? ' — EXPECTED OUTCOME VERIFIED' : ' — OUTCOME NOT VERIFIED: call browser.verify before declaring task done'}`+formatFormState(formState),
        meta: { tag: hit.tag, text: hit.text, checked: hit.checked, checkboxChanged: hit.changed,
          urlAfter: after.url, title: after.title, openedNewTab: fol.followed,
          verified: proof?.ok === true, outcomeEvidence: proof?.ok ? 'postcondition' : 'action_only', verificationAttempts: attempts,
          receipt:browserActionReceipt({dispatched:true,verified:proof?.ok===true}) },
        summary: `${proof?.ok ? 'verified' : 'action only'} · clicked "${hit.text}"${typeof hit.checked === 'boolean' ? (hit.checked ? ' (checked)' : ' (unchecked)') : ''}`,
      };
    },
  }),

  def({
    name: 'browser.form', group: 'web', risk: 'read',
    desc: 'Observe current form fields by live accessible labels/types, dropdown options, required/native validation, alert errors and submit/next buttons. Values stay hidden. Use before browser.form_fill and after navigation or server validation.',
    params: {},
    async run({},ctx){
      const session=ctx.session||'default';
      if(!isOpen(session))return {ok:false,error:{code:'browser_closed',message:'Open a browser first.'}};
      const b=await openFor({session,cfgGet:k=>ctx.cfg.get(k),signal:ctx.signal});
      // Client-rendered forms often display a "loading" shell after clicking
      // Apply. Poll the actual observed fields locally rather than spending
      // model rounds on identical browser.form calls or blind button clicks.
      const deadline=Date.now()+6500;
      let form=await observeForm(b,session);
      while(!form.fields?.length && Date.now()<deadline && !form.barriers?.length){
        ctx.signal?.throwIfAborted?.();
        await new Promise(resolve=>setTimeout(resolve,350));
        form=await observeForm(b,session);
      }
      return {ok:true,result:describeForm(form)+(form.fields?.length?'':'\\nNo fields rendered after bounded wait. Preserve the current tab; inspect alerts/network/UI instead of re-opening the same page.')};
    },
  }),
  def({
    name: 'browser.form_fill', group: 'web', risk: 'exec',
    desc: 'Set 1–12 previously observed form fields in order using exact labels or f-refs as keys in values. Text/select values are strings; checkboxes use true/false; file fields use workspace file paths. Reobserves/semantically regrounds rerenders, verifies retention, stops on failure. Never submits. Observe new conditional fields with browser.form.',
    params:{values:'object: map exact observed labels or f-refs to text strings, option labels, checkbox booleans, or workspace file paths'},
    async run({values},ctx){
      const session=ctx.session||'default';
      if(!isOpen(session))return {ok:false,error:{code:'browser_closed',message:'Open a browser first.'}};
      const b=await openFor({session,cfgGet:k=>ctx.cfg.get(k),signal:ctx.signal});
      return fillForm({browser:b,session,values,signal:ctx.signal,run:(name,input)=>webTools.find(t=>t.name===name).run(input,ctx)});
    },
  }),
  def({
    name:'browser.form_submit',group:'web',risk:'exec',
    desc:'Click ONE previously observed next/review/submit button by its exact label or f-ref. Regrounds changed DOM, never automatically repeats submission. Returns current form, native/server errors and visible page text. Server confirmation must still be verified before saving a receipt.',
    params:{button:'string: exact observed button label or f-ref from browser.form'},
    async run({button},ctx){
      const session=ctx.session||'default';
      if(!isOpen(session))return {ok:false,error:{code:'browser_closed',message:'Open a browser first.'}};
      const b=await openFor({session,cfgGet:k=>ctx.cfg.get(k),signal:ctx.signal});
      return submitForm({browser:b,session,button,run:(name,input)=>webTools.find(t=>t.name===name).run(input,ctx)});
    },
  }),
  def({
    name: 'browser.fill',
    group: 'web',
    risk: 'exec',
    desc: 'Fill one input/textarea/select with the required value argument (string). For selects, value may be an exact option value or unique visible option label. Real events and retention verification. Use browser.click for buttons and checkboxes.',
    params: { selector: 'string optional CSS selector of the field', ref: 'string optional numbered ref from browser.elements, e.g. e4 (exclusive with selector)', value: 'string: what to type' },
    async run({ selector, ref, value }, ctx) {
      ctx.signal?.throwIfAborted();
      const session = ctx.session || 'default';
      if (!isOpen(session)) return { ok: false, error: { code: 'browser_closed', message: 'no browser is open for this task — run browser.open first' } };
      if (Boolean(selector) === Boolean(ref)) return {ok:false,error:{code:'bad_input',message:'Give exactly one live ref from browser.elements OR a CSS selector'}};
      const grounded=ref?recallRef(session,ref):null;
      if(ref&&!grounded)return {ok:false,error:{code:'ref_unknown',message:'Ref is not grounded in this session; rerun browser.elements'}};
      const identity=grounded?{tag:String(grounded.tag||'').toLowerCase(),id:String(grounded.id||''),
        name:String(grounded.name||''),type:String(grounded.type||'').toLowerCase()}:null;
      journal.guard(session, `browser.fill:${ref || selector}`);
      const b = await openFor({ session, cfgGet: (k) => ctx.cfg.get(k), signal:ctx.signal });
      const sel = JSON.stringify(ref?`[data-majin-ref="${String(ref).replace(/[^a-zA-Z0-9_-]/g,'')}"]`:String(selector));
      const expectedIdentity=JSON.stringify(identity);
      const val = JSON.stringify(String(value ?? ''));
      ctx.signal?.throwIfAborted();
      const r = await b.eval(`(() => {
        let nodes;
        try { nodes = document.querySelectorAll(${sel}); }
        catch { return { found: false, invalidSelector: true }; }
        if (nodes.length > 1) return { found: true, blocked: 'ambiguous_target', count: nodes.length };
        const el = nodes[0];
        if (!el) return { found: false };
        const expected=${expectedIdentity};
        if(expected && (el.tagName.toLowerCase()!==expected.tag ||
          String(el.id||'')!==expected.id || String(el.name||'')!==expected.name ||
          String(el.type||'').toLowerCase()!==expected.type)){
          return {found:true,blocked:'ref_stale'};
        }
        // A checkbox/radio/button is an ACTION, not a value to overwrite.
        // Assigning input.value can corrupt a form submission without checking.
        const inputType = String(el.getAttribute('type') || '').toLowerCase();
        if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) ||
            ['checkbox', 'radio', 'submit', 'button', 'reset', 'file', 'hidden', 'password'].includes(inputType)) {
          return { found: true, wrongType: inputType };
        }
        const style = getComputedStyle(el), rect = el.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || !rect.width || !rect.height)
          return {found:true,blocked:'hidden'};
        if (el.disabled || el.readOnly || el.matches('[aria-disabled="true"]') || el.closest('[inert]'))
          return {found:true,blocked:'disabled_or_readonly'};
        let targetValue = ${val};
        if (el.tagName === 'SELECT') {
          const available = [...el.options].filter(o => !o.disabled && !o.parentElement?.disabled);
          let matches = available.filter(o => o.value === targetValue);
          if (!matches.length) matches = available.filter(o => o.label.trim() === targetValue);
          if (matches.length !== 1) return {found:true,blocked:'option_not_unique',
            options:available.slice(0,30).map(o=>o.label.trim().slice(0,100))};
          targetValue = matches[0].value;
        }
        // Re-dispatching a no-op select change can erase dependent form fields.
        if(el.value===targetValue)return {found:true,stuck:true,targetValue,unchanged:true};
        el.focus();
        const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : (el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, targetValue); else el.value = targetValue;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        // Report only equality with the requested input, never the raw value.
        return { found: true, stuck: el.value === targetValue, targetValue };
      })()`, {signal:ctx.signal});
      if (!r.found) {
        const controls = await b.eval(VISIBLE_CONTROLS_JS).catch(() => []);
        return { ok: false, error: { code: 'no_such_element', message: `no field matches ${selector}`,
          hint: 'Use EXACT selectors from these live controls. Checkboxes and buttons need browser.click, not browser.fill. Do not reopen the page to guess fields.' + formatControlHints(controls),
        } };
      }
      if (r.blocked === 'option_not_unique') return {ok:false,error:{code:r.blocked,
        message:'No unique enabled select option matches. Use an exact visible label from these current options: '+JSON.stringify(r.options)}};
      if (r.blocked) return {ok:false,error:{code:r.blocked,
        message:r.blocked==='ambiguous_target' ? 'Selector matched '+r.count+' fields; nothing changed. Narrow the selector.' : 'Target is '+r.blocked+'; nothing changed.'}};
      if (r.wrongType) {
        return { ok: false, error: { code: 'wrong_control_type', message: `browser.fill cannot set a ${r.wrongType}`,
          hint: 'Use browser.click with this exact selector and confirm the checked result. The control was not modified.' } };
      }
      if (!r.stuck) return { ok: false, error: { code: 'value_rejected', message: 'the page reverted the value immediately — the field may have javascript validation', hint: 'type slower substrings or confirm the field with browser.shot' } };
      await new Promise(resolve => setTimeout(resolve, 120));
      const retained = await b.eval(`(() => {
        let nodes; try { nodes=document.querySelectorAll(${sel}); } catch { return false; }
        const expected=${expectedIdentity};
        return nodes.length === 1 && (!expected || (
          nodes[0].tagName.toLowerCase()===expected.tag &&
          String(nodes[0].id||'')===expected.id &&
          String(nodes[0].name||'')===expected.name &&
          String(nodes[0].type||'').toLowerCase()===expected.type)) &&
          nodes[0].value === ${JSON.stringify(r.targetValue)};
      })()`).catch(() => false);
      if (!retained) return {ok:false,error:{code:'value_reverted',
        message:'Field initially accepted input but the app reverted it after its framework update. Re-observe before retrying.'},
        meta:{retained:false,valueHidden:true}};
      return { ok: true, result: 'filled — value retained after page update (value hidden)', meta: { retained: true, valueHidden: true, verified: true }, summary: 'field value verified' };
    },
  }),

  def({
    name: 'browser.shot',
    group: 'web',
    risk: 'read',
    desc: 'Capture visible browser screenshot. ifChanged=true saves only when pixel-identical PNG evidence differs from the preceding screenshot for this session (agent-browser-inspired token and disk optimization).',
    params: { ifChanged:'string optional true|false (default false) to skip saving duplicate PNGs' },
    async run({ifChanged='false'}={},ctx){
      const session=ctx.session||'default';
      if(!isOpen(session))return {ok:false,error:{code:'browser_closed',message:'no browser open for this task'}};
      const b=await openFor({session,cfgGet:k=>ctx.cfg.get(k),signal:ctx.signal});
      const shot=await b.send('Page.captureScreenshot',{format:'png'});
      if(!shot?.data)return {ok:false,error:{code:'screenshot_empty',message:'Browser returned no image'}};
      const bytes=Buffer.from(shot.data,'base64');
      const digest=screenshotDigest(bytes);
      const previous=recentShot.get(session);
      if(String(ifChanged)==='true' && previous?.sha256===digest){
        return {ok:true,result:'Screenshot unchanged — previous file is still valid: '+previous.path,
          meta:{path:previous.path,unchanged:true,sha256:digest},
          summary:'screen unchanged; no duplicate file'};
      }
      const dir=path.join(ctx.cfg.get('workspace'),'shots');
      await fs.mkdir(dir,{recursive:true});
      const file=path.join(dir,'shot-'+session.replace(/[^\w.-]/g,'_')+'-'+Date.now()+'.png');
      await fs.writeFile(file,bytes);
      recentShot.set(session,{path:file,sha256:digest});
      if(recentShot.size>64)recentShot.delete(recentShot.keys().next().value);
      ctx.bus?.emit?.('file.write',{path:file,bytes:bytes.length});
      return {ok:true,result:'screenshot saved: '+file,meta:{path:file,unchanged:false,sha256:digest},
        summary:'shot '+path.basename(file)};
    },
  }),

  def({
    name: 'browser.upload',
    group: 'web',
    risk: 'exec',
    desc: 'Attach a local file to one page file input (<input type=file>). Supply either a live ref from browser.elements or an exact CSS selector, plus path. Never put a ref in CSS brackets. Confirmation comes from the page itself.',
    params: { selector: 'string optional: exact CSS selector of the file input, exclusive with ref', ref: 'string optional: live numbered ref from browser.elements, exclusive with selector', path: 'string: local file to upload (inside the workspace)' },
    async run({ selector, ref, path: p }, ctx) {
      ctx.signal?.throwIfAborted();
      const session = ctx.session || 'default';
      if (!isOpen(session)) return { ok: false, error: { code: 'browser_closed', message: 'no browser is open for this task — run browser.open first' } };
      if (Boolean(selector) === Boolean(ref)) return {ok:false,error:{code:'bad_input',message:'Give exactly one live ref from browser.elements OR an exact CSS selector'}};
      const grounded = ref ? recallRef(session, ref) : null;
      if (ref && !grounded) return {ok:false,error:{code:'ref_unknown',message:'File input ref is not grounded in this session; rerun browser.elements'}};
      if (selector && /^\[?e[1-9][0-9]*\]?$/.test(String(selector))) return {ok:false,error:{code:'bad_input',message:'A numbered element ref is not a CSS selector. Pass it as ref (without brackets), or obtain an exact CSS selector from the current page.'}};
      const target = ref ? `[data-majin-ref=${JSON.stringify(String(ref))}]` : String(selector);
      const identity = grounded ? {tag:String(grounded.tag||''),id:String(grounded.id||''),name:String(grounded.name||''),type:String(grounded.type||'')} : null;
      journal.guard(session, `browser.upload:${ref || selector}`);
      const { resolveIn } = await import('./files.js');
      const { abs } = resolveIn(ctx, p);
      const st = await fs.stat(abs).catch(() => null);
      if (!st || !st.isFile()) return { ok: false, error: { code: 'no_file', message: `no such file: ${abs}` } };
      if(st.size>32*1024*1024)return {ok:false,error:{code:'upload_size',message:'Exact-byte verified uploads are limited to 32 MiB.'}};
      const expectedHash=createHash('sha256').update(await fs.readFile(abs)).digest('hex');
      const b = await openFor({ session, cfgGet: (k) => ctx.cfg.get(k), signal:ctx.signal });
      const sel = JSON.stringify(target);
      const checked = await b.eval(`(() => {
        let nodes; try { nodes=document.querySelectorAll(${sel}); } catch { return {ok:false,code:'invalid_selector'}; }
        if(nodes.length!==1)return {ok:false,code:nodes.length?'ambiguous_target':'no_such_element'};
        const el=nodes[0], expected=${JSON.stringify(identity)};
        if(expected && (el.tagName.toLowerCase()!==expected.tag || String(el.id||'')!==expected.id ||
          String(el.name||'')!==expected.name || String(el.type||'')!==expected.type))return {ok:false,code:'ref_stale'};
        if(el.tagName!=='INPUT' || el.type!=='file')return {ok:false,code:'wrong_control_type'};
        if(el.disabled || el.closest('[inert]'))return {ok:false,code:'disabled_or_inert'};
        return {ok:true};
      })()`, {signal:ctx.signal});
      if (!checked.ok) return {ok:false,error:{code:checked.code,message:'File upload target is '+checked.code+'; nothing uploaded. Re-observe browser.elements and choose one current file input.'}};
      await b.send('DOM.enable',{}, {signal:ctx.signal});
      const { root } = await b.send('DOM.getDocument',{}, {signal:ctx.signal});
      const { nodeId } = await b.send('DOM.querySelector', { nodeId: root.nodeId, selector: target }, {signal:ctx.signal});
      if (!nodeId) return { ok: false, error: { code: 'no_such_element', message: 'File input changed before upload; re-observe browser.elements' } };
      ctx.signal?.throwIfAborted();
      await b.send('DOM.setFileInputFiles', { files: [abs], nodeId }, {signal:ctx.signal});
      await new Promise(resolve => setTimeout(resolve, 120));
      const confirm = await b.eval(`(async () => {
        const el = document.querySelector(${sel});
        const f = el && el.files && el.files[0];
        if(!f||!globalThis.crypto?.subtle)return {ok:false};
        const digest=await crypto.subtle.digest('SHA-256',await f.arrayBuffer());
        return {ok:true,name:f.name,size:f.size,sha256:Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('')};
      })()`, {signal:ctx.signal});
      if (!confirm.ok || confirm.name !== path.basename(abs) || confirm.size !== st.size || confirm.sha256!==expectedHash) return { ok: false, error: { code: 'no_upload', message: 'the input did not retain the requested exact file bytes', hint: 're-observe the current page and check validation or a custom uploader before retrying' } };
      return { ok: true, result: `uploaded — page now holds "${confirm.name}" (${confirm.size} bytes), SHA-256 ${confirm.sha256}; server acceptance unproven`, meta: { name: confirm.name, size: confirm.size, path: abs,sha256:confirm.sha256 }, summary: `uploaded ${confirm.name}, exact bytes verified` };
    },
  }),

  def({
    name: 'browser.verify',
    group: 'web',
    risk: 'read',
    desc: 'Verify a REAL post-action browser outcome. Checks live URL, title, element visibility, text and checkbox state. On failure returns FAILED with observed evidence — never calls a click successful merely because it executed. Use after browser.click/fill when the goal requires an effect.',
    params: {
      selector: 'string optional CSS selector to assert exists and is visible',
      present: 'string optional true|false, default true if selector set',
      text: 'string optional expected text fragment within selector',
      url: 'string optional URL fragment (loose; use urlPath+urlOrigin for security-sensitive outcomes)',
      urlPath: 'string optional EXACT pathname such as /dashboard, unaffected by redirect query parameters',
      urlOrigin: 'string optional EXACT origin such as https://app.example.com',
      title: 'string optional expected title fragment',
      checked: 'string optional true|false expected checkbox checked state',
      enabled: 'string optional true|false expected element enabled state (includes aria-disabled and inert)',
      count: 'string optional exact number 0–1000 of matching elements; use for lists/cards, not with element text or checkbox expectations',
      waitMs: 'string optional: wait up to 0–5000ms for the expected DOM outcome (default 1800ms, immediate return on success)',
      stableMs: 'string optional 0–1500: require expected DOM state to stay true for this duration (default 0)',
    },
    examples: ['browser.verify({selector:"#success",text:"Saved"})', 'browser.verify({url:"/dashboard"})','browser.verify({selector:"input[name=consent]",checked:"true"})', 'browser.verify({selector:"#submit",enabled:"true"})', 'browser.verify({urlOrigin:"https://app.example.com",urlPath:"/dashboard"})', 'browser.verify({selector:".results > li",count:"10"})'],
    async run(input, ctx) {
      const session = ctx.session || 'default';
      if (!isOpen(session)) return { ok:false,error:{code:'browser_closed',message:'Open the target page before verifying'} };
      const criteria=verificationCriteria(input);
      if(!criteria.ok)return {ok:false,error:{code:'bad_expectation',message:criteria.reason}};
      journal.guard(session, 'browser.verify:' + JSON.stringify(criteria).slice(0,250));
      const b=await openFor({session,cfgGet:k=>ctx.cfg.get(k),signal:ctx.signal});
      const script=VERIFY_JS.replace('__MAJIN_ARGS__',JSON.stringify(criteria));
      const waitMs=Math.min(5000,Math.max(0,Math.trunc(Number(input?.waitMs ?? 1800)||0)));
      // React/Vue apps may briefly show a success node and immediately replace
      // it. Require sustained evidence when requested; don't report a flicker
      // as proof and never repeat the user's actual click.
      const stableMs=Math.min(1500,Math.max(0,Math.trunc(Number(input?.stableMs)||0)));
      const deadline=Date.now()+Math.max(waitMs,stableMs);
      let observed,verdict,firstPassingAt=null;
      for(;;){
        try { observed=await b.eval(script); }
        catch(e){ return {ok:false,error:{code:'browser_verify_error',message:String(e?.message||e)}}; }
        const now=Date.now();
        verdict=verifyObserved(criteria,observed);
        if(verdict.ok){
          if(firstPassingAt===null)firstPassingAt=now;
          if(now-firstPassingAt>=stableMs)break;
        } else firstPassingAt=null;
        if(now>=deadline) {
          if(verdict.ok && stableMs>0) verdict={...verdict,ok:false,
            failures:[{name:'stable_duration',expected:stableMs,actual:firstPassingAt===null?0:now-firstPassingAt}]};
          break;
        }
        await new Promise(resolve=>setTimeout(resolve,Math.min(120,Math.max(1,deadline-now))));
      }
      if(!verdict.ok){
        // A failed assertion must show the next grounded step, not an opaque
        // failure that makes a small model repeat the same unsafe click.
        const controls=await b.eval(VISIBLE_CONTROLS_JS).catch(()=>[]);
        const recovery=browserRecoveryAdvice(verdict,criteria,controls);
        return {ok:false,error:{code:'assertion_failed',
          message:'Browser outcome NOT verified. '+recovery.hint,
          failures:verdict.failures,
          recovery},meta:{assertions:verdict.assertions,observed:verdict.observed,recovery},
          summary:'verification FAILED · '+recovery.action};
      }
      return {ok:true,result:'Verified live browser outcome: '+verdict.assertions.map(a=>a.name+'='+a.actual).join(', '),
        meta:{assertions:verdict.assertions,observed:verdict.observed},summary:'browser outcome VERIFIED'};
    },
  }),

  def({
    name: 'browser.elements',
    group: 'web',
    risk: 'read',
    desc: 'W6 Set-of-Marks grounding: number every interactive element on the open page, draw the matching pink marks on screen, and return the references so browser.click({ref:"eN"}) hits deterministically instead of guessing. Refs are of-the-moment evidence; a re-rendered DOM makes them stale (browser.click then says ref_stale honestly).',
    params: { refresh: 'string: "true" = re-walk the DOM now and replace the cached refs (optional, default: false)', query: 'string optional search for a specific control by name, role, or label; returns only matches to reduce model tokens', delta: 'string optional true: first snapshot is full, subsequent snapshots show only changes or unchanged; false is default', outline: 'string optional true: include compact accessible page landmarks and headings (read-only, no form values)' },
    examples: ['browser.elements({})', 'browser.elements({query:"submit button"})'],
    async run({ refresh, query = '', delta = 'false', outline = 'false' }, ctx) {
      const session = ctx.session || 'default';
      journal.guard(session, 'browser.elements');
      if (!isOpen(session)) return { ok: false, error: { code: 'browser_closed', message: 'no browser is open for this task — run browser.open first' } };
      const b = await openFor({ session, cfgGet: (k) => ctx.cfg.get(k), signal:ctx.signal });
      if (String(refresh) === 'true') clearRefs(session);
      const payload = await b.eval(GROUND_JS).catch((e) => ({ error: String(e?.message || e) }));
      if (payload?.error) return { ok: false, error: { code: 'ground_eval', message: 'page walk failed: ' + payload.error } };
      rememberRefs(session, payload.elements || []);
      const needle=String(query||'').trim();
      const matches=needle ? findGroundedControls(payload.elements||[],needle) : null;
      const visible=matches ? {...payload,elements:matches} : payload;
      const isDelta=String(delta)==='true';
      const snap=isDelta?diffGroundSnapshot(session,visible,{query:needle,reset:String(refresh)==='true',cap:needle?12:60}):null;
      const selected=snap?.mode==='delta' ? {...visible,elements:snap.changes} : visible;
      const baseText=needle && !matches.length
        ? `No grounded controls match "${needle.slice(0,100)}" on ${payload.url}. Refresh or try broader terms.`
        : renderElementsText(selected, {cap:needle?12:60});
      const result=snap?.mode==='unchanged'
        ? `No changes in ${payload.count} page controls at ${payload.url}. Previous references remain valid only if the page has not rerendered.`
        : snap?.mode==='delta'
          ? `Page controls updated: ${snap.changes.length} changed, ${snap.removed.length} removed. Removed references: ${snap.removed.join(', ')||'none'}. Current controls below:\n${baseText}`
          : baseText;
      const pageOutline = String(outline)==='true'
        ? await b.eval(OUTLINE_JS).then(formatPageOutline).catch(()=>'Page outline unavailable')
        : '';
      return {
        ok: true,result: pageOutline ? result+'\n\n'+pageOutline : result,
        meta: {version:GROUND_V,count:payload.count,matched:matches?.length??null,
          url:payload.url,title:payload.title,deltaMode:snap?.mode??'off',
          changed:snap?.changes?.length??null,removed:snap?.removed?.length??null},
        summary: snap?.mode==='unchanged'?'Page controls unchanged':
          snap?.mode==='delta'?`${snap.changes.length} updated and ${snap.removed.length} removed controls`:
          needle?`${matches.length} matching controls among ${payload.count}`:`${payload.count} elements grounded on this page`,
      };
    },
  }),
def({
    name: 'browser.clear_marks',
    group: 'web',
    risk: 'write',
    desc: 'Remove all pink Set-of-Marks overlay numbers and cached refs — honest teardown marker (refs become ref_unknown after this).',
    params: { noParams: 'string: none (optional)' },
    examples: ['browser.clear_marks({})'],
    async run(_, ctx) {
      const session = ctx.session || 'default';
      journal.guard(session, 'browser.clear_marks');
      if (!isOpen(session)) return { ok: false, error: { code: 'browser_closed', message: 'no browser open' } };
      const b = await openFor({ session, cfgGet: (k) => ctx.cfg.get(k), signal:ctx.signal });
      await b.eval(CLEAR_JS).catch(() => undefined);
      clearRefs(session);
      return { ok: true, result: 'marks + cached refs cleared on the page', summary: 'marks cleared' };
    },
  }),
def({
    name: 'browser.close',
    group: 'web',
    risk: 'write',
    desc: 'Close this task’s browser window and give the slot back to the fleet.',
    params: {},
    async run(_, ctx) {
      recentShot.delete(ctx.session || 'default');
      clearForm(ctx.session || 'default');
      const closed = await closeFor(ctx.session || 'default', { wait: true });
      clearBrowserStagnation(ctx.session || 'default');
      return { ok: true, result: closed ? 'browser closed, slot released' : 'no browser was open for this task', meta: { closed }, summary: closed ? 'closed' : 'nothing open' };
    },
  }),
];

export { httpGet };
