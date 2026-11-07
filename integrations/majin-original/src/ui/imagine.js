/* MAJIN Imagination Engine — slice 1: Live Agent Vision + the Living Core.
 *
 * Rules this file lives by (from the IMAGINATION spec):
 *  - Every row comes from a REAL backend event with a real timestamp.
 *    Nothing here simulates activity; an idle agent shows an idle core.
 *  - Zero extra model calls: this is pure local rendering of the event
 *    stream the app already receives. No fetch, no LLM, no tokens.
 *  - Never inject model output into the DOM as HTML: textContent only.
 *  - It must stay understandable to a non-technical user: icons + plain
 *    labels, details hidden behind a click (native <details>: keyboard
 *    accessible for free).
 */
(function () {
  'use strict';

  // Quiet, readable activity rather than decorative emoji on every tool call.
  const ICONS = [
    [/search|web|crawl|scrape/i, 'SR'], [/browser|page|navigate/i, 'BR'],
    [/computer|screen|mouse|keyboard|window|desktop|control/i, 'PC'],
    [/image|draw|paint|photo|art/i, 'IM'], [/file|fs[._]|read|write|folder/i, 'FL'],
    [/shell|terminal|cmd|powershell|exec/i, 'TM'], [/schedule|cron/i, 'TM'],
    [/memory|remember|note/i, 'ME'], [/channel|message|send/i, 'MS'],
  ];
  const iconFor = (name) => ICONS.find(([re]) => re.test(name || ''))?.[1] || 'AI';
  const toolTitle = (name) => ({
    'fs.write': 'Created a file', 'fs.read': 'Read a file',
    'fs.patch': 'Updated a file', 'fs.list': 'Checked files',
    'shell.run': 'Ran a command', 'screen.capture': 'Captured the screen',
    'control.list_windows': 'Checked open windows', 'control.type': 'Entered text',
    'control.read': 'Read window content', 'control.click_button': 'Pressed a button',
    'mouse.move': 'Moved the mouse pointer', 'cursor.overlay': 'Showed an activity marker',
    'jobs.search': 'Searched job listings', 'jobs.match': 'Matched jobs to CV',
    'jobs.prepare': 'Prepared an application', 'jobs.send': 'Submitted an application'
  })[name] || String(name || 'Working').replace(/[._]/g,' ');

  // core states: idle | thinking | working | waiting | done | error
  let core = 'idle';
  let root = null, orb = null, coreLabel = null, list = null, empty = null;
  // Each tool call receives an ID from the existing MAJIN loop. Parallel tool
  // completions may arrive out of order; a single "current row" corrupts UI.
  const pendingById = new Map();
  const pendingByName = new Map();
  let preview = null;
  const PREVIEW_LIMIT = 400000;
  const BYTES = new TextEncoder();

  const CORE_TEXT = {
    idle: 'ready',
    thinking: 'thinking…',
    working: 'working',
    waiting: 'waiting for you',
    done: 'done ✓',
    error: 'something went wrong',
    stopped: 'stopped',
  };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text; // textContent — never innerHTML
    return n;
  }

  function mount() {
    root = document.getElementById('imagine');
    if (!root) return; // window misses the mount point: stay inert
    orb = el('div', 'core idle');
    orb.setAttribute('aria-hidden', 'true');
    coreLabel = el('span', 'core-label', '');
    const head = el('div', 'core-row');
    const toggle = el('button', 'activity-toggle', 'Activity details');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.onclick = () => { const expanded = root.classList.toggle('activity-open'); toggle.setAttribute('aria-expanded', String(expanded)); };
    head.append(orb, coreLabel, toggle);
    list = el('div', 'steps');
    empty = el('div', 'imagine-empty', 'MAJIN\'s live work appears here — step by step, in real time.');
    root.append(head, empty, list);
    paint();
  }

  function paint() {
    if (!root) return;
    orb.className = 'core ' + core;
    coreLabel.textContent = CORE_TEXT[core] || '';
    if (window.MAJIN_STUDIO) window.MAJIN_STUDIO.setState(core);
  }

  function setCore(state) {
    if (['error', 'stopped'].includes(core) && !['error', 'stopped'].includes(state)) return;
    if (core === 'done' && state === 'idle') return; // let "done ✓" breathe until the next run
    core = state;
    paint();
  }

  function stamp() {
    return new Date().toLocaleTimeString('sv-SE', { hour12: false });
  }

  function stepRow(icon, title, sub) {
    const row = el('div', 'step');
    row.append(el('span', 'step-icon', icon));
    const body = el('div', 'step-body');
    body.append(el('div', 'step-title', title));
    if (sub) body.append(el('div', 'step-sub', sub));
    row.append(body, el('span', 'step-time', stamp()));
    return row;
  }

  function show() {
    if (!root) return;
    root.hidden = false;
    if (empty && empty.parentNode) empty.remove();
    empty = null;
  }

  function addStep(row) {
    if (!root) return;
    show();
    list.append(row);
    // Activity must never move the conversation while the reader is scrolling.
  }

  function detailEl(obj) {
    const d = el('details', 'step-detail');
    d.append(el('summary', '', 'details'));
    const pre = el('pre');
    pre.textContent = JSON.stringify(obj, null, 2); // safe: textContent
    d.append(pre);
    return d;
  }

  function track(name, row, callId) {
    const key = String(name || 'tool');
    if (!pendingByName.has(key)) pendingByName.set(key, []);
    pendingByName.get(key).push(row);
    if (callId) pendingById.set(String(callId), row);
  }

  function previewHtml(path, size, row) {
    if (!/\.html?$/i.test(path) || (Number(size) || 0) > PREVIEW_LIMIT) return;
    const btn = el('button', 'preview-action', 'Preview HTML');
    btn.type = 'button';
    btn.title = 'Preview a local HTML file without running scripts';
    btn.onclick = async () => {
      if (window.MAJIN_STUDIO) { window.MAJIN_STUDIO.previewFile(path); return; }
      btn.disabled = true;
      btn.textContent = 'Loading preview…';
      try {
        const token = window.__MAJIN_TOKEN__ || 'demo';
        const res = await fetch('/api/file?path=' + encodeURIComponent(path) + '&t=' + encodeURIComponent(token), {
          headers: { authorization: 'Bearer ' + token },
        });
        if (!res.ok) throw new Error('Cannot read this file (' + res.status + ')');
        const length = Number(res.headers.get('content-length') || 0);
        if (length > PREVIEW_LIMIT) throw new Error('Preview is too large');
        const html = await res.text();
        if (BYTES.encode(html).length > PREVIEW_LIMIT) throw new Error('Preview is too large');

        if (preview) preview.remove();
        preview = el('section', 'preview-panel');
        preview.setAttribute('aria-label', 'HTML preview');
        const head = el('div', 'preview-head');
        head.append(el('strong', '', 'Live file preview'));
        const close = el('button', 'preview-close', '✕ Close');
        close.type = 'button';
        close.onclick = () => { preview.remove(); preview = null; };
        head.append(close);
        const frame = document.createElement('iframe');
        frame.className = 'preview-frame';
        frame.title = 'Sandboxed HTML file preview';
        frame.setAttribute('sandbox', ''); // no scripts, forms, top navigation or same-origin access
        frame.setAttribute('referrerpolicy', 'no-referrer');
        const csp = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'\">";
        frame.srcdoc = csp + html;
        preview.append(head, frame);
        root.append(preview);
        preview.scrollIntoView({ block: 'nearest' });
      } catch (error) {
        btn.textContent = String(error.message || error);
      } finally {
        btn.disabled = false;
        if (btn.textContent === 'Loading preview…') btn.textContent = 'Preview HTML';
      }
    };
    row.append(btn);
  }

  /* Feed one real run event. Called from app.js's onEvent — the single
   * funnel the SSE stream already passes through. */
  function onEvent(ev) {
    if (!root || !ev || !ev.type) return;
    switch (ev.type) {
      case 'route':
        addStep(stepRow('🧭', 'routing chose: ' + (ev.job || 'chat'), (ev.model || '').split('/').pop()));
        setCore('thinking');
        break;
      case 'step':
        setCore('thinking');
        break;
      case 'tool': {
        // Older MAJIN streams announce proposed tool calls without IDs. Retain
        // those rows and attach call IDs once the loop starts the real calls.
        setCore('working');
        const name = String(ev.name || 'tool');
        const row = stepRow(iconFor(name), toolTitle(name), 'In progress');
        row.classList.add('running');
        addStep(row);
        track(name, row, ev.callId);
        break;
      }
      case 'tool_begin': {
        setCore('working');
        const name = String(ev.name || 'tool');
        // Reuse the proposed row if it already exists; never show duplicates.
        let row = (pendingByName.get(name) || []).find((r) => !r.dataset.callId && !r.dataset.finished);
        if (!row) {
          row = stepRow(iconFor(name), name, 'running…');
          row.classList.add('running');
          addStep(row);
          track(name, row);
        }
        if (ev.callId) {
          row.dataset.callId = String(ev.callId);
          pendingById.set(String(ev.callId), row);
        }
        break;
      }
      case 'tool_result': {
        const name = String(ev.tool || 'tool');
        let row = ev.callId ? pendingById.get(String(ev.callId)) : null;
        if (!row) row = (pendingByName.get(name) || []).find((r) => !r.dataset.finished);
        if (!row) {
          row = stepRow(iconFor(name), name, 'running…');
          addStep(row);
        }
        row.dataset.finished = '1';
        row.classList.remove('running');
        row.classList.add(ev.ok ? 'ok' : 'fail');
        const sub = row.querySelector('.step-sub');
        const errText = typeof ev.error === 'string' ? ev.error : (ev.error && ev.error.message) || 'unknown';
        if (sub) sub.textContent = ev.ok ? (ev.summary || 'Completed') : 'Failed: ' + errText;
        row.append(detailEl({ tool: ev.tool, ok: ev.ok, summary: ev.summary, error: ev.error, meta: ev.meta }));
        if (ev.callId) pendingById.delete(String(ev.callId));
        if (ev.ok && ev.meta && typeof ev.meta.path === 'string') {
          previewHtml(ev.meta.path, ev.meta.bytes, row);
        }
        if (!pendingById.size) setCore('thinking');
        break;
      }
      case 'escalate':
        addStep(stepRow('⬆️', 'escalating to ' + (ev.to || 'a stronger model'), ev.why || ''));
        break;
      case 'compact':
        addStep(stepRow('🗜️', 'compacting memory', (ev.tokens || 0) + ' token'));
        break;
      case 'approval:request':
        setCore('waiting');
        addStep(stepRow('⏳', 'waiting for your approval', ev.tool || ''));
        break;
      case 'approval:resolved':
        setCore('working');
        break;
      case 'tool.denied':
        addStep(stepRow('🚫', 'tool denied by you', ev.tool || ''));
        setCore('thinking');
        break;
      case 'moa:start':
        addStep(stepRow('◇', 'reference round started', String(ev.width || 0) + ' model references'));
        setCore('thinking');
        break;
      case 'moa:ref':
        addStep(stepRow(ev.ok ? '✓' : '!', 'reference ' + (ev.ref || ''), ev.ok ? 'answered' : 'failed'));
        break;
      case 'moa:done':
        addStep(stepRow('◇', 'reference round finished', String(ev.refs || 0) + ' references'));
        break;
      case 'moa:degraded':
        addStep(stepRow('!', 'reference round degraded', ev.reason || ''));
        break;
      case 'usage': {
        const u = ev.tokensIn + ev.tokensOut;
        addStep(stepRow('📊', 'steg ' + (ev.step || '?'), u + ' token' + (ev.costUsd ? ' · $' + ev.costUsd.toFixed(4) : '')));
        break;
      }
      case 'answer': {
        if (core === 'error' || core === 'stopped') break;
        const meta = ev.meta || {};
        const bits = [
          meta.steps && meta.steps + ' steps',
          meta.usage && (meta.usage.input + meta.usage.output) + ' token',
          meta.usage && meta.usage.costUsd ? '$' + meta.usage.costUsd.toFixed(4) : null,
        ].filter(Boolean);
        addStep(stepRow('✅', 'done', bits.join(' · ')));
        setCore('done');
        break;
      }
      case 'cancelled':
        setCore('stopped');
        break;
      case 'schedule.done':
        addStep(stepRow('🗓️', 'scheduled job finished', ev.name || ''));
        break;
      case 'schedule.failed':
        addStep(stepRow('⚠️', 'scheduled job failed', ev.name || ''));
        setCore('error');
        break;
      case 'error':
        addStep(stepRow('⚠️', 'error', String(ev.message || ev.text || 'unknown error')));
        setCore('error');
        break;
      default:
        break; // unknown events are ignored rather than faked
    }
  }

  /* A fresh run starts a fresh canvas: an old task must never paint over it. */
  function reset() {
    if (!root) return;
    list.textContent = '';
    if (window.MAJIN_STUDIO) window.MAJIN_STUDIO.resetRun();
    pendingById.clear();
    pendingByName.clear();
    if (preview) preview.remove();
    preview = null;
    core = 'idle';
    root.hidden = true;
    if (!empty) {
      empty = el('div', 'imagine-empty', 'MAJIN\'s live work appears here — step by step, in real time.');
      root.insertBefore(empty, list);
    }
    paint();
  }

  window.MAJIN_IMAGINE = { onEvent, reset, get state() { return core; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
