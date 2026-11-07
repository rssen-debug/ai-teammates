/* MAJIN Studio: contextual views over real tasks, events and workspace files.
 * No simulated agents, progress, file trees or inference calls. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const files = new Map();
  const ACTIVE = new Set(['running', 'waiting', 'paused']);
  const LABELS = { idle: 'Ready', connecting: 'Connecting to your model', thinking: 'Thinking', working: 'Working', waiting: 'Waiting for your approval', done: 'Response complete', error: 'Request needs attention', stopped: 'Stopped' };
  const TABS = ['activity', 'files', 'preview', 'settings'];
  let tasks = [], taskLimit = 30, selected = null, state = 'idle', previewRequest = null, previousFocus = null, previewedPath = null;

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function fileUrl(path) {
    return '/api/file?path=' + encodeURIComponent(path) + '&t=' + encodeURIComponent(window.__MAJIN_TOKEN__ || 'demo');
  }
  async function request(path, body) {
    const token = window.__MAJIN_TOKEN__ || 'demo';
    const r = await fetch('/api' + path + (path.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(token), {
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    });
    const j = await r.json();
    if (!r.ok || j.ok === false) throw new Error(typeof j.error === 'string' ? j.error : 'Could not complete this action.');
    return j;
  }
  function open(tab = 'activity') {
    previousFocus = document.activeElement;
    $('studio').hidden = false;
    document.body.classList.add('studio-open');
    $('b-studio').setAttribute('aria-expanded', 'true');
    selectTab(tab);
    $('tab-' + tab).focus();
    refreshTasks();
  }
  function close() {
    document.body.classList.remove('studio-wide');
    $('studio').hidden = true;
    document.body.classList.remove('studio-open');
    $('b-expert').classList.remove('on');
    $('b-studio').setAttribute('aria-expanded', 'false');
    if (previousFocus?.isConnected && previousFocus.getClientRects().length) previousFocus.focus();
    else $('b-studio').focus();
  }
  function selectTab(tab) {
    document.body.classList.remove('studio-wide');
    const expand = document.querySelector('.preview-expand'); if (expand) expand.textContent = 'Widen preview';
    $('b-expert').classList.toggle('on', tab === 'settings');
    for (const name of TABS) {
      const on = tab === name;
      $('tab-' + name).setAttribute('aria-selected', String(on));
      $('tab-' + name).tabIndex = on ? 0 : -1;
      $('view-' + name).hidden = !on;
    }
  }
  function setState(next) {
    state = LABELS[next] ? next : 'idle';
    const run = $('run-state');
    if (!run) return;
    run.dataset.state = state;
    run.hidden = state === 'idle';
    $('run-label').textContent = LABELS[state];
    document.body.dataset.runState = state;
  }
  function renderTasks() {
    const box = $('studio-tasks');
    if (!box) return;
    const focusedTask = box.contains(document.activeElement) ? document.activeElement.closest('[data-task]')?.dataset.task : null;
    box.textContent = '';
    const live = tasks.filter(t => ACTIVE.has(t.status));
    $('studio-task-summary').textContent = live.length ? live.length + ' active' : 'No active tasks';
    $('task-count').hidden = live.length === 0;
    $('task-count').textContent = live.length;
    if (!tasks.length) {
      const empty = node('div', 'studio-empty');
      empty.append(node('span', 'constellation-idle', '✧'), node('h3', '', 'Space to do great things.'), node('p', '', 'Real tasks appear here when MAJIN starts working.'));
      box.append(empty);
    }
    // Active tasks first; completed tasks remain inspectable without crowding chat.
    const ordered = [...tasks].sort((a, b) => Number(ACTIVE.has(b.status)) - Number(ACTIVE.has(a.status)) || b.created - a.created);
    for (const t of ordered.slice(0, taskLimit)) {
      const card = node('button', 'agent-node' + (selected === t.id ? ' selected' : ''));
      card.type = 'button'; card.dataset.task = t.id; card.dataset.state = t.status;
      card.setAttribute('aria-expanded', String(selected === t.id));
      const mark = node('span', 'agent-mark', t.status === 'done' ? '✓' : t.status === 'error' ? '!' : '✧');
      mark.setAttribute('aria-hidden', 'true');
      const text = node('span', 'agent-copy');
      text.append(node('strong', '', t.input || 'Untitled task'), node('span', '', t.curTool ? 'Using ' + t.curTool : (t.toolsRun || 0) + ' tools completed'));
      card.append(mark, text, node('span', 'agent-status', t.status));
      card.onclick = () => { selected = selected === t.id ? null : t.id; renderTasks(); box.querySelectorAll('[data-task]').forEach(n => { if (n.dataset.task === t.id) n.focus(); }); };
      box.append(card);
    }
    if (ordered.length > taskLimit) {
      const more = node('button', 'explorer-more', 'Show more tasks');
      more.onclick = () => { taskLimit += 30; renderTasks(); }; box.append(more);
    }
    if (focusedTask) [...box.querySelectorAll('[data-task]')].find(n => n.dataset.task === focusedTask)?.focus({ preventScroll: true });
    const detail = $('task-detail');
    const t = tasks.find(t => t.id === selected);
    detail.hidden = !t;
    detail.textContent = '';
    if (t) {
      detail.append(node('span', 'eyebrow', 'TASK DETAILS'), node('h3', '', t.input || t.id));
      const dl = node('dl', 'studio-facts');
      for (const [key, value] of [['Status', t.status], ['Source', t.source || 'Unknown'], ['Tools completed', t.toolsRun || 0], ['Last update', new Date(t.updated).toLocaleTimeString()], ['Task ID', t.id]]) {
        dl.append(node('dt', '', key), node('dd', '', value));
      }
      detail.append(dl);
      if (Array.isArray(t.locks) && t.locks.length) detail.append(node('p', 'studio-caption', 'Working files: ' + t.locks.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(', ')));
      if (ACTIVE.has(t.status)) {
        const stop = node('button', 'studio-stop', 'Stop this task');
        stop.onclick = async () => {
          stop.disabled = true;
          try {
            if (window.MAJIN_CHAT) await window.MAJIN_CHAT.stopTask(t.id);
            else await request('/chat/stop', { task: t.id });
            await refreshTasks();
          }
          catch (e) { stop.disabled = false; stop.textContent = e.message + ' — retry'; }
        };
        detail.append(stop);
      }
    }
  }
  function updateTasks(next) {
    $('task-connection').hidden = true;
    if (JSON.stringify(tasks) === JSON.stringify(next)) return;
    tasks = next.map(t => {
      const previous = tasks.find(p => p.id === t.id);
      const newerRun = (t.run || 1) > (previous?.run || 1);
      return previous && !newerRun && ((previous.run || 1) > (t.run || 1) || previous.updated > t.updated || (['done', 'error', 'stopped'].includes(previous.status) && ACTIVE.has(t.status))) ? previous : t;
    });
    renderTasks();
  }
  function tasksUnavailable() {
    if (!$('task-connection')) return;
    $('task-connection').hidden = false;
    $('task-connection').textContent = 'Task connection unavailable. Showing the last observed state.';
  }
  async function refreshTasks() {
    try { const result = await request('/tasks'); if (Array.isArray(result.tasks)) updateTasks(result.tasks); else tasksUnavailable(); }
    catch { tasksUnavailable(); }
  }
  function renderFiles() {
    const box = $('studio-files'); box.textContent = '';
    $('file-count').textContent = files.size;
    $('view-files').querySelector('.studio-empty').hidden = files.size > 0;
    for (const path of files.keys()) {
      const button = node('button', 'studio-file');
      button.type = 'button';
      button.append(node('span', 'file-extension', path.split('.').pop().slice(0, 5).toUpperCase()), node('span', 'file-copy', path.split(/[\\/]/).pop()), node('span', '', '↗'));
      button.title = path;
      button.onclick = () => previewFile(path);
      box.append(button);
    }
  }
  async function previewFile(path) {
    previewedPath = path;
    if (!files.has(path)) { files.set(path, {}); renderFiles(); }
    if ($('studio').hidden) open('preview'); else selectTab('preview');
    previewRequest?.abort();
    const ac = new AbortController(); previewRequest = ac;
    const box = $('studio-preview'); box.textContent = '';
    const head = node('div', 'file-preview-head');
    head.append(node('strong', '', path.split(/[\\/]/).pop()));
    const download = node('a', 'preview-download', 'Download'); download.href = fileUrl(path); download.download = path.split(/[\\/]/).pop();
    const expand = node('button', 'preview-expand', 'Widen preview');
    expand.onclick = () => { const wide = document.body.classList.toggle('studio-wide'); expand.textContent = wide ? 'Restore width' : 'Widen preview'; };
    head.append(expand, download); box.append(head);
    const caption = node('p', 'studio-caption', 'Reading the current file from your workspace…');
    caption.setAttribute('role', 'status'); box.append(caption);
    const stage = node('div', 'preview-stage'); box.append(stage);
    try {
      if (!/\.(html?|md|txt|json|csv|css|js|ts|jsx|tsx|py|xml|svg|ya?ml|log)$/i.test(path)) throw new Error('Inline preview is unavailable for this file type. Use Download to open the original file.');
      const res = await fetch(fileUrl(path), { signal: ac.signal });
      if (!res.ok) throw new Error('Cannot read this file (HTTP ' + res.status + ').');
      if (Number(res.headers.get('content-length')) > 400000) throw new Error('This file is too large for an inline preview. Use Download for the full file.');
      const text = await res.text();
      if (new TextEncoder().encode(text).length > 400000) throw new Error('This file is too large for an inline preview.');
      if (ac.signal.aborted) return;
      if (/\.html?$/i.test(path)) {
        caption.textContent = 'Current file · scripts and external resources disabled';
        const frame = document.createElement('iframe'); frame.title = 'Workspace HTML preview'; frame.className = 'studio-preview-frame';
        frame.setAttribute('sandbox', ''); frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.srcdoc = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; font-src data:; style-src \'unsafe-inline\'; form-action \'none\'; base-uri \'none\'">' + text;
        stage.append(frame);
      } else { caption.textContent = 'Current file · read-only'; stage.append(node('pre', 'file-source', text)); }
    } catch (e) {
      if (e.name === 'AbortError') return;
      caption.textContent = e.message;
      const retry = node('button', 'preview-action', 'Try again'); retry.onclick = () => previewFile(path); stage.append(retry);
    }
  }
  function onEvent(ev) {
    if (ev.type === 'tool_result' && ev.ok && typeof ev.meta?.path === 'string') {
      files.set(ev.meta.path, { bytes: ev.meta.bytes }); renderFiles();
      // Refresh the actual file when it changes. Only auto-open the first
      // HTML artifact if the preview is empty; never replace an active view
      // with an unrelated log, screenshot or generated file.
      if (ev.meta.path === previewedPath ||
          (!previewedPath && /\.html?$/i.test(ev.meta.path))) {
        void previewFile(ev.meta.path);
      }
    }
  }
  function resetRun() {
    // A new chat turn is NOT a new filesystem. Keep artifacts and the live
    // preview visible while the agent edits the same website over many turns.
    // Clearing this map made a working website disappear after any follow-up.
    renderFiles();
    setState('idle');
  }
  function filterChats() {
    const query = $('chat-search').value.trim().toLowerCase(); let matches = 0;
    document.querySelectorAll('#sessions .sess').forEach(n => { n.hidden = !n.dataset.search?.includes(query); if (!n.hidden) matches++; });
    $('chat-empty').hidden = matches > 0 || !query;
  }
  function setUsage(usage) {
    $('b-studio').title = 'Workspace · ' + (usage.requests || 0) + ' model calls · ' + (usage.costUsd == null ? 'cost unknown' : '$' + Number(usage.costUsd).toFixed(4));
  }
  function mount() {
    $('activity-mount').append($('imagine'));
    $('settings-mount').append($('panel'));
    for (const [id, label] of [['b-theme', 'Appearance'], ['b-voice', 'Read aloud'], ['b-test', 'Self-test'], ['b-quit', 'Quit MAJIN']]) {
      const button = $(id); button.textContent = label;
      document.querySelector('.settings-utilities').append(button);
    }
    $('imagine').classList.add('activity-open');
    $('b-studio').onclick = () => $('studio').hidden ? open() : close();
    $('studio-close').onclick = close;
    $('run-details').onclick = () => open('activity');
    $('chat-search').oninput = (e) => {
      filterChats();
      if (window.MAJIN_CHATS) window.MAJIN_CHATS.setSearch(e.target.value); /* P0: server-side index also searches titles/history/archive */
    };
    for (const tab of TABS) {
      $('tab-' + tab).onclick = () => selectTab(tab);
      $('tab-' + tab).onkeydown = e => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const next = e.key === 'Home' ? TABS[0] : e.key === 'End' ? TABS.at(-1) : TABS[(TABS.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
        selectTab(next); $('tab-' + next).focus();
      };
    }
    document.addEventListener('keydown', e => {
      if (e.defaultPrevented) return;
      if (e.key === 'Escape' && !$('studio').hidden && $('modeldrop').hidden && $('onboard').hidden) { e.preventDefault(); close(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n' && !e.shiftKey) { e.preventDefault(); $('new-chat').click(); }
    });
    document.addEventListener('visibilitychange', () => document.body.classList.toggle('page-hidden', document.hidden));
    renderTasks(); renderFiles();
  }
  window.MAJIN_STUDIO = { open, close, setState, updateTasks, tasksUnavailable, previewFile, onEvent, resetRun, filterChats, setUsage };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
