/**
 * Compact page outline inspired by Playwright MCP accessibility snapshots.
 * Read-only. Avoid private text, input values and hidden nodes. The outline
 * guides model navigation; clickable refs remain provided by browser.elements.
 */
export const OUTLINE_JS = String.raw`(() => {
  const nodes = document.querySelectorAll('main,nav,header,footer,aside,form,section,h1,h2,h3,h4,[role="main"],[role="navigation"],[role="dialog"],[role="heading"]');
  const entries = [];
  const limit = 55;
  for (const el of nodes) {
    if (entries.length >= limit) break;
    if (el.closest('[hidden],[inert],[aria-hidden="true"]')) continue;
    const style = getComputedStyle(el), rect = el.getBoundingClientRect();
    if (style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0||rect.width===0||rect.height===0) continue;
    const tag=el.tagName.toLowerCase();
    const role=el.getAttribute('role')||({nav:'navigation',main:'main',aside:'complementary',form:'form'}[tag]||tag);
    // Never include descendant text for containers: it can contain user data.
    let name=el.getAttribute('aria-label')||el.getAttribute('title')||'';
    if (/^h[1-4]$/.test(tag) || role==='heading') name=el.innerText||name;
    if (el.getAttribute('aria-labelledby')) {
      const ids=el.getAttribute('aria-labelledby').trim().split(/\\s+/).slice(0,2);
      name=ids.map(id=>document.getElementById(id)?.innerText||'').join(' ')||name;
    }
    name=String(name).replace(/\\s+/g,' ').trim().slice(0,95);
    entries.push({role,level:/^h[1-4]$/.test(tag)?Number(tag[1]):null,
      name,tag});
  }
  return {url:location.href,title:document.title,entries};
})()`;

export function formatPageOutline(payload,{cap=45}={}) {
  const bounded=Number.isFinite(Number(cap))?Math.max(0,Math.min(55,Math.floor(Number(cap)))):45;
  const entries=Array.isArray(payload?.entries)?payload.entries.slice(0,bounded):[];
  const lines=entries.map(({role,level,name})=>
    '- '+String(role||'region').slice(0,24)+(level?' '+level:'')+
    (name?' "'+String(name).replace(/[\r\n"]/g,' ').slice(0,95)+'"':''));
  return 'Page structure — '+String(payload?.title||'').slice(0,100)+
    '\n'+(lines.join('\n')||'(no visible landmarks or headings)')+
    (Array.isArray(payload?.entries)&&payload.entries.length>bounded?'\n… more sections omitted':'');
}
