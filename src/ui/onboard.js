/* MAJIN — one-chat onboarding: detect what works, ask only for what is missing.
 * The existing /api/state, /api/provider and /api/config remain the source of truth.
 * Never expose or echo keys. Providers beyond the first are an advanced choice.
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const ROUTE_JOBS = ['chat', 'tasks', 'tools', 'code', 're', 'analysis', 'plan', 'research', 'summarize', 'router', 'final', 'aggregator', 'vision'];
  const OB = { st: null, provider: null, shown: false, working: false, forceEdit: false };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function apiLocal(p, o) {
    const token = window.__MAJIN_TOKEN__ || 'demo';
    const opt = { ...(o || {}) };
    opt.headers = { 'content-type': 'application/json', ...(opt.headers || {}) };
    if (opt.body && typeof opt.body !== 'string') opt.body = JSON.stringify(opt.body);
    return fetch('/api' + p + (p.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(token), opt).then((r) => r.json());
  }
  function tellErr(resp, fallback) {
    if (!resp) return 'MAJIN did not respond. Is it still running?';
    if (resp.ok) return null;
    const bits = [];
    if (resp.error) bits.push(typeof resp.error === 'string' ? resp.error : (resp.error.message || 'Connection failed'));
    if (resp.hint) bits.push(resp.hint);
    if (Array.isArray(resp.errors)) bits.push(resp.errors.map((e) => (e.path ? e.path + ': ' : '') + e.msg).join('; '));
    return bits.join(' — ') || fallback || 'Something went wrong. Try again.';
  }
  function status(name) {
    return (OB.st && OB.st.providers || []).find((p) => p.name === name);
  }
  function connected() {
    const all = (OB.st && OB.st.providers || []).filter((p) => p.ready && p.kind !== 'mock');
    const active = (OB.st && OB.st.routes || []).find((r) => r.job === 'chat');
    return all.find((p) => p.name === active?.provider) || all[0] || null;
  }
  function open(st) {
    OB.st = st;
    OB.provider = null;
    OB.forceEdit = false;
    OB.shown = true;
    $('onboard').hidden = false;
    render();
  }
  function close() {
    $('onboard').hidden = true;
    OB.shown = false;
    OB.working = false;
    if (typeof window.refresh === 'function') window.refresh(true);
  }
  function skipForNow() {
    try { sessionStorage.setItem('majin.onboard.skip', '1'); } catch { /* private browsing */ }
    close();
  }
  function render() {
    const box = $('ob-body');
    box.textContent = '';
    if (OB.provider) renderConnect(box);
    else renderWelcome(box);
  }
  function renderWelcome(box) {
    box.append(el('div', 'ob-mark', '✦'));
    box.append(el('h2', 'ob-title', 'Meet MAJIN'));
    box.append(el('p', 'ob-sub', 'Your AI, ready to help. Just connect one model to get started.'));

    const existing = connected();
    if (existing) {
      const ready = el('div', 'ob-ready');
      ready.append(el('span', 'ob-ready-dot', '●'));
      ready.append(el('span', '', existing.label + ' is configured'));
      box.append(ready);
      const go = el('button', 'ob-go', 'Start chatting →');
      go.type = 'button';
      go.onclick = () => {
        // Respect existing model routes and credentials. No paid probe on startup.
        close();
        const input = $('input');
        if (input) input.focus();
      };
      box.append(go);
    }

    const label = el('label', 'ob-label', existing ? 'Want to use a different AI?' : 'Choose your AI');
    label.htmlFor = 'ob-choice';
    const select = el('select', 'ob-input');
    select.id = 'ob-choice';
    const presets = (OB.st && OB.st.presets || []).filter((p) => p.name !== 'mock');
    const order = ['opencode', 'openrouter', 'deepseek', 'openai', 'gemini', 'anthropic', 'groq', 'kilocode', 'nous', 'opencodezen', 'ollama', 'lmstudio'];
    const sorted = [...presets].sort((a, b) => (order.indexOf(a.name) < 0 ? 100 : order.indexOf(a.name)) - (order.indexOf(b.name) < 0 ? 100 : order.indexOf(b.name)));
    for (const p of sorted) {
      const option = el('option', '', p.label + (status(p.name)?.ready ? ' · connected' : ''));
      option.value = p.name;
      select.append(option);
    }
    // Cloud-first onboarding: suggest OpenCode Go when available, without changing saved choices.
    select.value = existing ? existing.name : (presets.some((p) => p.name === 'opencode') ? 'opencode' : sorted[0]?.name || '');
    if (!select.value && sorted.length) select.value = sorted[0].name;
    label.append(select);
    box.append(label);

    const next = el('button', 'ob-go ob-choose', existing ? 'Change AI →' : 'Continue →');
    next.type = 'button';
    next.onclick = () => {
      OB.provider = presets.find((p) => p.name === select.value) || null;
      render();
    };
    box.append(next);

    const details = el('details', 'ob-details');
    const summary = el('summary', '', 'More options');
    details.append(summary);
    const others = el('div', 'ob-options');
    const custom = el('button', 'ob-link', 'Use a custom API endpoint');
    custom.type = 'button';
    custom.onclick = () => { OB.provider = { name: 'custom', label: 'Custom endpoint', custom: true, needsKey: false }; render(); };
    const demo = el('button', 'ob-link', 'Try demo mode (no real AI)');
    demo.type = 'button';
    demo.onclick = skipForNow;
    others.append(custom, demo);
    if (existing) {
      const p = existing;
      const changeKey = el('button', 'ob-link', 'Replace the saved key for ' + p.label);
      changeKey.type = 'button';
      changeKey.onclick = () => {
        OB.forceEdit = true;
        OB.provider = (OB.st.presets || []).find((choice) => choice.name === p.name) || null;
        render();
      };
      const forget = el('button', 'ob-link', 'Forget ' + p.label + ' connection');
      forget.type = 'button';
      forget.onclick = async () => {
        if (!confirm('Remove this AI connection from MAJIN?')) return;
        forget.disabled = true;
        const result = await apiLocal('/provider', { method: 'POST', body: { action: 'remove', name: p.name } }).catch(() => null);
        if (!result || !result.ok) {
          forget.textContent = tellErr(result, 'Could not remove this connection.');
          forget.disabled = false;
          return;
        }
        const fresh = await apiLocal('/state?tools=0').catch(() => null);
        if (fresh) OB.st = fresh;
        OB.forceEdit = false;
        OB.provider = null;
        render();
      };
      others.append(changeKey, forget);
    }
    details.append(others);
    box.append(details);
    const skip = el('button', 'ob-link ob-skip', 'Skip for now');
    skip.id = 'ob-skip';
    skip.type = 'button';
    skip.onclick = skipForNow;
    box.append(skip);
  }

  function renderConnect(box) {
    const p = OB.provider;
    const back = el('button', 'ob-link', '← Back');
    back.type = 'button';
    back.onclick = () => { OB.provider = null; render(); };
    box.append(back, el('div', 'ob-mark', '✦'), el('h2', 'ob-title', 'Connect ' + p.label));
    const existing = OB.forceEdit ? null : status(p.name);
    if (p.notes && ['opencode', 'opencodezen', 'qwen'].includes(p.name)) box.append(el('p', 'ob-sub', p.notes));
    box.append(el('p', 'ob-sub', existing && existing.ready
      ? 'A key is saved for this provider. Choose a current model to continue.'
      : (p.custom ? 'Connect a cloud API or a local model. Use the endpoint and key from your provider.' : p.needsKey ? 'Paste your key once. MAJIN keeps it on this computer.' : 'No API key needed. Make sure the local AI server is running.')));

    const urlIn = p.custom || !existing?.ready ? el('input', 'ob-input') : null;
    const kindIn = p.custom ? el('select', 'ob-input') : null;
    const nameIn = p.custom ? el('input', 'ob-input') : null;
    if (kindIn) {
      kindIn.setAttribute('aria-label', 'API protocol');
      nameIn.setAttribute('aria-label', 'Connection name');
      const label = el('label', 'ob-label', 'API protocol');
      for (const [value, text] of [['openai', 'OpenAI compatible'], ['anthropic', 'Anthropic'], ['gemini', 'Google Gemini']]) { const option = el('option', '', text); option.value = value; kindIn.append(option); }
      label.append(kindIn); box.append(label);
      const nameLabel = el('label', 'ob-label', 'Connection name'); nameIn.value = 'custom'; nameLabel.append(nameIn); box.append(nameLabel);
    }
    if (urlIn) {
      const label = el('label', 'ob-label', 'Endpoint URL');
      urlIn.placeholder = 'http://127.0.0.1:1234/v1';
      urlIn.autocomplete = 'off';
      urlIn.setAttribute('aria-label', 'Endpoint URL');
      urlIn.value = p.baseUrl || '';
      label.append(urlIn);
      if (p.custom) box.append(label);
      else {
        const advanced = el('details', 'ob-details');
        advanced.append(el('summary', '', 'Connection options'), label);
        box.append(advanced);
      }
    }
    const keyIn = (p.needsKey && !existing?.ready) || p.custom ? el('input', 'ob-input') : null;
    if (keyIn) {
      const label = el('label', 'ob-label', 'API key' + (p.custom ? ' (optional for local models)' : ''));
      keyIn.type = 'password';
      keyIn.autocomplete = 'off';
      keyIn.placeholder = 'Paste your API key';
      label.append(keyIn);
      box.append(label);
    }
    if (p.keyUrl && !existing?.ready) {
      const link = el('a', 'ob-link', 'Where do I get a key? ↗');
      link.href = p.keyUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      box.append(link);
    }

    const msg = el('p', 'ob-msg');
    msg.setAttribute('role', 'status');
    msg.setAttribute('aria-live', 'polite');
    const go = el('button', 'ob-go', existing?.ready ? 'Choose a model →' : 'Save and choose model →');
    go.type = 'button';
    go.onclick = async () => {
      if (OB.working) return;
      OB.working = true;
      go.disabled = true;
      try {
        if (existing?.ready && !p.custom) {
          // Changing provider is explicit, and needs no additional model tokens.
          await finishSetup(p.name, msg);
        } else {
          if (p.custom && !urlIn.value.trim()) {
            msg.textContent = 'Enter the URL of your AI server.';
            return;
          }
          if (p.needsKey && !p.custom && !keyIn?.value.trim()) {
            msg.textContent = 'Paste your API key to connect.';
            return;
          }
          msg.textContent = 'Connecting…';
          const body = p.custom
            ? { action: 'add', name: nameIn.value.trim(), kind: kindIn.value, baseUrl: urlIn.value.trim(), apiKey: keyIn?.value.trim() || '' }
            : { action: 'add', preset: p.name, name: p.name, ...(urlIn ? { baseUrl: urlIn.value.trim() } : {}), ...(keyIn ? { apiKey: keyIn.value.trim() } : {}) };
          const added = await apiLocal('/provider', { method: 'POST', body }).catch(() => null);
          const error = tellErr(added, 'Could not connect.');
          if (error) { msg.textContent = error; return; }
          await finishSetup(added.provider || body.name, msg);
        }
      } finally {
        OB.working = false;
        go.disabled = false;
      }
    };
    box.append(go, msg);
  }

  async function finishSetup(name, msg) {
    msg.textContent = 'Finding a model…';
    const fresh = await apiLocal('/state?tools=0').catch(() => null);
    if (!fresh?.providers) { msg.textContent = 'Connection saved. Reopen providers to choose a model when MAJIN responds.'; return; }
    OB.st = fresh;
    // Connecting credentials must not silently choose a priced or stale preset.
    close();
    PICKER.preferred = name;
    await togglePicker();
  }

  /* ------------------------- model picker chip ------------------------- */

  const PICKER = { openFlag: false, cache: {}, current: '', generation: 0 };

  function shortModel(ref) {
    return String(ref || '').split('/').pop() || '—';
  }

  async function paintChip() {
    const chip = $('c-model');
    if (!chip) return;
    const st = OB.st || (window.S && window.S.st);
    if (!st || !st.routes) return;
    const chat = (st.routes || []).find((r) => r.job === 'chat');
    PICKER.current = chat ? chat.ref : '';
    const configured = (st.providers || []).find(p => p.name === chat?.provider)?.ready;
    const prov = (st.providers || []).find((p) => p.name === chat?.provider);
    /* spec B: the chip states provider · model — never an ambiguous model name
       alone (OpenCode Go must not read as plain glm-x.x, never silently Zen). */
    const provName = prov?.label || prov?.displayName || prov?.preset || chat?.provider || '';
    chip.textContent = (PICKER.current
      ? `${provName} · ${shortModel(PICKER.current)}${configured ? '' : ' · Connect'}`
      : 'Choose a model') + ' ▾';
    chip.title = `${provName || 'provider'} — ${PICKER.current || 'no model set'}${configured ? '' : ' (connection required)'}`;
    chip.hidden = false;
    chip.setAttribute('aria-haspopup', 'dialog');
    chip.setAttribute('aria-expanded', String(PICKER.openFlag));
  }

  async function togglePicker() {
    const pane = $('modeldrop');
    if (!pane) return;
    PICKER.openFlag = !PICKER.openFlag;
    pane.hidden = !PICKER.openFlag;
    $('c-model').setAttribute('aria-expanded', String(PICKER.openFlag));
    const ticket = ++PICKER.generation;
    if (!PICKER.openFlag) return;
    pane.textContent = '';
    pane.tabIndex = -1;
    pane.setAttribute('aria-modal', 'true');
    // u08 (measured twice, windows-latest Aurora lane): an open dialog MUST honor Escape.
    pane.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); closePicker(); } };
    pane.focus();
    fillPicker(pane, ticket);
  }

  function closePicker() {
    PICKER.openFlag = false;
    PICKER.generation++;
    $('modeldrop').hidden = true;
    $('c-model').setAttribute('aria-expanded', 'false');
    $('c-model').focus();
  }

  async function fillPicker(pane, ticket) {
    const { normalizeCatalog, filterCatalog } = await import('/catalog.js');
    if (!PICKER.openFlag || ticket !== PICKER.generation) return;
    pane.textContent = '';
    pane.setAttribute('role', 'dialog');
    pane.setAttribute('aria-label', 'Choose a model');
    const head = el('div', 'explorer-head');
    const title = el('div', '', 'Choose your model');
    const close = el('button', 'explorer-close', '✕');
    close.setAttribute('aria-label', 'Close model picker');
    close.onclick = closePicker;
    head.append(title, close);
    const st = OB.st || window.S?.st;
    const providers = (st?.providers || []).filter((p) => p.kind !== 'mock').sort((a, b) => {
      // Keep Go easy to find; never silently replace the currently active model.
      const priority = (p) => p.name === 'opencode' ? 0 : p.name === 'opencodezen' ? 90 : 10;
      return priority(a) - priority(b);
    });
    const active = st?.routes?.find((r) => r.job === 'chat')?.provider;
    const provider = el('select', 'ob-input');
    provider.setAttribute('aria-label', 'Provider');
    for (const p of providers) {
      const option = el('option', '', p.label + (p.ready ? '' : ' · key needed'));
      option.value = p.name;
      provider.append(option);
    }
    provider.value = PICKER.preferred || active || providers[0]?.name || '';
    PICKER.preferred = null;
    const search = el('input', 'ob-input');
    search.placeholder = 'Search models or creators…';
    search.setAttribute('aria-label', 'Search models');
    const filters = el('div', 'explorer-filters');
    const free = el('button', 'filter-chip free-filter', 'Free only');
    free.setAttribute('aria-pressed', 'false');
    const sort = el('select', 'explorer-sort');
    sort.setAttribute('aria-label', 'Sort models');
    for (const [value, label] of [['name', 'Name A–Z'], ['price', 'Lowest input price'], ['context', 'Largest context']]) {
      const option = el('option', '', label); option.value = value; sort.append(option);
    }
    filters.append(free, sort);
    const capabilities = el('div', 'capability-filters');
    const capabilityState = { tools: false, vision: false, longContext: false };
    for (const [key, label] of [['tools', 'Tools'], ['vision', 'Vision'], ['longContext', '128k+ context']]) {
      const button = el('button', 'filter-chip', label);
      button.setAttribute('aria-pressed', 'false');
      button.onclick = () => { capabilityState[key] = !capabilityState[key]; button.setAttribute('aria-pressed', String(capabilityState[key])); limit = 60; paint(); };
      capabilities.append(button);
    }
    const msg = el('div', 'ob-msg explorer-count');
    msg.setAttribute('role', 'status');
    const list = el('div', 'ob-models md-list');
    const more = el('button', 'explorer-more', 'Show more models');
    const manage = el('button', 'ob-link explorer-manage', 'Manage providers →');
    manage.onclick = () => { closePicker(); window.MAJIN_ONBOARD.reopen(); };
    const manual = el('details', 'manual-model');
    manual.append(el('summary', '', 'Use an exact model ID'));
    const manualInput = el('input', 'ob-input');
    manualInput.placeholder = 'Exact provider model ID';
    manualInput.setAttribute('aria-label', 'Exact model ID');
    const manualGo = el('button', '', 'Use this ID');
    manual.append(el('p', 'ob-msg', 'For custom or unlisted models. Availability and price are unverified.'), manualInput, manualGo);
    const browser = el('div', 'explorer-browser');
    browser.append(provider, search, filters, capabilities, msg, list, more, manual, manage);
    pane.append(head, browser);
    let models = [], freeOnly = false, limit = 60, generation = 0, unverified = false;
    let selecting = false;
    const accept = async (id) => {
      if (selecting) return;
      selecting = true;
      msg.textContent = 'Saving and verifying model…';
      const name = provider.value;
      const routes = Object.fromEntries(ROUTE_JOBS.map((j) => [j, name + '/' + id]));
      try {
        const r = await apiLocal('/config', { method: 'PATCH', body: { models: { provider: name, routes }, moa: { policy: 'off' } } });
        if (!r?.ok) {
          msg.textContent = tellErr(r, 'Could not save this model. Try again.');
          return;
        }
        // A PATCH success only proves that one request was accepted. Read back
        // the actual ACTIVE routes before closing; another process or a stale
        // UI state may still be using a different provider/model.
        const fresh = await apiLocal('/state?tools=0');
        const { confirmSelectedModel } = await import('/model-confirm.js');
        const proof = confirmSelectedModel(fresh, name, id, ROUTE_JOBS);
        if (!proof.ok) {
          msg.textContent = proof.reason + (proof.missing.length ? ': ' + proof.missing.join(', ') : '') + '. Refresh or try again.';
          return;
        }
        OB.st = fresh;
        if (window.S) window.S.st = fresh;
        await paintChip();
        closePicker();
        if (typeof window.refresh === 'function') void window.refresh();
      } catch {
        msg.textContent = 'Model save was sent but could not be verified. Check the connection and retry.';
      } finally {
        selecting = false;
      }
    };
    manualGo.onclick = () => { const id = manualInput.value.trim(); if (id) accept(id); };
    function paint() {
      list.textContent = '';
      const hits = filterCatalog(models, { query: search.value, free: freeOnly, sort: sort.value, ...capabilityState });
      msg.textContent = hits.length + ' of ' + models.length + ' models' + (freeOnly ? ' · zero catalog charges' : unverified ? ' · unverified suggestions' : '');
      if (!hits.length) {
        const notice = el('div', 'explorer-empty');
        notice.append(el('p', '', freeOnly
          ? 'No models with independently verified zero per-token pricing for this provider. OpenCode Go may offer models through a plan, but that is not the same as a free API model.'
          : 'No models match these filters.'));
        if (freeOnly) {
          const showAll = el('button', 'explorer-show-all', 'Show OpenCode Go models');
          showAll.type = 'button';
          showAll.onclick = () => { freeOnly = false; free.setAttribute('aria-pressed', 'false'); limit = 60; paint(); };
          notice.append(showAll);
        }
        list.append(notice);
      }
      for (const m of hits.slice(0, limit)) {
        const row = el('button', 'ob-model' + (provider.value + '/' + m.id === PICKER.current ? ' on' : ''));
        row.type = 'button';
        row.setAttribute('aria-pressed', String(provider.value + '/' + m.id === PICKER.current));
        row.append(el('span', 'model-name', m.name), el('span', 'model-id', m.id));
        const bits = [m.free ? 'Free' : m.input == null || m.output == null ? 'Price unknown' : '$' + m.input.toFixed(2) + ' in / $' + m.output.toFixed(2) + ' out · 1M tokens', m.context ? Math.round(m.context / 1000) + 'k context' : '', m.tools ? 'Tools' : '', m.vision ? 'Vision' : ''].filter(Boolean);
        row.append(el('span', 'model-meta' + (m.free ? ' model-free' : ''), bits.join(' · ')));
        row.onclick = () => accept(m.id);
        const card = el('article', 'model-card');
        const inspect = el('button', 'model-inspect', 'ⓘ');
        inspect.type = 'button';
        inspect.setAttribute('aria-label', 'Inspect ' + m.name);
        inspect.onclick = () => inspectModel(m, inspect);
        card.append(row, inspect); list.append(card);
      }
      more.hidden = hits.length <= limit;
    }
    function inspectModel(m, origin) {
      const details = el('section', 'model-detail');
      const back = el('button', 'model-detail-back', '← Back to models');
      back.onclick = () => { details.remove(); browser.hidden = false; title.textContent = 'Choose your model'; origin.focus(); };
      const price = (n) => n == null ? 'Unknown' : '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 6 });
      details.append(back, el('h3', '', m.name), el('span', 'model-id', m.id));
      const facts = el('dl', 'studio-facts');
      for (const [label, value] of [['Input / 1M tokens', price(m.input)], ['Output / 1M tokens', price(m.output)], ['Context window', m.context ? Number(m.context).toLocaleString() + ' tokens' : 'Unknown'], ['Tools', m.tools ? 'Supported' : 'Not reported'], ['Vision', m.vision ? 'Supported' : 'Not reported'], ['Zero catalog charges', m.free ? 'Verified in catalog' : 'Not established']]) facts.append(el('dt', '', label), el('dd', '', value));
      details.append(facts, el('p', '', 'Catalog listing does not verify account access or quota. Additional charges may apply unless all reported prices are zero.'));
      const use = el('button', 'model-detail-use', 'Use this model'); use.onclick = () => accept(m.id);
      details.append(use); browser.hidden = true; title.textContent = 'Model information'; pane.append(details); back.focus();
    }
    async function load() {
      const turn = ++generation, name = provider.value;
      models = []; list.textContent = ''; more.hidden = true;
      msg.textContent = 'Loading live catalog…';
      const result = await apiLocal('/models?provider=' + encodeURIComponent(name)).catch(() => null);
      if (turn !== generation) return;
      if (!result?.ok) {
        msg.textContent = tellErr(result, 'Could not load catalog. Check the provider connection.');
        const retry = el('button', '', 'Retry catalog'); retry.onclick = load; list.append(retry);
        return;
      }
      unverified = Boolean(result.note);
      models = result.catalog || normalizeCatalog({ models: result.models });
      limit = 60; paint();
    }
    provider.onchange = load;
    search.oninput = () => { limit = 60; paint(); };
    sort.onchange = () => { limit = 60; paint(); };
    free.onclick = () => { freeOnly = !freeOnly; free.setAttribute('aria-pressed', String(freeOnly)); limit = 60; paint(); };
    more.onclick = () => { limit += 60; paint(); };
    pane.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closePicker(); }
      if (e.key === 'Tab') {
        const nodes = [...pane.querySelectorAll('button, input, select')].filter((n) => !n.hidden && !n.disabled && n.getClientRects().length);
        const first = nodes[0], last = nodes.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    search.focus(); load();
  }
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || !PICKER.openFlag) return;
    if (e.key === 'Escape') { e.preventDefault(); closePicker(); }
    if (e.key === 'Tab') {
      const pane = $('modeldrop');
      const nodes = [...pane.querySelectorAll('button,input,select,summary,a[href]')].filter(n => !n.disabled && n.getClientRects().length);
      if (!nodes.length) e.preventDefault();
      else if (!pane.contains(document.activeElement)) { e.preventDefault(); nodes[0].focus(); }
      else if (e.shiftKey && document.activeElement === nodes[0]) { e.preventDefault(); nodes.at(-1).focus(); }
      else if (!e.shiftKey && document.activeElement === nodes.at(-1)) { e.preventDefault(); nodes[0].focus(); }
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (PICKER.openFlag && !$('modeldrop').contains(e.target) && !$('c-model').contains(e.target)) closePicker();
  });

  window.MAJIN_ONBOARD = {
    reopen() {
      const st = (window.S && window.S.st) || OB.st;
      if (st) open(st);
    },
    maybe(st) {
      OB.st = st;
      if (OB.shown) return;
      /* a dismissed wizard must not trap the user: Skip for now suppresses
         the auto-open for THIS session only — it always comes back on a
         fresh start (or via the providers link) */
      if (st && st.needsSetup && !sessionStorage.getItem('majin.onboard.skip')) open(st);
      else paintChip();
    },
    togglePicker,
    paintChip,
    api: apiLocal,
  };
})();
