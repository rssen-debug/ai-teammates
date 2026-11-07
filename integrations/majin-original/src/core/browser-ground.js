/**
 * MAJIN W6 POWER TRANSFER — Set-of-Marks grounding for the browser lane.
 *
 * Absorbed capability (provenance: browser-use/browser-use pattern of
 * numbered interactive elements with visual marks; adapted to MAJIN's OWN
 * CDP bridge in src/core/browser.js — zero new dependencies, no framework
 * copied). The overlay numbers stay on the page until cleared; every
 * element also gets data-majin-ref="eN" so browser.click({ref:"eN"}) is
 * stroke-deterministic instead of a CSS guess.
 *
 * Honesty: refs are of-the-moment. If the DOM re-renders the ref is stale —
 * the click surfaces ref_stale instead of mis-clicking a different node.
 */
export const VERSION = 'majin-ground/1';

/* runs INSIDE the page — annotated pink marks match the MAJIN cursor brand */
export const GROUND_JS = String.raw`(() => {
  document.querySelectorAll('.majin-mark').forEach((n) => n.remove());
  // agent-browser-inspired stable refs: retain a ref while its DOM node
  // survives. A replaced node gets a NEW identity; never recycle a stale ref.
  const used = new Set([...document.querySelectorAll('[data-majin-ref]')]
    .map(n => n.getAttribute('data-majin-ref')).filter(x => /^e[1-9][0-9]*$/.test(x)));
  let next = Number(window.__majinRefSequence || 0);
  for (const id of used) next = Math.max(next, Number(id.slice(1)));
  const SEL = 'a, button, input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="textbox"], [onclick], [contenteditable="true"]';
  const out = [];
  const nodes = [...document.querySelectorAll(SEL)];
  for (const el of nodes) {
    if (out.length >= 200) break; // match per-session cache cap; never display unclickable refs
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width < 4 || rect.height < 4) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    if (rect.bottom < 0 || rect.right < 0 || rect.top >= innerHeight || rect.left >= innerWidth) continue;
    if (el.closest('[inert], [aria-hidden="true"]')) continue;
    if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') continue;
    let ref = el.getAttribute('data-majin-ref');
    if (!ref || !/^e[1-9][0-9]*$/.test(ref)) {
      do { ref = 'e' + (++next); } while (used.has(ref));
      el.setAttribute('data-majin-ref', ref);
      used.add(ref);
    }
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const tag = el.tagName.toLowerCase();
    const type = String(el.getAttribute('type') || el.type || '').toLowerCase();
    // Model grounding must NEVER expose values typed into form controls.
    const sensitive = ['password', 'hidden', 'file'].includes(type) ||
      el.getAttribute('autocomplete') === 'one-time-code';
    const label = el.labels?.[0]?.textContent || el.getAttribute('aria-label') ||
      (el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent) ||
      el.getAttribute('placeholder') || el.getAttribute('title') || el.name || '';
    const text = String((tag === 'input' || tag === 'textarea' || tag === 'select') ?
      (label || (sensitive ? '[sensitive field]' : tag)) :
      (el.innerText || label || el.href || tag))
      .replace(/\s+/g, ' ').trim().slice(0, 70);
    const mark = document.createElement('div');
    mark.className = 'majin-mark';
    mark.textContent = ref.replace('e', '');
    mark.style.cssText = 'position:fixed;left:' + (rect.left + 2) + 'px;top:' + (rect.top + 2) + 'px;z-index:2147483647;background:#ff3ca5;color:#fff;font:700 11px/14px system-ui;padding:1px 5px;border-radius:9px;pointer-events:none;box-shadow:0 0 8px rgba(255,60,165,.8);';
    document.body.appendChild(mark);
    out.push({ ref, tag, role: el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'input' ? (el.type || 'input') : tag), type: el.type || null, text, name: el.name || null, id: el.id || null, href: el.href || null, disabled: Boolean(el.disabled), cx: Math.round(cx), cy: Math.round(cy) });
  }
  window.__majinRefSequence = next;
  return { url: location.href, title: document.title, count: out.length, elements: out };
})()`;

export const CLEAR_JS = `(() => { document.querySelectorAll('.majin-mark').forEach((n) => n.remove()); document.querySelectorAll('[data-majin-ref]').forEach((n) => n.removeAttribute('data-majin-ref')); delete window.__majinRefSequence; return true; })()`;

/* Browser snapshot deltas: per-session, read-only, bounded, no secret values.
 * Every changed ref remains the CURRENT page's ref; unchanged is reported
 * only when ref identities and visible descriptions all match.
 */
const snapshotBases = new Map();
export function diffGroundSnapshot(session,payload,{query='',reset=false,cap=60}={}){
  const key=String(session)+'::'+String(query||'').slice(0,100);
  const url=String(payload?.url||'');
  const elements=Array.isArray(payload?.elements)?payload.elements.slice(0,200):[];
  const signatures=new Map(elements.map(e=>[String(e.ref),
    JSON.stringify([e.tag,e.role,e.text,e.id,e.name,e.href,e.disabled,e.type])]));
  const previous=reset?null:snapshotBases.get(key);
  snapshotBases.set(key,{url,signatures});
  if(!previous||previous.url!==url){
    return {mode:'full',changes:elements.slice(0,cap),removed:[],count:elements.length};
  }
  const changed=elements.filter(e=>previous.signatures.get(String(e.ref))!==signatures.get(String(e.ref)));
  const removed=[...previous.signatures.keys()].filter(ref=>!signatures.has(ref)).slice(0,cap);
  const fullSize=JSON.stringify(elements).length;
  const deltaSize=JSON.stringify(changed).length+JSON.stringify(removed).length;
  if(!changed.length&&!removed.length)return {mode:'unchanged',changes:[],removed:[],count:elements.length};
  if(elements.length>5 && deltaSize>=fullSize*.85)return {mode:'full',changes:elements.slice(0,cap),removed:[],count:elements.length};
  return {mode:'delta',changes:changed.slice(0,cap),removed,count:elements.length};
}
export function clearGroundSnapshot(session){
  const prefix=String(session)+'::';
  for(const key of snapshotBases.keys())if(key.startsWith(prefix))snapshotBases.delete(key);
}

/* per-session reference cache: session -> Map(ref -> descriptor) */
const cache = new Map();

export function rememberRefs(session, elements, { cap = 200 } = {}) {
  const m = new Map();
  for (const e of elements.slice(0, cap)) m.set(e.ref, e);
  cache.set(String(session), m);
  return m;
}
export function recallRef(session, ref) {
  return cache.get(String(session))?.get(String(ref)) || null;
}
export function clearRefs(session) {
  cache.delete(String(session));
  clearGroundSnapshot(session);
}

export function groundSummary(el) {
  return [elementsLine(el)].join(' ');
}
function elementsLine(el) {
  const d = el.disabled ? ' (disabled)' : '';
  return `[${el.ref}] ${el.tag}${el.role !== el.tag ? '/' + el.role : ''} "${el.text}"${el.href ? ' → ' + el.href.slice(0, 60) : ''}${el.name ? ' name=' + el.name : ''}${d}`;
}

/**
 * Compact DOM-find inspired by Playwright MCP's browser_find.
 * Filter only grounded control metadata, never inspect hidden input values.
 * Element refs remain attached to the complete fresh snapshot/cache.
 */
export function findGroundedControls(elements, query, { cap = 12 } = {}) {
  const q = String(query || '').trim().toLocaleLowerCase().slice(0, 100);
  if (!q) return [];
  const words=q.split(/\s+/).filter(Boolean);
  const scored=[];
  for (const el of Array.isArray(elements) ? elements : []) {
    const name=[el.text,el.role,el.tag,el.name,el.id].filter(Boolean).join(' ').toLocaleLowerCase();
    const hits=words.filter(word=>name.includes(word)).length;
    if(!hits)continue;
    const exact=String(el.text||'').toLocaleLowerCase()===q;
    scored.push({el,score:(exact?100:0)+hits*10+(name.startsWith(q)?3:0)});
  }
  scored.sort((a,b)=>b.score-a.score);
  return scored.slice(0,Math.max(1,Math.min(30,Math.floor(Number(cap)||12)))).map(x=>x.el);
}

export function renderElementsText(payload, { cap = 60 } = {}) {
  const els = (payload.elements || []).slice(0, cap);
  const more = (payload.elements || []).length > cap ? `\n… +${payload.elements.length - cap} more (cap ${cap})` : '';
  const lines = els.map(elementsLine);
  return `${payload.title || '(no title)'} — ${payload.url || ''}\n${payload.count} interactive elements (numbered pink marks drawn on the page):\n${lines.join('\n')}${more}`;
}
