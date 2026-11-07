/**
 * Browser task evidence, inspired by Playwright's assertions and agent-browser's
 * observe/act/verify separation. Evaluates read-only DOM state, never performs
 * an action or infers "success" from an HTTP 200 / successful click.
 */
// Read native validity flags without checkValidity/reportValidity (both fire events).
// Values, password contents, files and validationMessage text are never returned.
export const FORM_STATE_JS=String.raw`(() => {
 const out=[];
 for(const el of Array.from(document.querySelectorAll('input,select,textarea')).slice(0,120)){
  const rect=el.getBoundingClientRect(),style=getComputedStyle(el);
  if(!rect.width||!rect.height||style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0||el.disabled)continue;
  const v=el.validity;if(!v)continue;
  const problems=['valueMissing','typeMismatch','patternMismatch','tooLong','tooShort','rangeUnderflow','rangeOverflow','stepMismatch','badInput','customError'].filter(k=>v[k]);
  out.push({id:String(el.id||'').slice(0,100),name:String(el.name||'').slice(0,100),type:String(el.type||el.tagName).toLowerCase(),filled:el.type==='checkbox'||el.type==='radio'?Boolean(el.checked):Boolean(el.value),required:Boolean(el.required),valid:v.valid,problems});
 }
 return out;
})()`;

export function formatFormState(rows){
  if(!Array.isArray(rows)||!rows.length)return '';
  return '\n\nForm field state (values hidden; native browser constraints):\n'+rows.map(r=>
    '- '+(r.id?'#'+r.id:r.name||r.type)+': '+(r.filled?'filled/selected':'EMPTY/unchecked')+(r.required?' required':'')+(r.valid?' valid':' INVALID '+r.problems.join(', '))
  ).join('\n');
}

export const VERIFY_JS = String.raw`((args) => {
  const selector = args.selector || '';
  let el = null, count = 0;
  try {
    if (selector) {
      // Same bounded open-shadow-root traversal as MAJIN's click path.
      // A verifier must be able to observe the control the agent just clicked.
      // Closed shadow roots remain inaccessible and are never assumed to pass.
      const roots=[document],matches=[];
      let scanned=0;
      for(let i=0;i<roots.length && i<16 && scanned<350;i++){
        const root=roots[i];
        matches.push(...root.querySelectorAll(selector));
        const candidates=root.querySelectorAll('*');
        for(const node of Array.from(candidates).slice(0,350-scanned)){
          scanned++;
          if(node.shadowRoot && roots.length<16 && !roots.includes(node.shadowRoot))
            roots.push(node.shadowRoot);
        }
      }
      count=matches.length;
      // Never silently validate the first of multiple matching controls.
      if(count===1)el=matches[0];
    }
  } catch { return { valid: false, reason: 'invalid_selector' }; }
  const visible = (node) => {
    if (!node) return false;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
  };
  // No inputs, password values, page HTML, cookies or tokens are returned.
  const text = el ? String(el.innerText || el.textContent || '') : '';
  const state = { valid: true, url: location.href, title: document.title,
    exists: selector ? count > 0 : null, unique: selector ? count === 1 : null,
    matchCount: selector ? count > 1000 ? 1001 : count : null, fromShadowRoot: Boolean(el?.getRootNode?.()?.host), visible: selector ? visible(el) : null,
    checked: el?.matches?.('input[type="checkbox"],input[type="radio"]') ? !!el.checked : null,
    enabled: el ? !el.matches(':disabled,[aria-disabled="true"],[inert]') && !el.closest('[inert]') : null,
    textMatch: args.text ? text.toLowerCase().includes(args.text.toLowerCase()) : null,
    urlMatch: args.url ? location.href.includes(args.url) : null,
    pathMatch: args.urlPath ? location.pathname === args.urlPath : null,
    originMatch: args.urlOrigin ? location.origin === args.urlOrigin : null,
    titleMatch: args.title ? document.title.toLowerCase().includes(args.title.toLowerCase()) : null,
  };
  return state;
})(__MAJIN_ARGS__)`;

export function verificationCriteria(input = {}) {
  const selector = String(input.selector || '').trim().slice(0, 350);
  const text = String(input.text || '').trim().slice(0, 200);
  const url = String(input.url || '').trim().slice(0, 350);
  // Exact URL assertions prevent a redirect target or a query parameter such
  // as ?next=/dashboard from masquerading as a successful navigation.
  const urlPath = String(input.urlPath || '').trim().slice(0, 350);
  const urlOrigin = String(input.urlOrigin || '').trim().slice(0, 350);
  if(urlPath && (!urlPath.startsWith('/') || urlPath.startsWith('//') || urlPath.includes('?') || urlPath.includes('#') || /[\u0000-\u001f\u007f]/.test(urlPath)))
    return {ok:false,reason:'urlPath must be an absolute pathname (for example /dashboard), with no query or fragment'};
  if(urlOrigin){
    try {
      const parsed=new URL(urlOrigin);
      if(!['http:','https:'].includes(parsed.protocol) || parsed.origin !== urlOrigin || parsed.username || parsed.password)
        return {ok:false,reason:'urlOrigin must be an exact HTTP(S) origin'};
    } catch { return {ok:false,reason:'urlOrigin must be an exact HTTP(S) origin'}; }
  }
  const title = String(input.title || '').trim().slice(0, 200);
  const present = [true,false,'true','false'].includes(input.present) ? (input.present===true || input.present==='true') : null;
  const checked = [true,false,'true','false'].includes(input.checked) ? (input.checked===true || input.checked==='true') : null;
  const enabled = [true,false,'true','false'].includes(input.enabled) ? (input.enabled===true || input.enabled==='true') : null;
  // Explicit list/card count assertions: unlike clicks, lists can legitimately
  // contain many matches. Stay read-only and don't inspect element values.
  const countRaw = input.count;
  const hasCount = countRaw !== undefined && countRaw !== null && (typeof countRaw !== 'string' || countRaw.trim() !== '');
  const count = hasCount ? Number(countRaw) : null;
  if(hasCount && !['number','string'].includes(typeof countRaw))
    return {ok:false,reason:'count must be numeric'};
  if(hasCount && (!Number.isSafeInteger(count) || count<0 || count>1000))
    return {ok:false,reason:'count must be a whole number between 0 and 1000'};
  if(hasCount && (!selector || text || checked!==null || enabled!==null || present!==null))
    return {ok:false,reason:'count needs selector and cannot combine with text/checked/enabled/present'};
  if (!selector && !url && !title && !urlPath && !urlOrigin) return { ok:false, reason:'Specify a selector, URL fragment, exact URL path/origin, or title fragment to verify' };
  if ((text || present !== null || checked !== null || enabled !== null) && !selector) return {ok:false, reason:'Element text, presence and checkbox checks require selector'};
  if (checked !== null && !selector) return {ok:false, reason:'Checkbox assertion requires selector'};
  if (present === false && (text || checked !== null || enabled !== null))
    return {ok:false, reason:'An absent element cannot also have matching text or checkbox state'};
  return { ok:true, selector, text, url, urlPath, urlOrigin, title, present, checked, enabled, count };
}

export function verifyObserved(criteria, observed) {
  if (!criteria?.ok) return {ok:false, reason:criteria?.reason || 'invalid_expectation'};
  if (!observed?.valid) return {ok:false, reason:observed?.reason || 'observation_failed'};
  const assertions = [];
  if (criteria.selector) {
    if (criteria.count !== null && criteria.count !== undefined) {
      assertions.push({name:'element_count_exact',expected:criteria.count,actual:observed.matchCount});
    } else {
    assertions.push({name:'element_present', expected:criteria.present ?? true, actual:observed.exists === true});
    if (criteria.present !== false) {
      assertions.push({name:'element_unique',expected:true,actual:observed.unique === true});
      assertions.push({name:'element_visible',expected:true,actual:observed.visible === true});
      if (criteria.text) assertions.push({name:'element_text_contains',expected:true,actual:observed.textMatch === true});
      if (criteria.checked !== null) assertions.push({name:'checkbox_checked',expected:criteria.checked,actual:observed.checked});
      if (criteria.enabled !== null) assertions.push({name:'element_enabled',expected:criteria.enabled,actual:observed.enabled});
    }
    }
  }
  if (criteria.url) assertions.push({name:'url_contains',expected:true,actual:observed.urlMatch === true});
  if (criteria.urlPath) assertions.push({name:'url_path_exact',expected:true,actual:observed.pathMatch === true});
  if (criteria.urlOrigin) assertions.push({name:'url_origin_exact',expected:true,actual:observed.originMatch === true});
  if (criteria.title) assertions.push({name:'title_contains',expected:true,actual:observed.titleMatch === true});
  const failures = assertions.filter(x=>x.expected!==x.actual);
  return {ok:failures.length===0,assertions,failures,
    observed:{url:String(observed.url||'').slice(0,500),title:String(observed.title||'').slice(0,200),
      matchCount:Number.isInteger(observed.matchCount) ? observed.matchCount : null, fromShadowRoot:observed.fromShadowRoot===true}};
}

/**
 * Select a bounded, evidence-grounded recovery plan after failed browser.verify.
 * Inspired by browser-use's explicit failure feedback. NEVER auto-repeats an
 * irreversible click, and never leaks field values or full page text.
 */
export function browserRecoveryAdvice(verdict, criteria, controls = []) {
  if (verdict?.ok) return { action:'none', hint:'Outcome verified', candidates:[] };
  const names = new Set((verdict?.failures || []).map(f=>f.name));
  let action='inspect_page', hint='Inspect live page state with browser.read or browser.elements before choosing a new action.';
  if (names.has('element_count_exact')) {
    action='inspect_result_count'; hint='Expected result count differs from the page. Re-read the list after rendering settles; never assume a capped count proves success.';
  } else if (names.has('element_unique')) {
    action='narrow_selector'; hint='Selector matches multiple elements. Use browser.elements and an exact unique ref; do not guess a different nth-child.';
  } else if (names.has('element_present')) {
    action='refresh_grounding'; hint='Expected control or confirmation is absent. Re-read the current page and refresh element refs; do not repeat the previous click blindly.';
  } else if (names.has('element_visible')) {
    action='inspect_overlay'; hint='Element exists but is not visible. Inspect tab/modal, scrolling or loading state before interacting.';
  } else if (names.has('element_enabled')) {
    action='resolve_prerequisites'; hint='Control disabled. Inspect required fields, checkboxes, or validation messages first.';
  } else if (names.has('checkbox_checked')) {
    action='inspect_checkbox'; hint='Observed checkbox state differs from the goal. Inspect its label and active state; do not infer success from the click.';
  } else if (names.has('url_contains') || names.has('url_path_exact') || names.has('url_origin_exact') || names.has('title_contains')) {
    action='inspect_navigation'; hint='Expected destination not observed. Inspect the actual URL origin, pathname, title, and whether navigation opened another tab; never trust a matching query parameter or redirect hint.';
  } else if (names.has('stable_duration')) {
    action='wait_or_inspect'; hint='Outcome appeared temporarily but did not remain stable. Inspect SPA rerender or server response; do not declare success.';
  } else if (names.has('element_text_contains')) {
    action='inspect_content'; hint='Expected confirmation text not visible in target. Inspect the actual result and errors without inventing success.';
  }
  const safe = Array.isArray(controls) ? controls.filter(c=>typeof c?.selector==='string' && c.selector.length<=100).slice(0,5)
    .map(c=>({selector:c.selector, label:String(c.label||'').slice(0,60),type:String(c.type||'').slice(0,20)})) : [];
  return {action,hint,candidates:safe,expectedSelector:String(criteria?.selector||'').slice(0,350)};
}
