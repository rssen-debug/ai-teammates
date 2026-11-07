/* MAJIN — P0 conversation list: archive/rename/delete, activity sorting,
 * optimistic bump on send, honest rollback. Server index is source of truth
 * (spec: docs/MAJIN-UI-UX-REPAIR-MASTER-2026-10-20.md).
 * Classic-script scope shared with app.js / panels.js (no modules).
 */
(function () {
  const api = async (path, opts = {}) => {
    const r = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
      body: opts.body == null ? undefined : JSON.stringify(opts.body),
    });
    const j = await r.json().catch(() => ({ ok: false, error: 'unparseable response (server?)' }));
    if (!r.ok || j.ok === false) { const e = new Error(j.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
    return j;
  };
  const apiToken = () => (typeof window.__MAJIN_TOKEN__ === 'string' ? window.__MAJIN_TOKEN__ : '');
  const apiPath = (p) => p + (p.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(apiToken());

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ST = {
    chats: [],
    view: 'active',                /* 'active' | 'archived' */
    search: '',
    loading: false,
    error: null,                   /* surfaced honest failure state */
    menu: { open: false, chat: null, anchor: null },
    dialog: null,                  /* {type:'rename'|'delete', chat, inputEl, confirmBtn} */
    focusedBeforeDialog: null,
  };

  function relativeLabel(iso) {
    if (!iso) return '';
    const d = new Date(iso); const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm';
    if (mins < 60 * 24) return Math.floor(mins / 60) + 'h';
    return Math.floor(mins / 1440) + 'd';
  }

  function currentSession() { return (window.S && window.S.session) || 'desktop'; }

  /* ------------------------------ data access ------------------------------ */
  async function refresh() {
    ST.loading = true; ST.error = null;
    render();
    try {
      const j = await api(apiPath(`/api/chats?view=${encodeURIComponent(ST.view)}&search=${encodeURIComponent(ST.search)}`));
      ST.chats = j.chats || [];
      ST.error = null;
    } catch (e) {
      ST.error = 'Could not load the chat list (' + (e.message || 'network') + ') — retry with the function-bar or wait for the next listener tick.';
    }
    ST.loading = false;
    render();
  }

  /* optimistic: the chat just messaged moves FIRST immediately;
     the next real refresh reconciles to server truth without flicker. */
  function bumpActive(id, previewText) {
    const now = new Date().toISOString();
    const existing = ST.chats.find((c) => c.id === id);
    if (existing) {
      existing.lastActivityAt = now;
      if (existing.title === 'New conversation' && previewText) existing.title = String(previewText).slice(0, 60);
    } else if (ST.view === 'active') {
      ST.chats.unshift({ id, title: previewText ? String(previewText).slice(0, 60) : 'New conversation', titlePolicy: 'fallback', lastActivityAt: now, createdAt: now, archivedAt: null, lastText: previewText || '', messages: 1, pending: true });
    }
    ST.chats.sort((a, b) => (a.lastActivityAt === b.lastActivityAt ? (a.id < b.id ? -1 : 1) : a.lastActivityAt < b.lastActivityAt ? 1 : -1));
    render();
  }

  async function actRename(chat, newTitle) {
    try {
      await api(apiPath('/api/chats/rename'), { method: 'POST', body: { id: chat.id, title: newTitle } });
      await refresh();
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  async function actArchive(chat, archived) {
    try {
      await api(apiPath('/api/chats/archive'), { method: 'POST', body: { id: chat.id, archived } });
      if (archived && currentSession() === chat.id) selectFallback(['desktop']);
      await refresh();
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  async function actDelete(chat, titleConfirm) {
    try {
      await api(apiPath('/api/chats/delete'), { method: 'POST', body: { id: chat.id, title: titleConfirm } });
      if (currentSession() === chat.id) selectFallback(['desktop']);
      await refresh();
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  function selectFallback(ids) {
    if (window.S) { window.S.session = ids[0]; }
    if (typeof window.loadHistory === 'function') window.loadHistory();
    render();
  }

  /* ---------------------------------- UI ---------------------------------- */

  function row(chat) {
    const li = document.createElement('div');
    li.className = 'sess' + (chat.id === currentSession() ? ' act' : '') + (chat.pending ? ' pending' : '') + (chat.archivedAt ? ' is-archived' : '');
    li.dataset.chatId = chat.id;
    li.dataset.search = (chat.title + ' ' + chat.id + ' ' + (chat.lastText || '')).toLowerCase();
    const btn = document.createElement('button');
    btn.className = 'sess-open';
    btn.setAttribute('aria-current', chat.id === currentSession() ? 'true' : 'false');
    btn.innerHTML = `<span class="session-label">${esc(chat.title)}</span><span class="sess-meta">${esc(String(chat.messages || 0))} · ${esc(relativeLabel(chat.lastActivityAt))}${chat.archivedAt ? ' · archived' : ''}</span>`;
    btn.title = chat.title + '\n' + (chat.lastText || '') + '\nlast activity ' + (chat.lastActivityAt || '');
    btn.onclick = () => openChat(chat);
    const more = document.createElement('button');
    more.className = 'sess-act dots';
    more.textContent = '…';
    more.setAttribute('aria-label', `Actions for chat "${chat.title}"`);
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', String(ST.menu.open && ST.menu.chat?.id === chat.id));
    more.onclick = (e) => { e.stopPropagation(); openMenu(chat, more); };
    more.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMenu(chat, more); } };
    li.append(btn, more);
    return li;
  }

  function openChat(chat) {
    if (window.S && (window.S.busy || window.S.stopRequested)) { toast('Stop the current task before switching chats.'); return; }
    if (typeof closeMobileRail === 'function') closeMobileRail();
    if (window.S) window.S.session = chat.id;
    if (typeof window.loadHistory === 'function') window.loadHistory();
    render();
  }

  function closeMenu() {
    const m = $('chat-menu'); if (m) m.remove();
    if (ST.menu.anchor) ST.menu.anchor.setAttribute('aria-expanded', 'false');
    ST.menu = { open: false, chat: null, anchor: null };
  }
  function openMenu(chat, anchorBtn) {
    if (ST.menu.open && ST.menu.chat?.id === chat.id) { closeMenu(); return; }
    closeMenu();
    ST.st = chat; ST.menu = { open: true, chat, anchor: anchorBtn };
    anchorBtn.setAttribute('aria-expanded', 'true');
    const m = document.createElement('div');
    m.id = 'chat-menu'; m.setAttribute('role', 'menu');
    const items = [];
    items.push(['rename', 'Rename', () => openDialog({ type: 'rename', chat })]);
    if (!chat.archivedAt) items.push(['archive', 'Archive', async () => { const r = await actArchive(chat, true); if (!r.ok) toast('Archive failed: ' + r.error); }]);
    else items.push(['restore', 'Restore', async () => { const r = await actArchive(chat, false); if (!r.ok) toast('Restore failed: ' + r.error); }]);
    items.push(['delete', 'Delete…', () => openDialog({ type: 'delete', chat })]);
    for (const [key, label, fn] of items) {
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      b.dataset.action = key;
      b.textContent = label;
      if (key === 'delete') b.className = 'danger';
      b.onclick = async () => { closeMenu(); await fn(); };
      m.append(b);
    }
    const rect = anchorBtn.getBoundingClientRect();
    m.style.position = 'fixed';
    m.style.top = Math.min(window.innerHeight - 120, rect.bottom + 4) + 'px';
    m.style.left = Math.min(window.innerWidth - 170, rect.right - 160) + 'px';
    document.body.append(m);
    const first = m.querySelector('button'); if (first) first.focus();
    m.addEventListener('keydown', (e) => {
      const bs = [...m.querySelectorAll('button')];
      const i = bs.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); closeMenu(); anchorBtn.focus(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); (bs[i + 1] || bs[0]).focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); (bs[i - 1] || bs[bs.length - 1]).focus(); }
    });
    document.addEventListener('mousedown', function h(e) { if (!m.contains(e.target)) { document.removeEventListener('mousedown', h); closeMenu(); } });
  }

  function openDialog({ type, chat }) {
    closeDialog();
    ST.focusedBeforeDialog = document.activeElement;
    const d = document.createElement('div');
    d.className = 'modal'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true');
    const card = document.createElement('div');
    card.className = 'modal-card';
    if (type === 'rename') {
      card.innerHTML = `<h3>Rename chat</h3><p class="kv">Same chat, new name — message history is untouched.</p>`;
      const input = document.createElement('input');
      input.type = 'text'; input.value = chat.title; input.maxLength = 80; input.setAttribute('aria-label', 'New chat title');
      card.append(input);
      const row = document.createElement('div'); row.className = 'modal-actions';
      const cancel = mkBtn('Cancel', () => closeDialog(true));
      const save = mkBtn('Save', async () => {
        const v = input.value.trim();
        if (!v) return;
        save.disabled = true; save.textContent = 'Saving…';
        const r = await actRename(chat, v);
        if (r.ok) closeDialog(true);
        else { save.disabled = false; save.textContent = 'Save'; toast('Rename failed: ' + r.error + ' — state rolled back.'); await refresh(); }
      }, true);
      input.onkeydown = (e) => { if (e.key === 'Enter') save.click(); if (e.key === 'Escape') { e.preventDefault(); closeDialog(true); } };
      row.append(cancel, save); card.append(row);
      ST.dialog = { type, input };
    } else {
      card.innerHTML = `<h3>Delete chat permanently?</h3><p>This removes <b>${esc(chat.title)}</b> and its message history from this device. Documents in your workspace are not deleted. This cannot be undone.</p>`;
      const input = document.createElement('input');
      input.type = 'text'; input.placeholder = `Type "${chat.title}" to confirm`; input.setAttribute('aria-label', 'Type the chat title to confirm deletion');
      card.append(input);
      const row = document.createElement('div'); row.className = 'modal-actions';
      const cancel = mkBtn('Cancel', () => closeDialog(true));
      const del = mkBtn('Delete permanently', async () => {
        del.disabled = true; del.textContent = 'Deleting…';
        const r = await actDelete(chat, input.value.trim());
        if (r.ok) closeDialog(true);
        else { del.disabled = false; del.textContent = 'Delete permanently'; toast('Delete failed: ' + r.error + ' — the chat stays.'); await refresh(); }
      }, true);
      del.disabled = true;
      input.oninput = () => { del.disabled = input.value.trim() !== chat.title; };
      input.onkeydown = (e) => {
        if (e.key === 'Enter' && !del.disabled) del.click();
        if (e.key === 'Escape') { e.preventDefault(); closeDialog(true); }
      };
      row.append(cancel, del); card.append(row);
      ST.dialog = { type, input };
    }
    d.append(card);
    d.onmousedown = (e) => { if (e.target === d) closeDialog(true); };
    document.body.append(d);
    if (ST.dialog?.input) ST.dialog.input.focus();
    ST.dialogHost = d;
  }
  function closeDialog(refocus) {
    const d = document.querySelector('.modal');
    if (d) d.remove();
    ST.dialog = null; ST.dialogHost = null;
    if (refocus && ST.focusedBeforeDialog && document.contains(ST.focusedBeforeDialog)) {
      ST.focusedBeforeDialog.focus();
      ST.focusedBeforeDialog = null;
    }
  }
  function mkBtn(label, fn, primary) {
    const b = document.createElement('button');
    b.textContent = label; if (primary) b.className = 'primary'; b.onclick = fn;
    return b;
  }

  function render() {
    const box = $('sessions'); if (!box) return;
    box.innerHTML = '';
    if (ST.error) { box.innerHTML = `<div class="chat-state error" role="alert">${esc(ST.error)}</div>`; return; }
    if (ST.loading && !ST.chats.length) { box.innerHTML = '<div class="chat-state">Loading conversations…</div>'; return; }
    if (!ST.chats.length) {
      box.innerHTML = `<div class="chat-state">${ST.view === 'archived' ? 'No archived chats — archived conversations will live here.' : ST.search ? 'No chats match your search.' : 'No conversations yet.'}</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    for (const c of ST.chats) frag.append(row(c));
    box.append(frag);
    const rec = document.querySelector('#chats-refresh');
    if (rec) rec.setAttribute('aria-disabled', String(ST.loading));
  }

  function toggleView() {
    ST.view = ST.view === 'active' ? 'archived' : 'active';
    const t = document.querySelector('#chats-archived-toggle');
    if (t) {
      t.textContent = ST.view === 'archived' ? 'Active chats' : 'Archived';
      t.setAttribute('aria-pressed', String(ST.view === 'archived'));
    }
    const h = document.querySelector('#rail h3');
    /* CAREFUL: h.textContent would also erase the toggle-button child — patch
       only the leading text node. */
    const textNode = h && [...h.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
    if (textNode) textNode.textContent = ST.view === 'archived' ? 'ARCHIVED' : 'RECENT';
    refresh();
  }

  let searchStateRestore = null;
  function onSearch(v) {
    ST.search = String(v || '');
    clearTimeout(searchStateRestore);
    searchStateRestore = setTimeout(refresh, 180);
  }

  function bindRail() {
    const headerRow = document.querySelector('#rail h3');
    if (headerRow && !document.getElementById('chats-archived-toggle')) {
      const wrap = document.createElement('span');
      wrap.style.cssText = 'display:inline-flex;gap:8px;float:right;';
      const arch = document.createElement('button');
      arch.id = 'chats-archived-toggle';
      arch.className = 'rail-mini';
      arch.type = 'button';
      arch.textContent = 'Archived';
      arch.setAttribute('aria-pressed', 'false');
      arch.title = 'View archived conversations — nothing is deleted by archiving';
      arch.onclick = toggleView;
      wrap.append(arch);
      headerRow.append(wrap);
    }
    /* studio.mount owns #chat-search and forwards to MAJIN_CHATS.setSearch —
       exactly one input owner, zero double-fetch. */
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && ST.dialogHost) { e.preventDefault(); closeDialog(true); }
    });
  }

  window.MAJIN_CHATS = {
    refresh,
    bumpActive,
    render,
    setSearch: onSearch,
    view: () => ST.view,
    stats: () => ({ chats: ST.chats.length, view: ST.view, error: ST.error }),
  };

  document.addEventListener('DOMContentLoaded', () => { bindRail(); refresh(); });
  if (document.readyState !== 'loading') { bindRail(); refresh(); }
})();
