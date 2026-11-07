/* MAJIN — UI. No framework, no CDN. One document, two scripts. */
const TOKEN = (window.__MAJIN_TOKEN__ || 'demo');
const S = { session: 'desktop', busy: false, st: null, voice: false, cur: null, curBody: '', tools: null, gauge: null, t0: 0 };
/* labels "const" in classic scripts do NOT get sticky on window — the chat
   list module (chats.js) reads window.S, so expose the ONE source-of-truth
   state explicitly. Without this, clicks update a ghost object while the
   real session never moves (caught by gate P0.6b). */
window.S = S;
const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const setStatus = (t) => {
  const n = $('status');
  if (n) n.textContent = t;
};
const toast = (t) => {
  const n = el('div', '', esc(t));
  $('toast').append(n);
  setTimeout(() => n.remove(), 5200);
};

async function api(p, o = {}) {
  const body = o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body;
  const r = await fetch('/api' + p + (p.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(TOKEN), {
    ...o,
    body,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN, ...(o.headers || {}) },
  });
  const j = await r.json().catch(() => ({ __http: r.status }));
  if (!r.ok) throw new Error(j && j.error ? j.error : 'http ' + r.status);
  return j;
}

/* ------------------------------- markdown-lite --------------------------- */
function md(t) {
  let s = String(t == null ? '' : t);
  const blocks = [];
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    const isMindmap = String(_lang).toLowerCase() === 'mindmap' && window.MAJIN_MINDMAP;
    blocks.push(isMindmap ? window.MAJIN_MINDMAP.render(code) : '<pre>' + esc(String(code).replace(/\n$/, '')) + '</pre>');
    return '\u0000' + (blocks.length - 1) + '\u0000';
  });
  s = esc(s);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/gm, '$1<i>$2</i>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  // Plain URLs should be clickable too. Input is already HTML-escaped;
  // this runs after markdown links and never matches inside href="...".
  s = s.replace(/(^|[\s>(])(https?:\/\/[^\s<>"']+)/gm, (_m, prefix, raw) => {
    const url = raw.replace(/[.,!?;:]+$/, '');
    const tail = raw.slice(url.length);
    return prefix + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>' + tail;
  });
  s = s.replace(/(?:^|\n)(#{1,6})\s*(.+)$/gm, (_m, h, txt) => `\n<span style="color:var(--cy);letter-spacing:.08em">${txt}</span>\n`);
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i) => blocks[Number(i)]);
  // Workspace files mentioned in a completed answer should be OPENABLE, not
  // dead inline code. The local /api/file endpoint enforces workspace bounds;
  // only a tightly restricted relative file path gets an action.
  s = s.replace(/<code>(workspace[\\/][\w .\\/\-]+\.(?:html?|md|txt|json|css|js|ts|jsx|tsx|py|csv|svg))<\/code>/gi,
    (_m, file) => '<code>' + file + '</code> <button type="button" class="chat-open-file" data-majin-file="' +
      encodeURIComponent(file) + '" aria-label="Preview ' + file.split(/[\\/]/).pop() + '">Open preview</button>');

  return s;
}

/* ------------------------------- transcript ----------------------------- */
function scroll(force = false) {
  const s = $('scroller');
  if (!force && S.readingHistory) return;
  // V1: avoid redundant scroll writes during streamed responses.
  const target = s.scrollHeight;
  if (force || s.scrollTop + s.clientHeight < target - 1) s.scrollTop = target;
}
$('scroller').addEventListener('scroll', () => {
  const n = $('scroller'); S.readingHistory = n.scrollHeight - n.clientHeight - n.scrollTop > 100;
});

/* File previews are delegated because streamed answers continuously replace
   their markup. No untrusted paths are executed as commands. */
document.getElementById('scroller')?.addEventListener('click', (event) => {
  const button = event.target.closest?.('button.chat-open-file');
  if (!button) return;
  const encoded = button.getAttribute('data-majin-file') || '';
  let file = '';
  try { file = decodeURIComponent(encoded); } catch { return; }
  if (!/^workspace[\\/][A-Za-z0-9_ .\\/\-]+\.(?:html?|md|txt|json|css|js|ts|jsx|tsx|py|csv|svg)$/i.test(file)) return;
  window.MAJIN_STUDIO?.previewFile(file.replace(/^workspace[\\/]/i, ''));
});

function addMsg(cls, who, text) {
  const welcome = $('home');
  if (welcome) welcome.remove();
  const m = el('div', 'msg ' + cls);
  m.append(el('div', 'who', who));
  const b = el('div', 'body');
  if (text != null) b.innerHTML = md(text);
  m.append(b);
  $('scroller').append(m);
  scroll();
  return { m, b };
}
const note = (t) => addMsg('sys', 'MAJIN · notis', t);
function err(t) {
  if (!S.busy) return addMsg('err', 'MAJIN', t);
  if (S.failed) return;
  S.failed = true;
  if (window.MAJIN_IMAGINE) window.MAJIN_IMAGINE.onEvent({ type: 'error', message: t });
  const a = ensureAgent();
  a.b.classList.remove('caret');
  if (a.thinking) a.thinking.remove();
  a.m.classList.add('err');
  const title = /\b(401|403)\b|unauthorized|authentication/i.test(t) ? 'Check your provider connection'
    : /\b402\b|credits|balance/i.test(t) ? 'Provider credits are needed'
    : /\b429\b|rate.limit/i.test(t) ? 'This provider is busy'
    : /not a valid model|model.*(not found|not available)|invalid.*model/i.test(t) ? "This model isn't available"
    : /\b5\d\d\b/.test(t) ? 'The provider is temporarily unavailable' : 'The request could not finish';
  a.b.textContent = '';
  a.b.append(el('strong', '', esc(title)), el('p', '', 'Your message is saved. Choose another model or retry when the connection is ready.'));
  const actions = el('div', 'error-actions');
  const choose = el('button', '', 'Choose a model');
  choose.onclick = () => window.MAJIN_ONBOARD.togglePicker();
  const failedInput = S.lastInput;
  const retry = el('button', '', 'Retry message');
  retry.onclick = () => { if (!S.busy) send(failedInput); };
  const details = el('details', 'error-details');
  details.append(el('summary', '', 'Technical details'), el('pre', '', esc(t)));
  actions.append(choose, retry); a.b.append(actions, details);
  setStatus('Request failed');
  scroll();
}

function ensureAgent() {
  if (S.cur) return S.cur;
  const o = addMsg('majin', 'MAJIN');
  S.cur = { b: o.b, m: o.m, thinking: null };
  S.curBody = '';
  o.b.classList.add('caret');
  return S.cur;
}
function appendDelta(t) {
  const a = ensureAgent();
  S.curBody += t;
  a.b.innerHTML = md(S.curBody);
  a.b.classList.add('caret');
  scroll();
}
function setThinking(t) {
  const a = ensureAgent();
  if (!a.thinking) {
    a.thinking = el('div', 'kv', '');
    a.thinking.style.cssText = 'font-style:italic;opacity:.7;margin-bottom:4px';
    a.m.prepend(a.thinking);
  }
  a.thinking.textContent = '… ' + String(t).slice(-160);
}
function toolRow(name, extra) {
  const a = ensureAgent();
  let row = a.tools;
  if (!row) {
    row = el('div', 'tools');
    a.m.append(row);
    a.tools = row;
  }
  const t = el('span', 'tl run', esc(name) + '<span class="ms">' + (extra || '') + '</span>');
  const trace = el('div', 'trace');
  t.dataset.k = 'k' + Math.random().toString(36).slice(2, 7);
  trace.id = 'tr-' + t.dataset.k;
  t.onclick = () => trace.classList.toggle('open');
  row.append(t);
  a.m.append(trace);
  return { chip: t, trace };
}
function finishTool(chip, trace, ok, text, ms, spilled) {
  chip.classList.remove('run');
  chip.classList.add(ok ? 'good' : 'bad');
  chip.innerHTML = esc(chip.textContent.replace(/\d+(\.\d+)?s$/, '').trim()) + '<span class="ms">' + ms + '</span>';
  if (text) {
    trace.textContent = String(text).slice(0, 6000) + (spilled ? `\n\n… full result: ${spilled}` : '');
  }
}
function moaGauge(ev) {
  const a = ensureAgent();
  if (!a.moa) {
    a.moa = el('div', 'foot');
    a.m.append(a.moa);
  }
  if (ev.type === 'moa:start') a.moa.innerHTML = '<span class="gauge">MOA ' + ev.width + ' references ▸ '.repeat(Math.min(3, ev.width)) + '</span>';
  if (ev.type === 'moa:ref') a.moa.innerHTML += '<span class="kv">· ' + esc(ev.ref) + ' ' + (ev.ok ? (ev.ms || '') + 'ms' : 'error') + '</span>';
  if (ev.type === 'moa:done') {
    const score = Math.round((ev.score || 0) * 100);
    a.moa.innerHTML = `<span class="gauge">MOA ${ev.refs} refs · agreement ${score}%</span><span class="bar"><i style="width:${score}%"></i></span> <span class="kv">aggregator ${(ev.ms || 0)}ms${ev.escalated ? '  · escalated' : ''}</span>`;
  }
  if (ev.type === 'moa:degraded') a.moa.innerHTML = '<span class="kv" style="color:var(--warn)">MOA degraded: ' + esc(ev.reason || '') + '</span>';
  scroll();
}

/* Work pulse: honest current phase and time since last server event.
   Never claim success while the model is idle or a tool is stuck. */
let workLastEvent=0,workPhase='Starting';
function workPulse(phase){
  if(!S.busy)return;
  if(phase)workPhase=String(phase).slice(0,130);
  workLastEvent=Date.now();
  const bar=$('work-progress');
  if(bar){
    bar.hidden=false;
    bar.dataset.phase=/verif|validat|check|kontroll/i.test(workPhase)?'verify':
      /fail|error|failed|block|stuck/i.test(workPhase)?'problem':'active';
    const glyph=$('work-progress-symbol');
    if(glyph)glyph.textContent=bar.dataset.phase==='verify'?'◇':bar.dataset.phase==='problem'?'!':'✦';
  }
}
setInterval(()=>{
  const bar=$('work-progress');if(!bar)return;
  bar.hidden=!S.busy;
  if(!S.busy)return;
  const total=Math.floor((Date.now()-S.t0)/1000);
  const silent=Math.floor((Date.now()-(workLastEvent||S.t0))/1000);
  const stalled=silent>=18;
  // The existing inline spirit ember changes colour only when event
  // evidence has gone quiet; it does not claim the operation has failed.
  if(stalled && bar.dataset.phase!=='problem')bar.dataset.phase='stalled';
  if(stalled && $('work-progress-symbol'))$('work-progress-symbol').textContent='·';
  if($('work-progress-label'))$('work-progress-label').textContent=
    stalled ? workPhase+' · No update for '+silent+'s — still waiting for the current operation' : workPhase;
  if($('work-progress-timer'))$('work-progress-timer').textContent=total+'s';
},1000);

/* ------------------------------ event pump ------------------------------ */
function onEvent(ev) {
  if (S.busy) {
    if (ev.type === 'route') workPulse('Choosing the best model');
    else if (ev.type === 'step') workPulse('Step '+ev.step+'/'+ev.of+' · '+(ev.model||'model'));
    else if (ev.type === 'tool' || ev.type === 'tool_begin') workPulse('Using '+(ev.name||ev.tool||'a tool'));
    else if (ev.type === 'tool_waiting') {
      const elapsed=Math.round(Math.max(0,Number(ev.elapsedMs)||0)/1000);
      workPulse('Still using '+String(ev.tool||'tool').slice(0,60)+' · '+elapsed+'s');
      const bar=$('work-progress');
      if(bar){
        bar.dataset.phase='waiting';
        bar.title='MAJIN has not received a result from '+String(ev.tool||'this tool')+' yet. This is a heartbeat, not a success confirmation.';
      }
      if($('work-progress-symbol'))$('work-progress-symbol').textContent='◌';
    }
    else if (ev.type === 'tool_result') {
      if(ev.tool==='browser.click' && !ev.ok && ev.error?.reason==='occluded'){
        const controls=Array.isArray(ev.error.recoveryControls)?ev.error.recoveryControls:[];
        const hint=controls[0]?.label?' · '+String(controls[0].label).slice(0,35):'';
        workPulse('Button covered by another element'+hint);
        const bar=$('work-progress');
        if(bar){
          bar.dataset.phase='obstructed';
          bar.title='MAJIN did not click the covered button. It is inspecting the visible blocker and choosing a different action.';
        }
        if($('work-progress-symbol'))$('work-progress-symbol').textContent='↳';
      }
      else if(ev.tool==='browser.read' && ev.ok && ev.meta?.stagnation?.stagnant===true){
        const n=Math.min(20,Number(ev.meta.stagnation.unchangedActions)||0);
        workPulse('Page unchanged after '+n+' actions · changing approach');
        const bar=$('work-progress');
        if(bar){bar.dataset.phase='stagnation';bar.title='Live page fingerprint has not changed after multiple actions. Re-observe and pick a new strategy; no automatic click is repeated.';}
        const glyph=$('work-progress-symbol');if(glyph)glyph.textContent='↝';
      }
      else if(ev.tool==='browser.read' && ev.ok && ev.meta?.mode==='compact'){
        const original=Math.max(0,Number(ev.meta.sourceChars)||0);
        const delivered=Math.max(0,Number(ev.meta.visibleChars)||0);
        workPulse('Page distilled · '+delivered+'/'+original+' chars');
        const bar=$('work-progress');
        if(bar){
          bar.dataset.phase='compact';
          bar.title='Condensed browser text from '+original+' to '+delivered+' characters; original page remains unchanged';
        }
        if($('work-progress-symbol'))$('work-progress-symbol').textContent='✧';
      }
      else if(ev.tool==='browser.click' && ev.ok){
        // A successful click is not the same thing as a verified remote effect.
        const receipt=ev.meta?.receipt;
        if(receipt?.status==='browser_completed' && receipt.evidence==='action_only'){
          workPulse('Click sent · awaiting proof of page change');
          const bar=$('work-progress');if(bar){bar.dataset.phase='action';bar.title='Action executed locally; remote result has not been verified';}
        }
        const verified=ev.meta?.verified===true;
        if(verified){
          workPulse('Browser result verified');
          const bar=$('work-progress');if(bar)bar.dataset.phase='verified';
          if($('work-progress-symbol'))$('work-progress-symbol').textContent='✓';
        } else if(!receipt || receipt.evidence!=='action_only'){
          workPulse('Click sent · checking its effect');
          const bar=$('work-progress');if(bar)bar.dataset.phase='action';
        }
      } else if(ev.tool==='browser.fill'){
        const confirmed=ev.ok===true && ev.meta?.retained===true;
        workPulse(confirmed?'Field retained · verified':'Form field not confirmed · reviewing target');
        const bar=$('work-progress');
        if(bar){
          bar.dataset.phase=confirmed?'verified':'problem';
          bar.title=confirmed?'Browser confirmed the field still contained the requested input after an app update. Input content is never shown.':'Browser did not verify the input; no form success is claimed.';
        }
        const glyph=$('work-progress-symbol');if(glyph)glyph.textContent=confirmed?'✓':'!';
      } else if(ev.tool==='browser.shot' && ev.ok){
        const unchanged=ev.meta?.unchanged===true;
        workPulse(unchanged?'Screenshot unchanged · keeping previous view':'Screenshot captured · visual evidence ready');
        const bar=$('work-progress');
        if(bar){bar.dataset.phase=unchanged?'delta':'visual';bar.title=unchanged?
          'The new screenshot matches the previous image exactly':'A new screenshot was saved for visual inspection';}
        const glyph=$('work-progress-symbol');if(glyph)glyph.textContent=unchanged?'=':'◉';
      } else if(ev.tool==='browser.verify' && !ev.ok){
        const plan=ev.error?.recovery || ev.meta?.recovery || {};
        const action=String(plan.action||'inspect_page').replace(/[^a-z_]/gi,'').slice(0,32);
        const navigation=action==='inspect_navigation';
        workPulse(navigation?'Destination not confirmed · checking page':'Verification failed · choosing a safer next step');
        const bar=$('work-progress');if(bar){
          bar.dataset.phase=navigation?'navigation':'recovery';
          bar.title='Live verification failed. Recovery: '+action+'. No action has been repeated automatically.';
        }
        const glyph=$('work-progress-symbol');if(glyph)glyph.textContent=navigation?'↗':'↻';
      } else if(ev.tool==='browser.verify' && ev.ok){
        const shadow=ev.meta?.observed?.fromShadowRoot===true;
        workPulse(shadow?'Shadow DOM control verified':'Browser result verified');
        const bar=$('work-progress');
        if(bar){
          bar.dataset.phase=shadow?'shadow-verified':'verified';
          bar.title=shadow?'Verified a unique accessible control inside an open shadow root':'Confirmed against the live page — not just a successful click';
        }
        const glyph=$('work-progress-symbol');if(glyph){glyph.textContent='✓';if(shadow)glyph.textContent='✧';}
      } else if(ev.tool==='browser.read' && ev.ok && ev.meta?.mode==='structure'){
        const count=Math.max(0,Number(ev.meta?.count)||0);
        workPulse('Mapping page structure · '+count+' accessible elements');
        const bar=$('work-progress');if(bar){bar.dataset.phase='structure';bar.title='Read-only page outline; no form values or passwords';}
      } else if(ev.tool==='browser.elements' && ev.ok){
        if(ev.meta?.deltaMode==='unchanged'){
          workPulse('Page unchanged · existing controls still visible');
          const bar=$('work-progress');if(bar)bar.dataset.phase='delta';
        } else if(ev.meta?.deltaMode==='delta'){
          const changed=Math.max(0,Number(ev.meta?.changed)||0);
          const removed=Math.max(0,Number(ev.meta?.removed)||0);
          workPulse(changed+' updated controls · '+removed+' removed');
          const bar=$('work-progress');if(bar)bar.dataset.phase='delta';
        } else {
        const matched=Number(ev.meta?.matched);
        const total=Number(ev.meta?.count);
        const count=Number.isFinite(matched)&&matched>=0 ? matched :
          Number.isFinite(total)&&total>=0 ? total : null;
        workPulse(count===null?'Reading controls on the page':
          count+' interactive controls found');
        const bar=$('work-progress');if(bar)bar.dataset.phase='grounded';
        }
      } else if(ev.tool==='browser.click' && !ev.ok && ev.error?.code==='click_blocked') {
        const reason=String(ev.error?.reason||'').slice(0,50);
        const phrases={occluded:'Another element covers the button · checking the page',
          disabled:'Button unavailable · checking required steps',
          hidden:'Button hidden · finding visible controls',
          outside_viewport:'Control off-screen · inspecting the page',
          ref_identity_changed:'Page changed · finding the current button'};
        workPulse(phrases[reason]||'Click blocked · finding a safe alternative');
        const bar=$('work-progress');
        if(bar){bar.dataset.phase='blocked';bar.dataset.blocker=reason;
          bar.title='MAJIN will re-observe the page rather than repeatedly clicking a blocked control';}
      } else workPulse(ev.ok?'Tool finished · checking result':'Tool failed · adjusting approach');
    }
    else if (ev.type === 'browser_recovery') {
      const names={refresh_page:'Refreshing page controls',inspect_blocker:'Inspecting a blocked element',
        verify_failed:'Checking why the result differs',reconnect:'Checking browser connection',
        outcome_unknown:'Checking whether the action actually finished',stop_repeat:'Changing strategy'};
      const stage=names[ev.phase]||'Recovering safely';
      const tool=String(ev.next||'').replace(/[^a-zA-Z0-9._-]/g,'').slice(0,32);
      workPulse(tool?stage+' · '+tool:stage);
      const bar=$('work-progress');
      if(bar){bar.dataset.phase='recover';bar.dataset.recovery=String(ev.phase||'').slice(0,35);
        bar.title='MAJIN is inspecting the current page instead of blindly repeating the previous action';}
    }
    else if (ev.type === 'tool_diagnosis') {
      const label=String(ev.labelText||'Checking tool failure').slice(0,90);
      workPulse(label);
      const bar=$('work-progress');
      if(bar){
        bar.dataset.phase='diagnose';
        bar.dataset.diagnosis=String(ev.kind||'unknown').slice(0,40);
        bar.title='Current tool: '+String(ev.tool||'unknown').slice(0,64)+' · Next: '+String(ev.action||'inspect_failure').replace(/_/g,' ').slice(0,75);
      }
      if($('work-progress-symbol'))$('work-progress-symbol').textContent='↻';
    }
    else if (ev.type === 'agent_recovery') {
      const stage = ev.phase === 'blocked' ? 'Stopped a repeating action' : 'Switching strategy after a failed action';
      const tool = String(ev.tool || '').replace(/[^a-zA-Z0-9._-]/g,'').slice(0,48);
      workPulse(tool ? stage + ' · ' + tool : stage);
      const bar=$('work-progress');if(bar)bar.dataset.phase=ev.phase==='blocked'?'problem':'recovery';
    }
    else if (ev.type === 'verify' || ev.type === 'verification') workPulse('Verifying the real result');
    else if (ev.type === 'thinking') workPulse('Thinking through the next step');
    else if (ev.type === 'delta') workPulse('Writing the response');
    else if (ev.type === 'escalate') workPulse('Switching models');
    else if (ev.type === 'compact') workPulse('Organizing context');
  }
  if (ev.type === 'task') S.taskId = ev.task;
  if (S.stopRequested && ['error', 'answer'].includes(ev.type)) {
    if (!S.deferredStopEvent || (ev.type === 'error' && S.deferredStopEvent.type !== 'error')) S.deferredStopEvent = ev;
    return;
  }
  if (window.MAJIN_STUDIO) window.MAJIN_STUDIO.onEvent(ev);
  if (ev.type === 'error') { err(ev.message + (ev.hint ? '\n→ ' + ev.hint : '')); return; }
  if (S.failed && ['delta', 'thinking', 'answer'].includes(ev.type)) return;
  if (window.MAJIN_IMAGINE) window.MAJIN_IMAGINE.onEvent(ev); // Live Agent Vision — real events only
  switch (ev.type) {
    case 'marketing_channel_setup':
      // Platform-specific credentials stay in secure inline form, never the model.
      if (window.MAJIN_MARKETING) window.MAJIN_MARKETING.showChannel(ev.platform,ev.request);
      break;
    case 'marketing_setup':
      // Private, one-time credential question inline in the conversation.
      // NEVER paste Meta tokens into /api/chat or agent history.
      if (window.MAJIN_MARKETING) window.MAJIN_MARKETING.show(ev.request);
      break;
    case 'route':
      $('c-route').innerHTML = 'route <b>' + esc(ev.job) + '</b> → ' + esc((ev.model || '?').split('/').pop()) + (ev.confidence != null && ev.confidence < 0.45 ? ' <span style="color:var(--warn)">?</span>' : '');
      $('c-route').classList.add('live');
      setStatus('Thinking…');
      break;
    case 'step':
      setStatus('step ' + ev.step + '/' + ev.of + ' · ' + (ev.model || '').split('/').pop() + (ev.escalated ? '  · escalated' : ''));
      break;
    case 'delta':
      appendDelta(ev.text);
      break;
    case 'thinking':
      if (!window.MAJIN_STUDIO) setThinking(ev.text);
      break;
    case 'tool':
      S.activeTool = toolRow(ev.name);
      break;
    case 'tool_result': {
      const chip = S.activeTool;
      if (chip) finishTool(chip.chip, chip.trace, ev.ok, ev.summary || ev.error, ev.ms ? (ev.ms / 1000).toFixed(1) + 's' : '', ev.spilled);
      else {
        const r = toolRow(ev.tool);
        finishTool(r.chip, r.trace, ev.ok, ev.summary || ev.error, '', ev.spilled);
      }
      S.activeTool = null;
      break;
    }
    case 'escalate':
      if (window.MAJIN_STUDIO) setStatus('Switching model');
      else note('escalating → ' + ev.to + ' (' + (ev.why || 'errors') + ')');
      break;
    case 'compact':
      if (window.MAJIN_STUDIO) setStatus('Updating context');
      else note('compacting context (' + ev.tokens + ' tok)');
      break;
    case 'plan':
      renderPlan(ev.plan);
      break;
    case 'config':
      S.st = null;
      if (window.MAJIN_STUDIO) toast('Settings updated');
      else note('config: ' + (ev.notes || []).join(' · '));
      refresh();
      break;
    case 'config_error':
      err('config nekad: ' + (ev.errors || []).map((e) => e.path + ': ' + e.msg).join(', '));
      break;
    case 'skill_auto':
      note('new skill saved: ' + ev.name);
      break;
    case 'budget':
      toast('budget: ' + ev.used + ' / ' + ev.cap + ' USD');
      break;
    case 'loop.limit':
      note('step limit ' + ev.steps + ' reached');
      break;
    case 'moa:start':
    case 'moa:ref':
    case 'moa:done':
    case 'moa:degraded':
      moaGauge(ev);
      break;
    case 'usage':
      break;
    case 'answer':
      if (!S.failed) closeAnswer(ev);
      break;
    case 'error':
      err(ev.message + (ev.hint ? '\n→ ' + ev.hint : ''));
      break;
    default:
      break;
  }
}

function closeAnswer(ev) {
  const a = S.cur || (ev.text ? ensureAgent() : null);
  if (a) {
    a.b.classList.remove('caret');
    if (a.thinking) a.thinking.remove();
    if (!a.b.innerHTML.trim() && ev.text) a.b.innerHTML = md(ev.text);
    const meta = ev.meta || {};
    const foot = el('div', 'foot');
    const secs = ((Date.now() - S.t0) / 1000).toFixed(1);
    foot.textContent = [meta.job && 'job ' + meta.job, meta.steps && meta.steps + ' steps', meta.tools && meta.tools + ' tools', meta.usage && (meta.usage.input + '→' + meta.usage.output + ' tok'), meta.usage && meta.usage.costUsd ? '$' + meta.usage.costUsd.toFixed(4) : null, secs + 's'].filter(Boolean).join(' · ');
    a.m.append(foot);
    const audibleReply = String(ev.text || S.curBody || '').trim();
    if (S.voice && S.voiceTurn && !S.cancelled && audibleReply) void speak(audibleReply);
  }
  S.cur = null;
  S.tools = null;
}

/* --------------------------------- send --------------------------------- */
async function send(text, options = {}) {

  const input = String(text || '').trim();
  if (!input) return false;
  if (S.stopRequested) { toast('Waiting for stop confirmation.'); return false; }
  if (input[0] === '/') {
    // V1: command API failures must not become unhandled UI promise rejections.
    // Leave the typed command untouched so the user can retry it.
    try {
      const ok = await command(input);
      if (ok) return true;
    } catch (e) {
      err('Command failed: ' + (e?.message || String(e)));
      return false;
    }
  }
  /* AUTOPILOT: a task is already running on this chat — this new message is
     an independent task, it gets its own agent, card and stop button and
     must NEVER wait for the first one. The /stop command above still reaches
     the running task. */
  if (S.busy) return parallelTask(input);
  // Typing is not a voice command. Stop hands-free listening before sending,
  // otherwise microphone, keyboard and synthesized audio race each other.
  if (!options.voiceTurn) {
    if (S.handsFree) { S.handsFree = false; stopMic(); }
    // Typing takes priority over a previous spoken reply. Both browser TTS
    // and the optional local audio path must stop before a typed response.
    try { window.speechSynthesis?.cancel(); } catch {}
    try { voiceRequest?.abort(); } catch {}
    try { currentVoiceAudio?.pause(); } catch {}
    if (speechActive) voiceState('idle', 'Voice ready');
  }
  S.voiceTurn = Boolean(options.voiceTurn);
  if (window.MAJIN_IMAGINE) window.MAJIN_IMAGINE.reset(); // a new run gets a fresh canvas
  if (window.MAJIN_STUDIO) window.MAJIN_STUDIO.setState('connecting');
  S.taskId = null; S.deferredStopEvent = null;
  S.failed = false; S.lastInput = input; S.completed = false; S.readingHistory = false;
  addMsg('user', 'You', input);
  /* P0 repair: this chat moves to the top IMMEDIATELY (optimistic), reconciles
     with the server's durable index at completion/error without flicker. */
  if (window.MAJIN_CHATS) window.MAJIN_CHATS.bumpActive(S.session, input);
  $('input').value = '';
  autoGrow();
  S.busy = true;
  S.t0 = Date.now();
  workPulse('Connecting to MAJIN');
  syncSendButton();
  setStatus('working…');
  const ac = new AbortController();
  S.abort = ac;
  // No endless Thinking on a stalled stream. A slow model gets a clear retryable error.
  let streamTimedOut = false;
  let streamWatchdog = setTimeout(() => { streamTimedOut = true; ac.abort(); }, 90000);
  const resetStreamWatchdog = () => { clearTimeout(streamWatchdog); streamWatchdog = setTimeout(() => { streamTimedOut = true; ac.abort(); }, 90000); };
  try {
    const r = await fetch('/api/chat?t=' + encodeURIComponent(TOKEN), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ input, session: S.session }),
      signal: ac.signal,
    });
    if (!r.ok || !r.body) throw new Error('Request failed (HTTP ' + r.status + ')');
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      resetStreamWatchdog();
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const dataLine = raw.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        let ev;
        try {
          ev = JSON.parse(dataLine.slice(6));
        } catch {
          continue;
        }
        ev.type ||= raw.split('\n').find((l) => l.startsWith('event: '))?.slice(7).trim();
        if (ev.type === 'done') {
          S.completed = true;
          if (ev.ok === false && !S.failed) onEvent({ type: 'error', message: 'The provider could not complete this request.' });
          if (window.MAJIN_CHATS) window.MAJIN_CHATS.refresh(); /* server truth: durable index updated by the accepted send */
          continue;
        }
        onEvent(ev);
      }
    }
    if (!S.completed && !S.failed && !S.stopRequested) err('The response stream ended before completion.');
    /* u03 (real-world audit 2026-10-20): a completed stream with an EMPTY body
       must never silently remove the spinner — say the truth instead. */
    if (S.cur && !S.failed && !S.stopRequested) {
      if (!String(S.curBody || '').trim()) {
        err('The model finished without saying anything (empty reply). Test the provider in the Providers card, then try again.');
      } else closeAnswer({ text: S.curBody, meta: {} });
    }
  } catch (e) {
    if (streamTimedOut) err('The model stopped responding for 90 seconds. Try again or switch models.');
    else if (e.name !== 'AbortError') err('connection lost: ' + e.message);
    else {
      S.cancelled = true;
      if (S.cur) closeAnswer({ text: S.curBody, meta: {} });
      if (window.MAJIN_IMAGINE) window.MAJIN_IMAGINE.onEvent({ type: 'cancelled' });
    }
  } finally {
    clearTimeout(streamWatchdog);
    S.busy = false;
    S.abort = null;
    syncSendButton();
    if (S.handsFree && !speechActive && !S.listening) startMic();
    if (S.failed && !$('input').value) { $('input').value = input; autoGrow(); }
    setStatus(S.stopRequested ? 'Stopping task…' : S.failed ? 'Request failed · message preserved' : S.cancelled ? 'Stopped' : 'Ready');
    if (S.stopRequested && S.cur) { S.cur.b.classList.remove('caret'); if (S.cur.thinking) S.cur.thinking.remove(); }
    if (!S.stopRequested) S.cur = null;
    S.cancelled = false;
    refresh(true);
  }
  return true;
}

async function stop() {
  if (!S.busy || S.stopRequested) return;
  try { await stopObservedTask(S.taskId, S.session); }
  catch (e) { toast('Could not stop: ' + e.message); }
}

// One acknowledged backend action keeps Workspace and chat cancellation in sync.
async function stopObservedTask(id, session) {
  const main = S.busy && (id ? S.taskId === id : session === S.session);
  const rec = id ? PLIVE.find(t => t.id === id && !t.finished) : null;
  if (main) { S.stopRequested = true; S.deferredStopEvent = null; setStatus('Stopping task…'); }
  if (rec) { rec.stopRequested = true; rec.card.stopb.disabled = true; }
  try {
    const result = await api('/chat/stop', { method: 'POST', body: id ? { task: id } : { session } });
    if (result.ok !== true) throw new Error(result.error || 'Stop was not confirmed by the server');
  } catch (e) {
    if (main) {
      S.stopRequested = false;
      if (S.deferredStopEvent) {
        const busy = S.busy; S.busy = true; onEvent(S.deferredStopEvent); S.busy = busy;
        if (!busy) { setStatus(S.failed ? 'Request failed · message preserved' : 'Ready'); S.cur = null; }
      }
      else setStatus('Stop failed · task may still be running');
      S.deferredStopEvent = null;
    }
    if (rec) {
      rec.stopRequested = false; rec.card.stopb.disabled = false;
      if (rec.deferredStopError) taskEvent(rec, 'error', rec.deferredStopError);
      if (rec.deferredStopDone) finishTask(rec, rec.deferredStopDone);
    }
    throw e;
  }
  if (main) {
    S.stopRequested = false; S.failed = false; S.cancelled = true; S.deferredStopEvent = null;
    S.abort?.abort();
    if (!S.busy) {
      if (S.cur) closeAnswer({ text: S.curBody, meta: {} });
      S.cancelled = false; setStatus('Stopped');
      if (window.MAJIN_IMAGINE) window.MAJIN_IMAGINE.onEvent({ type: 'cancelled' });
    }
  }
  if (rec) {
    rec.stopRequested = false; rec.status = 'stopped'; rec.finished = true; rec.endAt = Date.now();
    telLeave(rec); paintTel(rec); paintTaskState(rec, 'stopped on request');
    rec.card.m.classList.add('task-bad'); rec.abort.abort();
  }
}

/* --------------------------- parallel autopilot ---------------------------
   One independent message while the main task runs = one more agent. Each
   parallel task owns its card, its SSE stream, its stop button; the classic
   single-task path above is byte-identical. Server side: {autopilot:true}
   names a fresh task (own session/history); the first SSE event is
   event: task with the id we must address for stopping it.
   Status vocabulary = the registry's: working · waiting · done · error ·
   stopped — nothing here is invented client-side. */

const P_STATUS = { working: '🔧 working', waiting: '⏳ waiting', paused: '⏸ paused', done: '✅ done', error: '❌ error', stopped: '🟥 stopped' };

/* one SSE stream drives one card: first message creates the task, follow-ups
   rejoin it (payload.task), resume IS a follow-up with a continue-brief. */
async function driveCard(rec, payload) {
  rec.abort = new AbortController();
  try {
    const r = await fetch('/api/chat?t=' + encodeURIComponent(TOKEN), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify(payload),
      signal: rec.abort.signal,
    });
    if (!r.ok || !r.body) throw new Error('server ' + r.status);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let name = '';
        let data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) name = line.slice(7);
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (!data) continue;
        let ev;
        try { ev = JSON.parse(data); } catch { continue; }
        if (name === 'done') { finishTask(rec, ev); continue; }
        taskEvent(rec, name, ev);
      }
    }
    if (!rec.finished && !rec.paused) finishTask(rec, { ok: true });
  } catch (e) {
    if (e.name === 'AbortError' || rec.finished || rec.paused) { /* stopped/paused on purpose */ }
    else { rec.status = 'error'; paintTaskState(rec, 'error; '+e.message); }
  }
}

function parallelTask(input) {
  addMsg('user', 'YOU · PARALLEL', input);
  $('input').value = '';
  autoGrow();
  const card = taskCard({ label: '🧵 launching…', status: 'waiting' });
  const rec = { card, input, id: null, text: '', last: '', painted: 0, finished: false, paused: false, toolCount: 0, toolMs: 0, abort: new AbortController() };
  card.rec = rec;
  telJoin(rec);
  driveCard(rec, { input, autopilot: true });
  return true;
}

/* follow-up into the SAME task session (the card's history, not a new task) */
function replyToTask(rec, text, { quiet = false } = {}) {
  if (!rec || !rec.id || !String(text || '').trim()) return;
  rec.paused = false;
  if (rec.finished) {
    rec.finished = false;
    rec.endAt = null;
    rec.card.stopb.disabled = false;
    rec.card.m.classList.remove('task-done', 'task-bad');
    telJoin(rec);
  }
  rec.status = 'working';
  paintTaskState(rec, quiet ? 'continuing from where it paused…' : 'reading your reply…');
  if (!quiet) {
    rec.text += '\n\n**you:** ' + text + '\n\n';
    paintTaskText(rec, true);
  }
  driveCard(rec, { input: String(text), task: rec.id });
}

async function pauseTask(rec) {
  if (!rec || !rec.id) return;
  rec.card.pauseb.disabled = true;
  try {
    const r = await api('/tasks/action', { method: 'POST', body: { task: rec.id, action: 'pause' } });
    if (r && r.ok) {
      rec.paused = true;
      rec.status = 'paused';
      paintTaskState(rec, 'paused — the whole context is kept');
      telLeave(rec);
      paintTel(rec);
      paintPauseBtn(rec);
    } else {
      paintTaskState(rec, 'could not pause: ' + ((r && r.error) || 'server said no'));
    }
  } catch (e) {
    paintTaskState(rec, 'could not pause: ' + e.message);
  }
  rec.card.pauseb.disabled = false;
}

function resumeTask(rec) {
  paintPauseBtn(rec);
  /* resume = the continue follow-up: it streams onto this very card */
  replyToTask(rec, 'Continue from the step you were on when you paused. Do not restart from zero — the earlier context in this session is the shared state of work.', { quiet: true });
}

function paintPauseBtn(rec) {
  rec.card.pauseb.textContent = rec.status === 'paused' ? '▶ resume' : '⏸ pause';
  rec.card.pauseb.onclick = () => (rec.status === 'paused' ? resumeTask(rec) : pauseTask(rec));
  rec.card.pauseb.style.display = rec.finished ? 'none' : '';
}

function taskCard({ label, status }) {
  const m = el('div', 'msg task');
  const head = el('div', 'task-head');
  const idl = el('span', 'task-id', esc(label));
  const st = el('span', 'task-status st-waiting', esc(P_STATUS[status] || status));
  const pauseb = el('button', 'task-pause', '⏸ pause');
  const stopb = el('button', 'task-stop', '⏹ stop');
  const act = el('div', 'task-act kv', '…');
  const tel = el('div', 'task-tel', '');
  const ans = el('div', 'body task-ans', '');
  const foot = el('div', 'task-foot');
  const rinput = el('input', 'task-reply');
  rinput.placeholder = 'reply to this agent…';
  const rbtn = el('button', 'task-send', '↩ send');
  foot.append(rinput, rbtn);
  head.append(idl, st, pauseb, stopb);
  m.append(head, act, tel, ans, foot);
  $('scroller').append(m);
  scroll();
  const card = { m, idl, st, pauseb, stopb, act, tel, ans, foot, rinput, rbtn };
  stopb.onclick = () => stopTask(card.rec);
  const sendReply = () => {
    const text = rinput.value.trim();
    if (!text || !card.rec) return;
    rinput.value = '';
    replyToTask(card.rec, text);
  };
  rbtn.onclick = sendReply;
  rinput.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); } };
  pauseb.onclick = () => pauseTask(card.rec);
  return card;
}

function paintTaskState(rec, note) {
  if (!rec.card) return;
  const cls = 'task-status st-' + (rec.status in P_STATUS ? rec.status : 'waiting');
  rec.card.st.className = cls;
  rec.card.st.textContent = P_STATUS[rec.status] || rec.status;
  if (note) rec.card.act.textContent = note;
}

function paintTaskText(rec, force) {
  const now = Date.now();
  if (!force && now - rec.painted < 150) return; // ~6 paints/s, not per token
  rec.painted = now;
  rec.card.ans.innerHTML = md(rec.text);
  scroll();
}

/* ---- real telemetry on the card: elapsed from the card's own clock, tool
   counts/averages from the card's own tool_result events. Nothing is a
   prediction model; a number that cannot be counted is simply not shown. ---- */
const PLIVE = [];
let telTimer = null;

function fmtDur(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60), rest = sec % 60;
  if (m < 60) return m + 'm' + String(rest).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
}

function paintTel(rec) {
  if (!rec.card || !rec.card.tel) return;
  const bits = [];
  if (rec.startAt) {
    const end = rec.finished ? (rec.endAt || Date.now()) : Date.now();
    bits.push('⏱ ' + fmtDur(end - rec.startAt));
  }
  if (rec.toolCount) {
    bits.push(rec.toolCount + ' tool' + (rec.toolCount === 1 ? '' : 's'));
    if (rec.toolMs && rec.toolCount >= 2) bits.push('avg ' + fmtDur(rec.toolMs / rec.toolCount) + '/tool');
  }
  rec.card.tel.textContent = bits.join(' · ');
}

function telJoin(rec) { PLIVE.push(rec); if (!telTimer) telTimer = setInterval(telTickAll, 1000); }
function telLeave(rec) {
  const i = PLIVE.indexOf(rec);
  if (i >= 0) PLIVE.splice(i, 1);
  if (!PLIVE.length && telTimer) { clearInterval(telTimer); telTimer = null; }
}
function telTickAll() { for (const rec of PLIVE) paintTel(rec); }

function taskEvent(rec, name, ev) {
  if (rec.stopRequested && name === 'error') { rec.deferredStopError = ev; return; }
  if (name === 'task') {
    rec.id = ev.task;
    rec.session = ev.session;
    rec.startAt = Date.now();
    rec.card.idl.textContent = '🧵 ' + rec.id;
    rec.card.rec = rec;
    rec.status = 'working';
    paintTaskState(rec, 'agent started (own session: ' + rec.session + ')');
    paintTel(rec);
    return;
  }
  switch (ev.type) {
    case 'route':
      rec.status = 'working';
      paintTaskState(rec, 'job ' + (ev.job || '?') + ' · model ' + String(ev.model || '?').split('/').pop());
      break;
    case 'step':
      paintTaskState(rec, 'step ' + ev.step + '/' + ev.of + (rec.last ? ' · ' + rec.last : ''));
      break;
    case 'tool':
    case 'tool_begin':
    case 'tool:start':
      rec.last = 'tool ' + (ev.name || ev.tool || '?');
      paintTaskState(rec, rec.last);
      break;
    case 'tool_result':
      rec.last = (ev.ok ? '✓ ' : '✗ ') + (ev.summary || ev.tool || '');
      rec.toolCount = (rec.toolCount || 0) + 1;
      if (Number.isFinite(ev.ms)) rec.toolMs = (rec.toolMs || 0) + ev.ms;
      paintTaskState(rec, rec.last);
      paintTel(rec);
      break;
    case 'approval':
      rec.status = 'waiting'; paintTaskState(rec, 'waiting for your approval — see the approval card');
      break;
    case 'delta':
      rec.text += ev.text || '';
      paintTaskText(rec);
      break;
    case 'answer':
      if (ev.text) rec.text = ev.text;
      paintTaskText(rec, true);
      break;
    case 'error':
      rec.status = 'error';
      rec.text += '\n\n**' + (ev.message || 'error') + '**' + (ev.hint ? ' — ' + ev.hint : '');
      paintTaskText(rec, true);
      break;
    default:
      break;
  }
}

function finishTask(rec, doneEv) {
  if (rec.stopRequested) { rec.deferredStopDone = doneEv; return; }
  if (rec.finished) return;
  rec.finished = true;
  rec.endAt = Date.now();
  telLeave(rec);
  rec.status = doneEv.ok === false || rec.status === 'error' ? 'error' : 'done';
  paintTaskState(rec, (doneEv.steps ? doneEv.steps + ' steps · ' : '') + (doneEv.usage && doneEv.usage.costUsd ? '$' + doneEv.usage.costUsd.toFixed(4) + ' · ' : '') + (rec.status === 'error' ? 'failed' : 'done'));
  paintTel(rec);
  paintTaskText(rec, true);
  rec.card.stopb.disabled = true;
  paintPauseBtn(rec);
  rec.card.m.classList.add(rec.status === 'done' ? 'task-done' : 'task-bad');
  refresh && refresh(true);
}

async function stopTask(rec) {
  if (!rec || !rec.id || rec.stopRequested) return;
  try { await stopObservedTask(rec.id); }
  catch (e) { toast('Could not stop: ' + e.message); }
}

/* ------------------------------ live deck --------------------------------
   A slim strip over the chat: every RUNNING/WAITING/Paused task from the
   backend registry — including ones started from channels where no card
   exists. Real data only; it hides when the machine is quiet. */
const deck = { el: null, timer: null };

function deckEnsure() {
  if (deck.el) return deck.el;
  deck.el = el('section', 'deck', '');
  deck.el.hidden = true;
  const main = $('main');
  if (main) main.insertBefore(deck.el, main.firstChild);
  return deck.el;
}

function deckRow(t) {
  const dot = t.status === 'running' ? '🟢' : t.status === 'paused' ? '⏸' : '🟡';
  const age = fmtDur((t.status === 'running' || t.status === 'waiting' ? Date.now() : t.updated) - t.created);
  const tools = t.toolsRun ? ' · ' + t.toolsRun + ' tools' : '';
  return '<div class="deck-row"><span class="deck-dot">' + dot + '</span> <b>' + esc(t.id) + '</b> ' + esc((t.input || '').slice(0, 70)) +
    ' <span class="kv">' + esc(t.status) + ' · ⏱ ' + age + tools + '</span></div>';
}

async function deckTick() {
  const elx = deckEnsure();
  let d = null;
  try {
    d = await (await fetch('/api/tasks?t=' + encodeURIComponent(TOKEN), { headers: { authorization: 'Bearer ' + TOKEN } })).json();
  } catch { d = null; }
  if (window.MAJIN_STUDIO) {
    if (d && Array.isArray(d.tasks)) window.MAJIN_STUDIO.updateTasks(d.tasks);
    else window.MAJIN_STUDIO.tasksUnavailable();
  }
  const active = d && Array.isArray(d.tasks) ? d.tasks.filter((t) => ['running', 'waiting', 'paused'].includes(t.status)) : [];
  if (!active.length) { elx.hidden = true; return; }
  elx.hidden = false;
  elx.innerHTML = '<div class="deck-title">agents at work: ' + active.length + '</div>' + active.map(deckRow).join('');
  scroll();
}

function deckStart() {
  deckEnsure();
  deckTick();
  if (!deck.timer) deck.timer = setInterval(deckTick, 5000);
}
document.addEventListener('DOMContentLoaded', deckStart);

/* ------------------------------- approvals ------------------------------ */
function approvalCard(ev) {
  const box = el('div', 'appr');
  box.append(el('h4', '', '◎ ' + esc(ev.tool) + ' wants to run'));
  box.append(el('div', 'kv', esc(ev.reason || '')));
  if (ev.detail) box.append(el('pre', '', esc(String(ev.detail).slice(0, 600))));
  const row = el('div', 'row');
  const yes = el('button', 'on', 'ALLOW');
  const no = el('button', 'danger', 'DENY');
  yes.onclick = () => respond(ev.id, true, box);
  no.onclick = () => respond(ev.id, false, box);
  row.append(yes, no, el('span', 'kv', 'id ' + ev.id + (ev.session ? ' · ' + ev.session : '')));
  box.append(row);
  $('scroller').append(box);
  scroll();
  toast('approval pending: ' + ev.tool);
  return box;
}
async function respond(id, approved, box) {
  try {
    const result = await api('/approve', { method: 'POST', body: { id, approved } });
    if (result.ok !== true) throw new Error('This approval is no longer pending.');
    if (box) box.querySelectorAll('button').forEach((b) => {
      b.disabled = true;
    });
    if (box) box.style.borderColor = approved ? 'var(--ok)' : 'var(--bad)';
  } catch (e) {
    toast('could not answer: ' + e.message);
  }
}

/* ------------------------------ global SSE ------------------------------ */
function listen() {
  const es = new EventSource('/api/events?t=' + encodeURIComponent(TOKEN));
  S.es = es;
  es.onmessage = () => {};
  const handle = (name) => (msg) => {
    let ev;
    try {
      ev = JSON.parse(msg.data);
      if (window.MAJIN_IMAGINE) window.MAJIN_IMAGINE.onEvent({ type: name, ...ev });
    } catch {
      return;
    }
    if (name === 'approval:request') {
      approvalCard(ev);
      return;
    }
    if (name === 'approval:resolved') {
      setStatus('approval ' + (ev.approved ? 'granted' : 'denied'));
      return;
    }
    if (name === 'log' || !name) return;
    if (S.busy) return;
    if (name === 'answer') {
      addMsg('majin', 'MAJIN · ' + (ev.source || 'schemalagt'), ev.text);
      return;
    }
    if (name.startsWith('telegram.') || name.startsWith('whatsapp.')) {
      toast(name.replace('.', ' · ') + (ev.error ? ': ' + ev.error : ''));
    }
    if (name === 'schedule.done') toast('schedule: ' + (ev.status || 'ok'));
  };
  ['approval:request', 'approval:resolved', 'answer', 'telegram.up', 'telegram.paired', 'telegram.unpaired', 'whatsapp.qr', 'whatsapp.connected', 'whatsapp.close', 'schedule.done', 'schedule.failed', 'tool.denied', 'majin.ui'].forEach((n) => es.addEventListener(n, handle(n)));
  es.onopen = () => { if (!S.busy) setStatus('Connected'); refresh(true); };
  es.onerror = () => {
    setStatus('reconnecting…');
  };
}

/* ------------------------- hands-free voice -------------------------- */
let recog=null, speechActive=false, voiceArmed=false;
let lastSpokenReply='';
function isVoicePlaybackEcho(heard){
 const words=text=>String(text||'').toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[];
 const utterance=words(heard),reply=new Set(words(lastSpokenReply));
 return utterance.length>0 && utterance.filter(word=>reply.has(word)).length/utterance.length>=0.8;
}
let voiceSilenceTimer=null, voiceSessionTimer=null, voiceTranscript='', voiceFinal='', voiceFinished=false;
let voiceMeterStream=null, voiceMeterContext=null, voiceMeterFrame=null;
let voiceGate=null, voiceGateReady=false;
function clearVoiceTimers(){
  clearTimeout(voiceSilenceTimer);clearTimeout(voiceSessionTimer);
  voiceSilenceTimer=voiceSessionTimer=null;
}
async function startVoiceMeter(){
  if(!navigator.mediaDevices?.getUserMedia || voiceMeterStream)return;
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:{
      echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1
    }});
    if(!S.handsFree){stream.getTracks().forEach(t=>t.stop());return;}
    voiceMeterStream=stream;
    voiceGate=window.MAJINForegroundVoiceGate ? new window.MAJINForegroundVoiceGate() : null;
    voiceGateReady=Boolean(voiceGate);
    const ctx=new (window.AudioContext||window.webkitAudioContext)();
    voiceMeterContext=ctx;
    const analyser=ctx.createAnalyser();analyser.fftSize=512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const data=new Uint8Array(analyser.fftSize);
    function draw(){
      if(!voiceMeterStream)return;
      analyser.getByteTimeDomainData(data);
      let sum=0;
      for(const n of data){const d=(n-128)/128;sum+=d*d;}
      const rms=Math.sqrt(sum/data.length);
      if(voiceGate)voiceGate.observe(rms);
      const volume=Math.min(1,rms*9);
      document.documentElement.style.setProperty('--voice-energy',volume.toFixed(3));
      voiceMeterFrame=requestAnimationFrame(draw);
    }
    draw();
  }catch(e){
    // Recognition may still work even when audio metering is denied.
    voiceState('listening','Microphone level unavailable');
  }
}
function stopVoiceMeter(){
  if(voiceMeterFrame)cancelAnimationFrame(voiceMeterFrame);
  voiceMeterFrame=null;
  voiceMeterStream?.getTracks().forEach(t=>t.stop());voiceMeterStream=null;
  voiceMeterContext?.close().catch(()=>{});voiceMeterContext=null;
  voiceGate=null;voiceGateReady=false;
  document.documentElement.style.setProperty('--voice-energy','0');
}
function voiceState(mode,label){
  document.body.dataset.voiceMode=mode;
  if($('mic-state'))$('mic-state').textContent=label;
  $('mic')?.setAttribute('aria-pressed',String(Boolean(S.handsFree)));
  const stage=$('voice-stage');if(stage)stage.hidden=!S.handsFree;
  const names={idle:'Ready',listening:'Listening',thinking:'Thinking',speaking:'Speaking',paused:'Paused',error:'Microphone error'};
  if($('voice-stage-label'))$('voice-stage-label').textContent=names[mode]||'MAJIN';
  if($('voice-caption'))$('voice-caption').textContent=label||'';
}
function stopMic(){
  clearVoiceTimers();voiceArmed=false;S.listening=false;
  const r=recog;recog=null;
  try{r?.abort();}catch{}
  stopVoiceMeter();
  $('mic')?.classList.remove('on');
  voiceState('idle','Voice ready');
}
function dispatchVoiceTurn(r){
  if(voiceFinished||recog!==r||!S.handsFree)return;
  let command=(voiceFinal||voiceTranscript).trim();
  const wake=String(S.st?.config?.ui?.voice?.wakeWord||'').trim();
  // Manual tap-to-talk already authorizes the turn. Legacy wakeWord values
  // must not silently discard speech; requireWakeWord is explicit opt-in.
  if(wake && S.st?.config?.ui?.voice?.requireWakeWord === true){
    if(!command.toLowerCase().startsWith(wake.toLowerCase())){
      // A mismatched wake phrase must not strand the recognizer indefinitely.
      voiceFinished=true;S.handsFree=false;stopMic();
      voiceState('paused','Ignored — wake phrase not detected');
      return;
    }
    command=command.slice(wake.length).trim();
  }
  if(!command)return;
  // Noisy TV chatter can produce a valid browser transcript. Only permit the
  // turn if near-mic activity was observed. This is NOT biometric speaker ID.
  const gated = S.st?.config?.ui?.voice?.foregroundGate === true;
  if(gated && voiceGateReady && voiceGate &&
     (!voiceGate.lastSpeech || Date.now()-voiceGate.lastSpeech>4500)){
    S.handsFree=false;
    stopMic();
    voiceState('paused','Background sound ignored — tap to speak closer to your microphone');
    return;
  }
  voiceFinished=true;voiceArmed=false;S.listening=false;
  clearVoiceTimers();recog=null;stopVoiceMeter();
  try{r.abort();}catch{}
  // Spoken text belongs in the chat transcript, but must not insert itself
  // into the typed composer or start a second voice turn.
  const intent=window.MAJIN_VOICE_INTENT?.classify(command,S.busy)||{kind:'send',text:command};
  if(intent.kind==='cancel'||intent.kind==='replace'){
    voiceState('thinking',intent.kind==='cancel'?'Stopping current task…':'Switching task…');
    void (async()=>{
      if(S.busy){try{await stopObservedTask(S.taskId,S.session);}
        catch(e){voiceState('error','Could not confirm stop: '+e.message);return;}}
      if(intent.kind==='replace'){await send(intent.text,{voiceTurn:true});}
      else {S.handsFree=false;voiceState('paused','Stopped. Tap to speak again.');}
    })();
    return;
  }
  if(S.busy){voiceState('paused','Task running — say “stop” or “no, do something else”');S.handsFree=false;return;}
  voiceState('thinking','Got it — working on your answer');
  void send(command,{voiceTurn:true});
}
function startMic(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){S.handsFree=false;S.listening=false;voiceState('error','Speech recognition unavailable — use Chrome or Edge and allow microphone access');return;}
  if(!S.handsFree||recog)return;
  const r=new SR();recog=r;voiceArmed=true;voiceFinished=false;
  voiceTranscript='';voiceFinal='';S.listening=true;
  r.lang=S.st?.config?.ui?.voice?.lang||'sv-SE';
  r.continuous=false;r.interimResults=true;
  r.onstart=()=>{
    voiceState('listening','Listening — speak near your microphone');
    clearVoiceTimers();
    // Never listen indefinitely when TV or other background speech continues.
    voiceSessionTimer=setTimeout(()=>{
      if(recog!==r)return;
      if(voiceFinal.trim())dispatchVoiceTurn(r);
      else {recog=null;S.listening=false;clearVoiceTimers();stopVoiceMeter();if(S.handsFree)startMic();}
    },12000);
  };
  r.onresult=e=>{
    if(recog!==r||voiceFinished)return;
    let words='',complete='';
    for(let i=0;i<e.results.length;i++){
      const chunk=e.results[i][0]?.transcript||'';
      words+=chunk;
      if(e.results[i].isFinal)complete+=chunk;
    }
    if(!words.trim())return;
    if(speechActive && isVoicePlaybackEcho(words))return;
    voiceTranscript=words.trim();voiceFinal=complete.trim();
    if(speechActive){
      speechActive=false;
      try{window.speechSynthesis?.cancel();}catch{}
      try{voiceRequest?.abort();currentVoiceAudio?.pause();}catch{}
    }
    voiceState('listening',voiceTranscript);
    clearTimeout(voiceSilenceTimer);
    // Web Speech sometimes never sets isFinal in a noisy room. Commit the
    // latest stable transcript after an endpoint pause instead of hanging.
    voiceSilenceTimer=setTimeout(()=>dispatchVoiceTurn(r),voiceFinal?400:1100);
  };
  r.onerror=e=>{
    if(recog!==r)return;
    if(e.error==='not-allowed'||e.error==='service-not-allowed'){
      S.handsFree=false;stopMic();voiceState('error','Allow microphone access');
    }else if(e.error!=='no-speech'&&e.error!=='aborted'){
      S.handsFree=false;stopMic();voiceState('error','Voice: '+e.error);
    }
  };
  r.onend=()=>{
    if(recog!==r)return;
    if(voiceTranscript.trim()){dispatchVoiceTurn(r);return;}
    recog=null;S.listening=false;clearVoiceTimers();
    // No speech: stop gracefully. A TV should not create an infinite restart loop.
    stopVoiceMeter();if(S.handsFree)startMic();else voiceState('paused','Tap to talk again');
  };
  void startVoiceMeter();
  try{r.start();$('mic')?.classList.add('on');}
  catch(e){S.handsFree=false;stopMic();voiceState('error',e.message);}
}
function micToggle(){
  if(S.handsFree && !speechActive){
    S.handsFree=false;S.voiceTurn=false;stopMic();
    window.speechSynthesis?.cancel();
    try{voiceRequest?.abort();currentVoiceAudio?.pause();}catch{}
    voiceState('idle','Voice ready');
  } else {
    // Barge-in: tapping Talk while MAJIN is speaking interrupts playback.
    window.speechSynthesis?.cancel();
    try{voiceRequest?.abort();currentVoiceAudio?.pause();}catch{}
    speechActive=false;
    S.handsFree=true;S.voice=true;S.voiceTurn=false;
    $('b-voice')?.classList.add('on');
    voiceState('listening','Speak now'); startMic();
  }
}
let currentVoiceAudio=null, voiceRequest=null;
async function neuralNarrator(text){
  const controller=new AbortController();
  voiceRequest=controller;
  const timeout=setTimeout(()=>controller.abort(),25000);
  try {
    const res=await fetch('http://127.0.0.1:18765/speak',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({text}),signal:controller.signal
    });
    if(!res.ok)throw new Error('Local Kokoro voice unavailable');
    const wav=await res.blob();
    if(wav.type && !wav.type.includes('wav'))throw new Error('Local narrator did not return WAV');
    const url=URL.createObjectURL(wav);
    const audio=new Audio(url);currentVoiceAudio=audio;
    try {
      await new Promise((resolve,reject)=>{
        audio.onended=resolve;audio.onerror=()=>reject(new Error('WAV playback failed'));
        audio.play().catch(reject);
      });
      return true;
    } finally {URL.revokeObjectURL(url);}
  } finally {
    clearTimeout(timeout);voiceRequest=null;
    if(currentVoiceAudio){currentVoiceAudio.pause();currentVoiceAudio=null;}
  }
}
function browserNarrator(clean){
  return new Promise((resolve,reject)=>{
    if(!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)){
      reject(new Error('No text-to-speech engine is available in this browser'));return;
    }
    const engine=window.speechSynthesis;
    let finished=false;
    // Some Chromium/Windows installations never fire onend when output is
    // unavailable. Bound the turn so the microphone can resume.
    const timeout=setTimeout(()=>finish(new Error('Speech playback timed out; check Windows audio output')),Math.min(60000,8000+clean.length*110));
    function finish(error){
      if(finished)return;
      finished=true;clearTimeout(timeout);
      if(error){try{engine.cancel();}catch{}reject(error);}
      else resolve(true);
    }
    const u=new SpeechSynthesisUtterance(clean);
    const lang=S.st?.config?.ui?.voice?.lang||'sv-SE';
    u.lang=lang;u.rate=S.st?.config?.ui?.voice?.rate||1.04;
    const voices=engine.getVoices().filter(x=>x.lang?.slice(0,2).toLowerCase()===lang.slice(0,2).toLowerCase());
    u.voice=voices.find(x=>/natural|neural/i.test(x.name))||voices[0]||null;
    u.onend=()=>finish();
    u.onerror=e=>finish(new Error('Speech playback failed: '+(e.error||'unknown')));
    try{engine.cancel();engine.resume();engine.speak(u);}
    catch(e){finish(e);}
  });
}
async function speak(t){
  if(!S.voice)return;
  const clean=String(t).replace(/\`[^\`]+\`/g,' ').replace(/https?:\/\/\S+/g,' link ').replace(/[*_#]/g,'').slice(0,1200).trim();
  if(!clean)return;
  // Keep the conversation armed; recognizer remains available for user barge-in.
  lastSpokenReply=clean;
  speechActive=true;voiceState('speaking','MAJIN speaking…');
  try {
    // A locally configured Kokoro narrator is optional; never silently
    // claim audible playback if both Kokoro and browser TTS fail.
    if(S.narratorEnglish === true){
      try{await neuralNarrator(clean);return;}
      catch(e){voiceState('speaking','Local narrator unavailable; trying system voice');}
    }
    await browserNarrator(clean);
  } catch(e) {
    voiceState('error','Could not play speech: '+e.message);
    toast('Voice output failed: '+e.message+'. Check volume and selected Windows audio device.');
  } finally {
    speechActive=false;
    if(S.handsFree&&!S.busy)startMic();
    else if(document.body.dataset.voiceMode==='speaking')voiceState('idle','Voice ready');
  }
}

/* ------------------------------- composer ------------------------------- */
function syncSendButton() {
  const button = $('send');
  button.classList.toggle('busy', S.busy);
  button.disabled = !S.busy && !$('input').value.trim();
  button.setAttribute('aria-label', S.busy ? 'Stop response' : 'Send message');
  button.title = S.busy ? 'Stop response' : 'Send message';
}
function autoGrow() {
  const i = $('input');
  i.style.height = 'auto';
  i.style.height = Math.min(240, i.scrollHeight + 2) + 'px';
  syncSendButton();
}
const CMDS = ['/status', '/tools', '/route', '/moa', '/guard', '/model', '/provider', '/pair', '/schedule', '/memory', '/analyze', '/selftest', '/stop', '/clear', '/session', '/budget', '/help'];
async function command(line) {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(' ');
  const c = cmd.toLowerCase();
  if (c === 'help') {
    note('commands: ' + CMDS.join('  '));
    return true;
  }
  if (c === 'stop') {
    await stop();
    return true;
  }
  if (c === 'clear') {
    await api('/session/clear', { method: 'POST', body: { session: S.session } });
    $('scroller').innerHTML = '';
    note('session cleared');
    return true;
  }
  if (c === 'session') {
    if (!arg) return (note('session: ' + S.session), true);
    S.session = arg.replace(/[^\w.:-]/g, '_').slice(0, 40);
    await loadHistory();
    return true;
  }
  if (c === 'status') {
    refresh();
    return true;
  }
  if (c === 'tools') {
    const t = await api('/tools');
    note(Object.entries(t.groups).map(([g, list]) => g + ': ' + list.join(', ')).join('\n'));
    return true;
  }
  if (c === 'selftest') {
    const r = await api('/selftest', { method: 'POST', body: { level: arg.includes('full') ? 'full' : 'quick' } });
    addMsg('sys', 'selftest', r.text || r.error || 'done');
    return true;
  }
  if (c === 'analyze') {
    await analyzePath(arg);
    return true;
  }
  if (c === 'route') {
    const [job, ref] = rest;
    if (!job || !ref) return (note('usage: /route <job> <provider/model>'), true);
    await api('/config', { method: 'PATCH', body: { models: { routes: { [job]: ref } } } });
    refresh();
    return true;
  }
  if (c === 'model') {
    if (!arg) return (note('usage: /model <provider/model>'), true);
    await api('/config', { method: 'PATCH', body: { models: { routes: { chat: arg, tasks: arg, tools: arg, code: arg, re: arg, analysis: arg, final: arg, plan: arg, research: arg, summarize: arg, router: arg, aggregator: arg } } } });
    note('all routes → ' + arg);
    refresh();
    return true;
  }
  if (c === 'moa') {
    const patch = { moa: {} };
    if (/^(on|always)$/.test(arg)) patch.moa.policy = 'always';
    else if (arg === 'hard') patch.moa.policy = 'hard';
    else if (arg === 'off') patch.moa.policy = 'off';
    const w = /(\d)/.exec(arg);
    if (w) patch.moa.width = Math.max(2, Math.min(5, Number(w[1])));
    if (!patch.moa.policy && !patch.moa.width) return (note('/moa on | hard | off [width]'), true);
    await api('/config', { method: 'PATCH', body: patch });
    refresh();
    return true;
  }
  if (c === 'guard') {
    if (!['confirm', 'strict', 'off'].includes(arg)) return (note('/guard confirm | strict | off'), true);
    await api('/config', { method: 'PATCH', body: { guard: { mode: arg } } });
    refresh();
    return true;
  }
  if (c === 'budget') {
    const n = Number(arg.replace(/[^\d.]/g, ''));
    if (!n) return (note('/budget <usd per month>'), true);
    await api('/config', { method: 'PATCH', body: { budget: { monthlyUsd: n, mode: 'cap' } } });
    note('budget ' + n + ' USD/month');
    refresh();
    return true;
  }
  if (c === 'memory') {
    if (/^spara\s+/i.test(arg)) await api('/memory', { method: 'POST', body: { text: arg.replace(/^spara\s+/i, '') } });
    else if (/^(forget|glöm)\s+/i.test(arg)) await api('/memory', { method: 'POST', body: { action: 'forget', query: arg.replace(/^(forget|glöm)\s+/i, '') } });
    else {
      const m = await api('/memory?q=' + encodeURIComponent(arg || ''));
      note((m.facts || []).slice(0, 12).map((f) => '· ' + (f.text || f)).join('\n') || 'memory is empty');
    }
    refresh();
    return true;
  }
  if (c === 'schedule') {
    const m = /^(.+?)\s+[—-]\s+(.+)$/.exec(arg);
    if (!m) return (note('/schedule <when> — <task>   ex: /schedule 07:30 daily — kolla inkorg'), true);
    await api('/schedule', { method: 'POST', body: { when: m[1], task: m[2], deliver: 'telegram' } });
    refresh();
    return true;
  }
  if (c === 'pair') {
    const st = await api('/channels');
    note(arg === 'whatsapp' ? 'WhatsApp: ' + (st.whatsapp.state || '') + (st.whatsapp.qr ? ' — show the QR in the panel' : '') : 'Telegram: pairing code ' + (st.telegram.pairingCode || '?') + ' — send /pair <code> to the bot');
    return true;
  }
  if (c === 'provider') {
    if (!arg) {
      const s = await api('/state?tools=0');
      note(s.providers.map((p) => p.name + ' ' + (p.ready ? '🟢' : '⚪') + ' ' + (p.models || []).join(',')).join('\n'));
      return true;
    }
    return false;
  }
  return false;
}

async function analyzePath(p) {
  if (!p) return note('give me a path: /analyze <file>');
  setStatus('RE analysis…');
  try {
    const r = await api('/re/analyze', { method: 'POST', body: { path: p } });
    const m = addMsg('sys', 'RE · ' + p.split(/[\\/]/).pop());
    m.b.innerHTML = md(String(r.result || '').slice(0, 4000));
    if (r.meta) S.reMeta = r.meta;
    const row = el('div', 'row');
    const ask = el('button', '', '→ MAJIN');
    ask.onclick = () => send('Analyze ' + p + ' more deeply. Say whether it is dangerous, what it does, and what I should check next.');
    row.append(ask);
    m.m.append(row);
    $('re-out').innerHTML = '<b>' + esc(p.split(/[\\/]/).pop()) + '</b> · risk ' + esc(r.meta?.risk ?? '?') + (r.meta?.report ? ` <a href="/api/report?file=${encodeURIComponent(r.meta.report.split(/[\\/]/).pop())}&t=${TOKEN}" style="color:var(--cy)">json</a>` : '');
  } catch (e) {
    err('RE: ' + e.message);
  } finally {
    setStatus('ready');
  }
}

/* --------------------------------- boot --------------------------------- */
async function refresh(quiet) {
  try {
    const st = await api('/state?tools=0');
    if (S.st?.version && st.version && S.st.version !== st.version && !S.busy) {
      try { sessionStorage.setItem('majin.update.resume', JSON.stringify({ session: S.session, draft: $('input').value })); } catch { /* storage unavailable */ }
      location.reload();
      return;
    }
    S.st = st;
    paintHeader(st);
    if (window.MAJIN_ONBOARD) window.MAJIN_ONBOARD.maybe(S.st); // first-run wizard + model chip
    if (window.paintPanel) window.paintPanel(st);
    paintRail(st);
    if (window.MAJIN_STUDIO) window.MAJIN_STUDIO.setUsage(st.usage || {});
    if (!quiet) {
      /* tyst */
    }
  } catch (e) {
    if (!quiet) err('state: ' + e.message);
  }
}
async function loadHistory() {
  S.readingHistory = false; S.failed = false; S.cur = null; S.curBody = '';
  setStatus('Ready');
  if (window.MAJIN_IMAGINE) window.MAJIN_IMAGINE.reset();
  const h = await api('/history?session=' + encodeURIComponent(S.session) + '&n=40').catch(() => ({ messages: [] }));
  $('scroller').innerHTML = '';
  (h.messages || []).forEach((m) => addMsg(m.role === 'user' ? 'user' : 'majin', m.role === 'user' ? 'DU' : 'MAJIN', m.content));
  if (!(h.messages || []).length) showWelcome();
}
function showWelcome() {
  const panel = $('scroller');
  const welcome = document.createElement('section');
  welcome.id = 'home';
  welcome.className = 'home';
  const emblem = el('div', 'home-emblem', '<span class="living-orb" aria-hidden="true"><i></i><i></i><i></i></span>');
  const title = document.createElement('h2');
  title.textContent = 'What’s next?';
  welcome.append(emblem, title);
  panel.append(welcome);
}

function closeMobileRail() {
  if (matchMedia('(max-width:1000px)').matches) {
    document.body.classList.remove('mobile-rail');
    document.body.classList.add('rail-off');
    $('b-rail').setAttribute('aria-expanded', 'false');
  }
}
async function newChat() {
  if (S.busy || S.stopRequested) { toast('Stop the current task before starting a new chat.'); return; }
  closeMobileRail();
  S.session = 'chat-' + Date.now().toString(36);
  $('input').value = ''; autoGrow();
  if (window.MAJIN_CHATS) window.MAJIN_CHATS.bumpActive(S.session, null); /* pending empty chat visible while active, durable only once materialized by a real send */
  await loadHistory(); $('input').focus();
}
$('new-chat').onclick = newChat;
/* Ctrl+N lives in studio.js (bubbles through to this handler). */
$('browse-models').onclick = () => { closeMobileRail(); window.MAJIN_ONBOARD.togglePicker(); };
$('manage-providers').onclick = () => { closeMobileRail(); window.MAJIN_ONBOARD.reopen(); };
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send($('input').value);
  }
  if (e.key === 'Escape') stop();
});
$('send').onclick = () => (S.busy ? stop() : send($('input').value));
$('input').addEventListener('input', autoGrow);
$('b-rail').onclick = () => {
  if (matchMedia('(max-width:1000px)').matches) {
    const open = document.body.classList.toggle('mobile-rail');
    document.body.classList.toggle('rail-off', !open);
    $('b-rail').setAttribute('aria-expanded', String(open));
  } else { const off = document.body.classList.toggle('rail-off'); $('b-rail').setAttribute('aria-expanded', String(!off)); }
};
$('c-model').onclick = () => window.MAJIN_ONBOARD && window.MAJIN_ONBOARD.togglePicker();
$('b-quit').onclick = async () => {
  if ($('b-quit').dataset.arm !== '1') { $('b-quit').dataset.arm = '1'; $('b-quit').textContent = 'quit?'; setTimeout(() => { $('b-quit').dataset.arm = ''; $('b-quit').textContent = window.MAJIN_STUDIO ? 'Quit MAJIN' : '⏻'; }, 3000); return; }
  $('b-quit').textContent = 'closing…';
  try { await fetch('/api/shutdown?t=' + encodeURIComponent(TOKEN), { method: 'POST' }); } catch { /* it goes away either way */ }
  try { window.close(); } catch { /* browsers may refuse */ }
};
$('b-expert').onclick = () => {
  if (window.MAJIN_STUDIO) { window.MAJIN_STUDIO.open('settings'); return; }
  const simple = document.body.classList.toggle('simple');
  $('b-expert').classList.toggle('on', !simple);
  try { localStorage.setItem('majin.expert', simple ? '0' : '1'); } catch { /* private mode */ }
};
try { if (!window.MAJIN_STUDIO && localStorage.getItem('majin.expert') === '1') { document.body.classList.remove('simple'); $('b-expert').classList.add('on'); } } catch { /* private mode */ }
$('b-panel').onclick = () => {
  document.body.classList.toggle('pan-off');
  $('b-panel').classList.toggle('on');
};
S.narratorEnglish = false;
try { S.narratorEnglish = localStorage.getItem('majin.voice.narratorEN') === 'true'; } catch {}
$('b-narrator')?.classList.toggle('on', S.narratorEnglish);
$('b-narrator')?.setAttribute('aria-pressed', String(S.narratorEnglish));
$('b-narrator').onclick = () => {
  S.narratorEnglish = !S.narratorEnglish;
  $('b-narrator').classList.toggle('on', S.narratorEnglish);
  $('b-narrator').setAttribute('aria-pressed', String(S.narratorEnglish));
  try {localStorage.setItem('majin.voice.narratorEN', String(S.narratorEnglish));}catch{}
  toast(S.narratorEnglish ? 'English Kokoro narrator enabled. Speak English for best quality.' : 'System voice enabled.');
};
$('b-voice').onclick = () => {
  S.voice = !S.voice;
  $('b-voice').classList.toggle('on', S.voice);
  if (!S.voice) {S.handsFree=false;stopMic();window.speechSynthesis?.cancel();}
};
$('b-test').onclick = async () => {
  setStatus('selftest…');
  try {
    const r = await api('/selftest', { method: 'POST', body: { level: 'full' } });
    addMsg('sys', 'selftest', r.text || 'done');
  } catch (e) {
    err(e.message);
  }
  setStatus('ready');
};
$('mic').onclick = micToggle;
if ($('voice-stage-stop')) $('voice-stage-stop').onclick = () => {
  S.handsFree=false;S.voiceTurn=false;
  stopMic();
  try { window.speechSynthesis?.cancel();voiceRequest?.abort();currentVoiceAudio?.pause(); } catch {}
  speechActive=false;
  voiceState('idle','Voice ready');
};
$('b-theme').onclick = () => {
  document.body.classList.add('theme-changing');
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('theme-changing')));
  const light = document.body.classList.toggle('light');
  try { localStorage.setItem('majin.theme', light ? 'light' : 'dark'); } catch { /* private mode */ }
};
try { if (localStorage.getItem('majin.theme') === 'light') document.body.classList.add('light'); } catch { /* ignorera */ }
$('b-mode').onclick = async () => {
  const order = [['assist', 'strict'], ['approval', 'confirm'], ['full auto', 'off']];
  const i = Math.max(0, order.findIndex(([l]) => $('b-mode').textContent.trim() === l));
  const [label, mode] = order[(i + 1) % order.length];
  $('b-mode').textContent = label;
  $('b-mode').title = 'Permission mode: ' + label + ' (guard.mode=' + mode + ')';
  try {
    await api('/config', { method: 'PATCH', body: { guard: { mode } } });
    note('permission mode → ' + label);
  } catch (e) {
    err('could not set mode: ' + e.message);
  }
};
$('b-stop').onclick = () => stop();
$('re-go').onclick = () => analyzePath($('re-path').value.trim());
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  $('drop').classList.add('hot');
});
document.addEventListener('dragleave', () => $('drop').classList.remove('hot'));
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  $('drop').classList.remove('hot');
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  await uploadAndAnalyze(f);
});
async function uploadAndAnalyze(f) {
  setStatus('uploading ' + f.name + '…');
  const buf = await f.arrayBuffer();
  const r = await fetch('/api/re/upload?t=' + encodeURIComponent(TOKEN) + '&name=' + encodeURIComponent(f.name), {
    method: 'POST',
    headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/octet-stream' },
    body: buf,
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) {
    err('uppladdning: ' + (j.error || r.status));
    setStatus('ready');
    return;
  }
  $('re-path').value = j.path;
  note(`got ${f.name} (${j.size} bytes) · sha256 ${String(j.sha256).slice(0, 16)}…`);
  await analyzePath(j.path);
  setStatus('ready');
}

window.addEventListener('load', async () => {
  try {
    const resume = JSON.parse(sessionStorage.getItem('majin.update.resume') || 'null');
    sessionStorage.removeItem('majin.update.resume');
    if (resume && typeof resume.session === 'string' && typeof resume.draft === 'string') {
      S.session = resume.session; $('input').value = resume.draft; autoGrow();
    }
  } catch { /* storage unavailable */ }
  listen();
  await refresh();
  await loadHistory();
  // Check on every app launch and repaint as soon as the request finishes.
  // A fixed 6.5-second refresh missed slow GitHub responses until the next
  // hourly check, leaving the update chip invisible even after CLI detected it.
  // Do not block chat or app startup on GitHub's network latency.
  if (S.st?.config?.updates?.check !== false) {
    void (async () => {
      try {
        await api('/update', { method: 'POST', body: { action: 'check', force: true } });
      } catch { /* Offline GitHub must not interrupt MAJIN; Check updates remains visible. */ }
      await refresh(true);
    })();
  }
  // Keep a running window informed of later releases, even if never reopened.
  setInterval(async () => {
    try {
      const st = await api('/state?tools=0');
      if (st?.config?.updates?.check === false) return;
      await api('/update', { method: 'POST', body: { action: 'check', force: true } });
      await refresh(true);
    } catch { /* an offline GitHub cannot interrupt MAJIN */ }
  }, 60 * 60 * 1000);
  if (window.paintPanelExtras) window.paintPanelExtras();
  $('input').focus();
});
window.MAJIN_CHAT = { stopTask: stopObservedTask };
window.refresh = refresh; // onboarding + model picker repaint through the same funnel
