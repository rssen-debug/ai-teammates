/**
 * Compact semantic browser snapshot (inspired by Microsoft Playwright MCP).
 * Deliberately read-only, no form values, cookies, full HTML, or link URLs.
 * Agents get landmarks + headings + relevant interactive roles without
 * consuming huge model context or installing another browser daemon.
 */
export const SEMANTIC_SNAPSHOT_JS = String.raw`(() => {
  const safe = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 88);
  const visible = (el) => {
    if (!el || el.closest('[inert],[aria-hidden="true"]')) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' &&
      st.display !== 'none' && Number(st.opacity) > 0;
  };
  const pick = 'main,nav,aside,header,footer,h1,h2,h3,button,a,input,textarea,select,summary,[role="button"],[role="link"],[role="checkbox"],[role="textbox"]';
  const nodes = [...document.querySelectorAll(pick)].slice(0,65);
  // Like accessibility-first automation, inspect open shadow roots. Closed
  // roots remain opaque. Limit both scanned nodes and roots to avoid stalls.
  const roots = [document], seen = new Set();
  let shadowRoots = 0, scanned = 0;
  for (let index = 0; index < roots.length && index < 16 && scanned < 350; index++) {
    const root = roots[index];
    if (!root || seen.has(root)) continue;
    seen.add(root);
    const descendants = [...root.querySelectorAll('*')].slice(0, 350 - scanned);
    scanned += descendants.length;
    for (const node of descendants) {
      if (index > 0 && node.matches?.(pick) && nodes.length < 65) nodes.push(node);
      if (node.shadowRoot && roots.length < 16 && !seen.has(node.shadowRoot)) {
        roots.push(node.shadowRoot);
        shadowRoots++;
      }
    }
  }
  const out = [];
  for (const el of nodes) {
    if (out.length >= 65) break;
    if (!visible(el)) continue;
    const tag = el.tagName.toLowerCase();
    const type = String(el.getAttribute('type') || '').toLowerCase();
    if (['hidden','password','file'].includes(type)) continue;
    const role = String(el.getAttribute('role') ||
      ({a:'link',input:'textbox',textarea:'textbox',select:'combobox',nav:'navigation',aside:'complementary'}[tag] || tag));
    const label = el.getAttribute('aria-label') ||
      el.labels?.[0]?.textContent || el.getAttribute('placeholder') ||
      el.getAttribute('title') || (
        ['input','textarea','select'].includes(tag) ? '' : el.innerText
      ) || '';
    // Never read el.value, input text content or hidden form fields.
    out.push({role:safe(role),label:safe(label),level:/^h[1-6]$/.test(tag)?Number(tag[1]):null,
      disabled:el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true'});
  }
  return {url:location.origin + location.pathname,title:safe(document.title),elements:out,shadowRoots};
})()`;

export function formatSemanticSnapshot(payload,{cap=55}={}){
  if(!payload || !Array.isArray(payload.elements))return '(No accessible page structure)';
  const max=Math.max(1,Math.min(65,Math.floor(Number(cap)||55)));
  const lines=[`Page: ${String(payload.title||'Untitled').slice(0,88)}`,`URL: ${String(payload.url||'').slice(0,240)}`];
  for(const item of payload.elements.slice(0,max)){
    const role=String(item.role||'item').replace(/[\r\n]/g,' ').slice(0,24);
    const label=String(item.label||'').replace(/[\r\n]/g,' ').slice(0,88);
    const level=Number.isInteger(item.level)&&item.level>0?' level='+item.level:'';
    lines.push('- '+role+level+(label?' "'+label+'"':'')+(item.disabled?' (disabled)':''));
  }
  return lines.join('\n').slice(0,6500);
}
