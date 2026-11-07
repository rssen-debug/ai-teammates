/* MAJIN — right panel + rail rows. Called from app.js (shared classic-script scope). */
async function paintHeader(st) {
  const ui = st.config.ui || {};
  document.title = (ui.title || st.name || 'MAJIN') + ' · agent';
  $('brand').textContent = (ui.title || st.name || 'MAJIN').toUpperCase();
  // Always show the version reported by the running backend, not the
  // requested download version. Useful after an interrupted update.
  const versionBadge = $('v-tag');
  if (versionBadge) {
    versionBadge.textContent = st.version ? 'v' + String(st.version).replace(/^v/, '') : 'Version unknown';
    versionBadge.title = 'Installed and running MAJIN version: ' + (st.version || 'unknown');
  }
  $('tagline').textContent = ui.tagline || '';
  $('c-tools').innerHTML = 'tools <b>' + (st.tools.count || (st.tools || []).length) + '</b>';
  $('c-moa').innerHTML = 'MOA <b>' + (st.moa.policy === 'off' ? 'off' : st.moa.width + '→' + String(st.moa.aggregator || '').split('/').pop()) + '</b>';
  $('c-moa').classList.toggle('live', st.moa.policy !== 'off');
  const u = st.usage || {};
  $('c-cost').innerHTML = '$<b>' + (u.costUsd != null ? Number(u.costUsd).toFixed(2) : '0') + '</b>' + (u.budgetUsd ? '/' + u.budgetUsd : '') + '<span class="kv"> · ' + (u.requests || 0) + ' calls</span>';
  const tg = st.channels.telegram || {};
  const wa = st.channels.whatsapp || {};
  led('led-tg', tg.online ? 'g' : tg.state === 'pairing' || tg.state === 'no-token' ? 'y' : tg.state === 'error' ? 'r' : '');
  led('led-wa', wa.online ? 'g' : wa.state === 'pairing' ? 'y' : wa.state === 'missing-dep' || wa.state === 'error' ? 'r' : '');
  $('c-tg').title = 'telegram: ' + (tg.state || '?') + (tg.lastError ? ' · ' + tg.lastError : '') + (tg.pairingCode ? ' · code ' + tg.pairingCode : '');
  $('c-wa').title = 'whatsapp: ' + (wa.state || '?') + (wa.transport ? ' · ' + wa.transport : '') + (wa.lastError ? ' · ' + wa.lastError : '');
  const cu = $('c-update');
  if (cu) {
    const configUpdate = st.config?.updates || {};
    const enabled = configUpdate.check !== false;
    // The CLI and the UI share persisted version metadata, but the old UI
    // ignored this cache until its delayed background check completed.
    const semver = (value) => {
      const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value || '').replace(/^v/, ''));
      return match ? { parts: match.slice(1, 4).map(Number), prerelease: match[4] || null } : null;
    };
    const isNewer = (latest, installed) => {
      const a = semver(latest), b = semver(installed);
      if (!a || !b) return false;
      for (let i = 0; i < 3; i++) {
        if (a.parts[i] !== b.parts[i]) return a.parts[i] > b.parts[i];
      }
      // A final release supersedes the corresponding prerelease.
      if (!a.prerelease) return Boolean(b.prerelease);
      if (!b.prerelease) return false;
      const ap = a.prerelease.split('.'), bp = b.prerelease.split('.');
      for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
        if (i >= ap.length) return false;
        if (i >= bp.length) return true;
        const x = ap[i], y = bp[i];
        if (x === y) continue;
        const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
        if (nx && ny) return BigInt(x) > BigInt(y);
        if (nx !== ny) return !nx;
        return x > y;
      }
      return false;
    };
    const state = st.update || {};
    const latest = String(state.latest || configUpdate.latest || '').replace(/^v/, '');
    const available = enabled && isNewer(latest, st.version);
    const releaseUrl = String(state.url || configUpdate.url || 'https://github.com/rssen-debug/MAJINCLI/releases/latest');
    // A permanently visible Check updates action avoids a catch-22 where
    // people must leave the app for CMD because a check was slow/offline.
    cu.hidden = !enabled;
    if (!enabled) {
      cu.onclick = null;
      cu.dataset.arm = '';
    } else if (!cu.dataset.installing) {
      const target = available ? latest : '';
      if (cu.dataset.target !== target) {
        cu.dataset.arm = '';
        cu.dataset.target = target;
      }
      cu.disabled = false;
      cu.innerHTML = available
        ? (cu.dataset.arm ? 'Install <b>' + latest + '</b>?' : 'Update <b>' + latest + '</b>')
        : 'Check updates';
      cu.title = available
        ? 'MAJIN ' + latest + ' is available. Click twice to confirm installation.'
        : (state.error ? 'Last check failed: ' + state.error + '. Click to retry.' : 'Check for MAJIN updates now');
      cu.setAttribute('aria-label', available ? 'Update MAJIN to ' + latest : 'Check for MAJIN updates');
      cu.onclick = async () => {
        if (cu.dataset.installing) return;
        if (!available) {
          cu.disabled = true;
          cu.textContent = 'Checking…';
          try {
            const reply = await api('/update', { method: 'POST', body: { action: 'check', force: true } });
            if (reply?.error) throw new Error(typeof reply.error === 'object' ? reply.error.message : reply.error);
          } catch (error) {
            note('Could not check for updates: ' + String(error?.message || error).slice(0, 140));
          } finally {
            cu.disabled = false;
            await window.refresh?.(true);
          }
          return;
        }
        if (!cu.dataset.arm) {
          cu.dataset.arm = '1';
          cu.innerHTML = 'Install <b>' + latest + '</b>?';
          cu.title = 'Click again to confirm: MAJIN will install the verified Windows update and restart.';
          return;
        }
        cu.dataset.arm = '';
        cu.dataset.installing = '1';
        cu.disabled = true;
        cu.innerHTML = 'Installing <b>' + latest + '</b>…';
        try {
          const reply = await api('/update', { method: 'POST', body: { action: 'install' } });
          if (reply?.ok) {
            note('Installing MAJIN ' + latest + '. The app will restart; your data remains in its existing location.');
            cu.innerHTML = 'Restarting…';
          } else if (reply?.error === 'windows_only') {
            window.open(reply.releaseUrl || releaseUrl, '_blank', 'noopener');
            note('The installer is Windows-only. Opened the release page.');
            cu.dataset.installing = '';
            cu.disabled = false;
          } else {
            throw new Error(typeof reply?.error === 'object' ? reply.error.message : (reply?.error || 'Installer could not start'));
          }
        } catch (error) {
          cu.dataset.installing = '';
          cu.disabled = false;
          cu.textContent = 'Update failed · Retry';
          note('Update failed: ' + String(error?.message || error).slice(0, 140) + '. Download the installer from ' + releaseUrl);
        }
      };
    }
  }

  const mode = ({ strict: 'assist', confirm: 'approval', off: 'full auto' })[st.guard.mode] || 'approval';
  const bm = $('b-mode');
  if (bm) {
    bm.textContent = mode;
    bm.title = 'Permission mode: ' + mode + ' (guard.mode=' + st.guard.mode + ')';
  }

}

function led(id, cls) {
  const n = $(id);
  if (!n) return;
  n.className = 'led' + (cls ? ' ' + cls : '');
}

async function paintRail(st) {
  /* P0 repair: MAJIN_CHATS (src/ui/chats.js) owns the conversation list with
     durable server-side index (rename/archive/delete/activity-sort). This rail
     hook only keeps studio filters + the non-chat subsections in sync. */
  if (window.MAJIN_CHATS) window.MAJIN_CHATS.render();
  if (window.MAJIN_STUDIO) window.MAJIN_STUDIO.filterChats();
  if (st.schedule && st.schedule.length) {
    $('sched').innerHTML = st.schedule
      .map((j) => `<div><b>${esc(j.name || j.id)}</b> · ${esc(j.when || '')}<br><span class="kv">next ${esc(j.nextRunHuman || '')}${j.paused ? ' · paused' : ''}${j.lastStatus ? ' · ' + esc(j.lastStatus) : ''}</span></div>`)
      .join('');
  } else $('sched').textContent = 'no jobs';
  const mem = st.memory || {};
  $('mem').innerHTML = `<b>${mem.facts ?? mem.count ?? 0}</b> facts · <b>${mem.events ?? mem.eventCount ?? 0}</b> events${mem.file ? '<br><span class="kv">' + esc(String(mem.file).split(/[\\/]/).pop()) + '</span>' : ''}<br><span class="kv">${(st.skills || []).length} skills${(st.skills || []).length ? ': ' + esc((st.skills || []).slice(0, 3).map((k) => k.name).join(', ')) : ''}</span>`;
}

function renderPlan(plan) {
  const box = $('plan');
  if (!box) return;
  if (!plan) {
    box.innerHTML = '<div>–</div>';
    return;
  }
  box.innerHTML = plan
    .map((p) => `<div class="${esc(p.status || '')}">${p.status === 'done' ? '✔' : p.status === 'doing' ? '▸' : p.status === 'blocked' ? '✕' : '○'} ${esc(p.text)}</div>`)
    .join('');
}

/* Permission modes: Assist = asks for every write/exec, Approval (default) = only
   destructive and shell work, Full auto = never asks. */
const GUARD_MODES = [
  ['assist', 'strict', 'Asks before every write, exec and deletion.'],
  ['approval', 'confirm', 'Asks only before destructive or shell actions.'],
  ['full auto', 'off', 'Never asks. The agent runs every tool directly.'],
];

async function paintPanel(st) {
  /* ---- routing ---- */
  const options = (st.providers || []).flatMap((p) => (p.models || []).map((m) => `${p.name}/${m}`));
  const r = $('routes');
  r.innerHTML = '';
  for (const row of st.routes || []) {
    const div = el('div', 'row');
    div.append(el('span', '', row.job));
    const sel = el('select');
    sel.innerHTML = ['<option value="">—</option>']
      .concat(options.map((o) => `<option ${o === row.ref ? 'selected' : ''}>${esc(o)}</option>`))
      .join('');
    if (!options.includes(row.ref) && row.ref) sel.innerHTML += `<option selected>${esc(row.ref)}</option>`;
    sel.onchange = () => setConfig({ models: { routes: { [row.job]: sel.value } } }, row.job + ' → ' + sel.value);
    div.append(sel);
    if (!row.ready) div.append(el('span', 'kv', '⚠ no key'));
    r.append(div);
  }

  /* ---- MOA (always on by design) ---- */
  const m = $('moactl');
  m.innerHTML = '';
  const pol = el('div', 'row');
  pol.append(el('span', '', 'policy'));
  ['always', 'hard', 'off'].forEach((p) => {
    const b = el('button', st.moa.policy === p ? 'on' : '', p);
    b.onclick = () => setConfig({ moa: { policy: p, enabled: p !== 'off' } }, 'MOA ' + p);
    pol.append(b);
  });
  m.append(pol);
  const w = el('div', 'row');
  w.append(el('span', '', 'width'));
  for (let i = 2; i <= 5; i += 1) {
    const b = el('button', st.moa.width === i ? 'on' : '', String(i));
    b.onclick = () => setConfig({ moa: { width: i } }, 'MOA width ' + i);
    w.append(b);
  }
  m.append(w);
  m.append(el('div', 'kv', 'references: ' + (st.moa.refs || []).map((x) => String(x).split('/').pop()).join(', ') + '<br>aggregator: <b>' + esc(String(st.moa.aggregator || '').split('/').pop()) + '</b>'));

  /* ---- permissions ---- */
  const g = $('guardctl');
  g.innerHTML = '';
  const gr = el('div', 'row');
  gr.append(el('span', '', 'mode'));
  GUARD_MODES.forEach(([label, mode, hint]) => {
    const b = el('button', st.guard.mode === mode ? 'on' : '', label);
    b.title = hint;
    b.onclick = () => setConfig({ guard: { mode } }, 'permission mode → ' + label);
    gr.append(b);
  });
  g.append(gr);
  if (st.guard.pending) g.append(el('div', 'row', '<span class="kv" style="color:var(--warn)">' + st.guard.pending + ' waiting for you</span>'));
  const scope = el('div', 'row');
  const protectedBox = el('input');
  protectedBox.placeholder = 'never touch (path or /regex/)';
  protectedBox.style.flex = '1';
  const saveScope = el('button', '', 'scope');
  saveScope.title = 'Adds a pattern to guard.protectedPaths — tools refuse these even in full auto.';
  saveScope.onclick = () => {
    const v = protectedBox.value.trim();
    if (!v) return note('give me a path or pattern first');
    const cur = (st.config.guard && st.config.guard.protectedPaths) || [];
    setConfig({ guard: { protectedPaths: [...cur, v] } }, 'protected: ' + v);
    protectedBox.value = '';
  };
  scope.append(protectedBox, saveScope);
  g.append(scope);
  const cap = el('div', 'row');
  cap.append(el('span', '', 'spend'));
  const capInput = el('input');
  capInput.type = 'number';
  capInput.step = '1';
  capInput.min = '0';
  capInput.value = st.config.budget?.monthlyUsd ?? 0;
  capInput.style.width = '70px';
  capInput.title = 'Monthly budget in USD. 0 = no cap. The agent pauses and tells you when it is hit.';
  const capGo = el('button', '', 'set');
  capGo.onclick = () => {
    const n = Number(capInput.value) || 0;
    setConfig({ budget: { mode: n > 0 ? 'cap' : 'off', monthlyUsd: n } }, n > 0 ? 'budget ' + n + ' USD/month' : 'budget off');
  };
  cap.append(capInput, capGo);
  const stopAll = el('button', 'danger', 'stop everything');
  stopAll.title = 'Aborts the running task and clears the approval queue.';
  stopAll.onclick = async () => {
    await api('/chat/stop', { method: 'POST', body: {} }).catch(() => {});
    note('emergency stop sent');
  };
  cap.append(stopAll);
  g.append(cap);
  g.append(el('div', 'kv', (st.guard.recent || []).slice(-3).map((a) => `${a.tool} ${a.approved ? '✔' : '✕'}`).join(' · ') || 'no decisions yet'));

  /* ---- providers ---- */
  const pr = $('providers');
  pr.innerHTML = '';
  for (const p of st.providers || []) {
    const row = el('div', 'row');
    row.append(el('span', '', (p.ready ? '🟢 ' : '⚪ ') + p.name));
    const test = el('button', '', 'test');
    test.onclick = async () => {
      setStatus('testing ' + p.name + '…');
      const res = await api('/provider/test', { method: 'POST', body: { provider: p.name, ref: `${p.name}/${(p.models || [''])[0]}` } }).catch((e) => ({ ok: false, error: e.message }));
      toast(`${p.name}: ${res.ok ? 'ok ' + res.ms + 'ms' : 'failed — ' + (res.error || '') + (res.hint ? ' · ' + res.hint : '')}`);
      setStatus('ready');
    };
    const use = el('button', '', 'use');
    use.onclick = () => {
      const routes = {};
      for (const row2 of st.routes || []) routes[row2.job] = `${p.name}/${(p.models || [''])[0]}`;
      setConfig({ models: { provider: p.name, routes } }, 'everything → ' + p.name);
    };
    row.append(test, use);
    if ((p.models || []).length) row.append(el('span', 'kv', p.models.slice(0, 3).join(',')));
    pr.append(row);
  }
  const add = el('div', 'row');
  const presets = (st.presets || []).length ? st.presets : [{ name: 'deepseek', label: 'DeepSeek', needsKey: true }];
  const preset = el('select');
  preset.innerHTML = presets.map((x) => `<option value="${x.name}">${x.label}</option>`).join('');
  preset.title = 'Who runs the model. Every one of these is built in - pick it, paste a key, done. No files to edit.';
  const key = el('input');
  key.type = 'password';
  key.placeholder = 'paste the key';
  key.style.flex = '1';
  const url = el('input');
  url.placeholder = 'address - only for your own server';
  url.style.flex = '1';
  url.title = 'Leave empty for the big providers. For Ollama, LM Studio or a machine on your network, type the address here (e.g. http://192.168.0.9:11434/v1).';
  const get = el('a', 'kv', 'get a key \u2197');
  get.target = '_blank';
  get.rel = 'noopener';
  get.style.cssText = 'color:var(--cy);text-decoration:none;white-space:nowrap';
  const go = el('button', '', 'save');
  go.title = 'Saves the key and points every route at this provider. Nothing else to configure.';
  const pick = () => presets.find((x) => x.name === preset.value) || {};
  const sync = () => {
    const p = pick();
    get.href = p.keyUrl || '#';
    get.style.display = p.keyUrl ? '' : 'none';
    key.placeholder = p.needsKey === false ? 'no key needed here' : 'paste the key';
  };
  preset.onchange = sync;
  sync();
  go.onclick = async () => {
    const p = pick();
    if (p.needsKey !== false && !key.value.trim() && !url.value.trim()) {
      err('paste the key first - ' + p.label + ' needs one. ' + (p.keyUrl ? 'The "get a key" link opens the page where you make it.' : 'Or point at your own server in the address box.'));
      key.focus();
      return;
    }
    setStatus('saving provider\u2026');
    try {
      const body = { preset: preset.value, apiKey: key.value.trim() || undefined };
      if (url.value.trim()) body.baseUrl = url.value.trim();
      const r2 = await api('/provider', { method: 'POST', body });
      if (!r2 || r2.ok === false) throw new Error([r2 && r2.error, r2 && r2.hint].filter(Boolean).join(' - ') || 'the provider was not saved');
      const routes = {};
      const st2 = await api('/state?tools=0');
      for (const row2 of st2.routes || []) routes[row2.job] = `${r2.provider}/${(r2.status?.models || [''])[0]}`;
      await api('/config', { method: 'PATCH', body: { models: { provider: r2.provider, routes } } });
      toast(p.needsKey === false ? `${p.label} saved - press test on its row to check that it answers` : `${p.label} saved. Say something and I will answer for real.`);
      refresh();
    } catch (e) {
      err(e.message);
    }
    setStatus('ready');
  };
  add.append(preset, key, url, get, go);
  pr.append(add);
  pr.append(el('div', 'kv', 'No config files anywhere: pick a provider, paste the key, press save. The address box is only for your own machine (Ollama, LM Studio, a box on the network).'));

  /* ---- channels ---- */
  const c = $('chan');
  c.innerHTML = '';
  const tg = st.channels.telegram || {};
  const trow = el('div', 'row');
  trow.append(el('span', '', 'telegram'));
  const tkey = el('input');
  tkey.placeholder = '123456:ABC-DEF…';
  tkey.style.flex = '1';
  tkey.value = '';
  const tsave = el('button', '', 'save+start');
  tsave.onclick = async () => {
    const r2 = await api('/channels/telegram', { method: 'POST', body: { botToken: tkey.value.trim(), action: 'start' } }).catch((e) => ({ ok: false, error: e.message }));
    toast(r2.ok ? 'telegram running · code ' + (r2.pairingCode || '-') : 'telegram: ' + (r2.error || r2.status?.lastError || 'failed'));
    refresh();
  };
  const tstop = el('button', 'danger', 'stop');
  tstop.onclick = async () => {
    await api('/channels/telegram', { method: 'POST', body: { action: 'stop' } }).catch(() => {});
    refresh();
  };
  trow.append(tkey, tsave, tstop);
  c.append(trow);
  c.append(el('div', 'kv', tg.state === 'polling' ? `polling as <b>${esc(tg.bot || '')}</b> · ${tg.chats || 0} chats · in ${tg.received || 0}/out ${tg.sent || 0}<br>pairing code <b>${esc(tg.pairingCode || '-')}</b> — the user sends <i>/pair code</i> to the bot` : 'status: ' + (tg.state || 'off') + (tg.lastError ? ' · ' + esc(tg.lastError) : '')));
  if (st.channels.whatsapp) {
    const wa = st.channels.whatsapp || {};
    const wrow = el('div', 'row');
    wrow.append(el('span', '', 'whatsapp'));
    const tr = el('select');
    tr.innerHTML = ['baileys', 'cloud'].map((x) => `<option ${wa.transport === x ? 'selected' : ''}>${x}</option>`).join('');
    const start = el('button', '', wa.online ? 'restart' : 'start');
    start.onclick = async () => {
      const r2 = await api('/channels/whatsapp', { method: 'POST', body: { transport: tr.value, action: 'start' } }).catch((e) => ({ ok: false, error: e.message }));
      toast(r2.ok ? 'whatsapp: ' + (r2.status?.state || 'running') : 'whatsapp: ' + (r2.error || 'failed') + (r2.status?.hint ? ' · ' + r2.status.hint : ''));
      refresh();
    };
    const stop = el('button', 'danger', 'stop');
    stop.onclick = async () => {
      await api('/channels/whatsapp', { method: 'POST', body: { action: 'stop' } }).catch(() => {});
      refresh();
    };
    wrow.append(tr, start, stop);
    c.append(wrow);
    c.append(el('div', 'kv', 'transport <b>' + esc(wa.transport || '?') + '</b> · ' + esc(wa.state || 'off') + (wa.linked ? ' · ' + esc(wa.linked) : '') + (wa.lastError ? '<br>' + esc(wa.lastError) : '')));
    if (wa.qr) {
      const img = el('img');
      img.src = wa.qr;
      img.style.cssText = 'width:168px;height:168px;background:#fff;padding:6px;border-radius:8px;margin-top:6px';
      c.append(img);
      c.append(el('div', 'kv', 'WhatsApp → Settings → Linked devices'));
    }
  }

  /* ---- cost ---- */
  const u = st.usage || {};
  const days = u.days || {};
  const keys = Object.keys(days).sort();
  const max = Math.max(0.0001, ...keys.map((k) => days[k]));
  const spark = el('div', 'spark');
  for (let d = 1; d <= 28; d += 1) {
    const k = String(d).padStart(2, '0');
    const i = el('i');
    i.style.height = days[k] ? Math.max(3, (days[k] / max) * 26) + 'px' : '2px';
    i.title = k + ': ' + (days[k] || 0) + ' USD';
    spark.append(i);
  }
  $('usage').innerHTML = '';
  $('usage').append(el('div', '', '<b>' + (u.costUsd || 0).toFixed(4) + '</b> USD · ' + (u.tokens || 0) + ' tok · ' + (u.requests || 0) + ' calls' + (u.budgetUsed != null ? ' · budget ' + Math.round(u.budgetUsed * 100) + '%' : '')), spark);
  const by = Object.entries(u.byModel || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (by.length) $('usage').append(el('div', 'kv', by.map(([k, v]) => `${esc(k.split('/').pop())} $${Number(v).toFixed(3)}`).join(' · ')));
  const bj = Object.entries(u.byJob || {}).filter(([, v]) => v > 0);
  if (bj.length) $('usage').append(el('div', 'kv', bj.map(([k, v]) => `${esc(k)} $${Number(v).toFixed(3)}`).join(' · ')));
}

async function setConfig(patch, msg) {
  setStatus('saving…');
  try {
    const r = await api('/config', { method: 'PATCH', body: patch });
    if (!r.ok) err('config: ' + (r.errors || []).map((e) => e.path + ': ' + e.msg).join(', '));
    else if (msg) note(msg);
    refresh();
  } catch (e) {
    err(e.message);
  }
  setStatus('ready');
}

window.paintPanel = paintPanel;
window.paintHeader = paintHeader;
window.paintRail = paintRail;
window.renderPlan = renderPlan;
window.setConfig = setConfig;
