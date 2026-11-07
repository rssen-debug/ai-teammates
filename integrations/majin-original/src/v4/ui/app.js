/**
 * MAJIN V4 — client.
 *
 * The browser is a thin, honest client: it renders what the server proves and
 * never claims a task succeeded on its own. iOS voice uses foreground capture
 * and host-local STT; other browsers retain Web Speech with recording fallback.
 */
import { createSpirit } from '/spirit.js?v=15';
import { detectVoiceSupport, recognitionLang, shouldAutoSend, speechText, voiceErrorMessage, playNarratorStream } from '/voice.js?v=15';
import { t } from '/strings.js?v=15';
import { INITIAL, applyEvent, createSseParser } from '/session.js?v=15';
import { VoiceCapture } from '/recorder.js?v=15';

const $ = (sel) => document.querySelector(sel);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const lowPower = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 4) <= 2;
let refreshHeartbeatSettings = () => {};

const els = {
  stage: $('#stage'),
  hero: $('#hero'),
  thread: $('#thread'),
  input: $('#input'),
  composer: $('#composer'),
  send: $('#send-btn'),
  stop: $('#stop-btn'),
  mic: $('#mic-btn'),
  attach: $('#attach-btn'),
  fileInput: $('#file-input'),
  lightbox: $('#lightbox'),
  lightboxImg: $('#lightbox-img'),
  lightboxX: $('#lightbox-x'),
  hint: $('#composer-hint'),
  gate: $('#gate'),
  gateForm: $('#gate-form'),
  gateCode: $('#gate-code'),
  gateError: $('#gate-error'),
  gateSubmit: $('#gate-submit'),
  modelPill: $('#model-pill'),
  modelLabel: $('#model-label'),
  connDot: $('#conn-dot'),
  menu: $('#menu-btn'),
  sheet: $('#sheet'),
  sheetBackdrop: $('#sheet-backdrop'),
  sheetModel: $('#sheet-model'),
  sheetModelNote: $('#sheet-model-note'),
  modelList: $('#model-list'),
  modelSearch: $('#model-search'),
  modelIncluded: $('#model-included'),
  modelSource: $('#model-source'),
  refreshModels: $('#refresh-models'),
  sheetFiles: $('#file-list'),
  sheetGoals: $('#goal-list'),
  ownerState: $('#owner-state'),
  ownerNote: $('#owner-note'),
  laneList: $('#lane-list'),
  folderInput: $('#folder-input'),
  folderAdd: $('#folder-add'),
  folderList: $('#folder-list'),
  ownerRevoke: $('#owner-revoke'),
  approvalState: $('#approval-state'),
  approvalNote: $('#approval-note'),
  approvalAuto: $('#approval-auto'),
  approvalWarning: $('#approval-warning'),
  skillList: $('#skill-list'),
  ttsToggle: $('#tts-toggle'),
  autosendToggle: $('#autosend-toggle'),
  voiceNote: $('#voice-note'),
  versionNote: $('#version-note'),
  offline: $('#offline-bar'),
  toast: $('#toast'),
  approval: $('#approval'),
  approvalText: $('#approval-text'),
  approvalAllow: $('#approval-allow'),
  approvalDeny: $('#approval-deny'),
  approvalDismiss: $('#approval-dismiss'),
  heroTitle: $('#hero-title'),
  newChat: $('#new-chat'),
  logout: $('#logout'),
  historyBtn: $('#history-btn'),
  historySettings: $('#history-settings'),
  history: $('#history'),
  historyBackdrop: $('#history-backdrop'),
  historyClose: $('#history-close'),
  historyQuery: $('#history-query'),
  historyList: $('#history-list'),
  historyEmpty: $('#history-empty'),
  historyTabActive: $('#history-tab-active'),
  historyTabArchived: $('#history-tab-archived'),
  importHistory: $('#import-history'),
  learnedList: $('#learned-list'),
  learnedNote: $('#learned-note'),
  importNote: $('#import-note'),
  dialogBackdrop: $('#dialog-backdrop'),
  renameDialog: $('#rename-dialog'),
  renameForm: $('#rename-form'),
  renameInput: $('#rename-input'),
  renameCancel: $('#rename-cancel'),
  confirmDialog: $('#confirm-dialog'),
  confirmTitle: $('#confirm-title'),
  confirmCopy: $('#confirm-copy'),
  confirmCancel: $('#confirm-cancel'),
  confirmDelete: $('#confirm-delete'),
};

const state = {
  conversationId: null,
  modelId: null,
  modelCatalogue: null,
  modelSelectionVersion: 0,
  streaming: false,
  controller: null,
  model: null,
  tts: false,
  autosend: true,
  listening: false,
  recognition: null,
  pendingApproval: null,
  started: false,
  bubble: null,
  bubbleText: '',
  version: null,
  capabilities: null,
  requestSeq: 0,
  previewOn: true,
  session: { ...INITIAL },
  // Conversation management: the list the drawer renders, the view it shows,
  // and the sync cursor that makes two devices converge without re-sending the
  // whole history on every poll.
  conversations: [],
  historyView: 'active',
  historyQuery: '',
  historyOpen: false,
  syncCursor: null,
  conversationVersion: 0,
  syncTimer: null,
  remoteBusy: false,
};

const spirit = createSpirit($('#spirit'), { reducedMotion, lowPower });
spirit.set('idle');

/* --------------------------------------------------------------- helpers -- */

function toast(message, ms = 2600) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    els.toast.hidden = true;
  }, ms);
}

function setDot(mode) {
  els.connDot.dataset.state = mode;
}

function api(path, { method = 'GET', body = null, signal = null } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== null) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-majin-csrf'] = '1';
  return fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === null ? undefined : JSON.stringify(body),
    signal,
  });
}

/** Minimal, safe markdown: **bold**, `code`, paragraphs. No HTML injection. */
function renderRich(container, text) {
  container.textContent = '';
  const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      const b = document.createElement('strong');
      b.textContent = part.slice(2, -2);
      container.append(b);
    } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      const c = document.createElement('code');
      c.textContent = part.slice(1, -1);
      container.append(c);
    } else {
      container.append(document.createTextNode(part));
    }
  }
}

function timeLabel(at = null) {
  const when = at ? new Date(at) : new Date();
  return (Number.isNaN(when.getTime()) ? new Date() : when)
    .toLocaleTimeString(document.documentElement.lang || 'sv-SE', { hour: '2-digit', minute: '2-digit' });
}

function scrollDown(force = false) {
  const nearBottom = els.stage.scrollHeight - els.stage.scrollTop - els.stage.clientHeight < 160;
  if (force || nearBottom) els.stage.scrollTop = els.stage.scrollHeight;
}

function setHero(visible) {
  els.hero.hidden = !visible;
  if (!visible) els.hero.classList.add('is-compact');
  document.getElementById('topbar')?.setAttribute('data-conversation', String(!visible || Boolean(state.conversationId)));
}

function resizeInput() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 132)}px`;
  els.send.disabled = !els.input.value.trim() || state.streaming;
}

/* -------------------------------------------------------- owner mode -- */

const laneLabel = (lane) => t(`owner.lane.${lane}`);

/** Load and render what the owner has currently granted. */
async function loadOwnerMode() {
  try {
    const res = await api('/api/owner-mode');
    if (!res.ok) return;
    const data = await res.json();
    renderOwnerMode(data.ownerMode);
  } catch { /* the sheet is not critical path */ }
}

function renderOwnerMode(view) {
  if (!view) return;
  const active = new Set(view.lanes || []);
  els.ownerState.textContent = active.size ? t('owner.on', { n: active.size }) : t('owner.off');
  els.ownerNote.textContent = view.note || t('owner.note');

  els.laneList.textContent = '';
  for (const lane of view.grantable || []) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lane-item';
    btn.dataset.on = active.has(lane) ? 'true' : 'false';
    const name = document.createElement('span');
    name.textContent = laneLabel(lane);
    const state = document.createElement('span');
    state.className = 'lane-state';
    state.textContent = active.has(lane) ? t('owner.granted') : t('owner.grant');
    btn.append(name, state);
    btn.addEventListener('click', () => toggleLane(lane, !active.has(lane)));
    li.append(btn);
    els.laneList.append(li);
  }

  els.folderList.textContent = '';
  const folders = view.folders || [];
  if (!folders.length) {
    const li = document.createElement('li');
    li.className = 'folder-empty';
    li.textContent = t('owner.noFolders');
    els.folderList.append(li);
  }
  for (const folder of folders) {
    const li = document.createElement('li');
    li.className = 'folder-item';
    const label = document.createElement('span');
    label.textContent = folder;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'folder-x';
    remove.textContent = '×';
    remove.setAttribute('aria-label', t('owner.removeFolder', { folder }));
    remove.addEventListener('click', () => postOwner({ action: 'revoke', folders: [folder] }));
    li.append(label, remove);
    els.folderList.append(li);
  }

  els.ownerRevoke.hidden = active.size === 0;
}

async function postOwner(body) {
  try {
    const res = await api('/api/owner-mode', { method: 'POST', body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    renderOwnerMode(data.ownerMode);
    await loadSkills();
    await loadCapabilities();
    return data;
  } catch (err) {
    toast(err.message || t('msg.genericError'));
    return null;
  }
}

async function toggleLane(lane, on) {
  if (on) {
    const data = await postOwner({ action: 'grant', lanes: [lane] });
    if (data) toast(`${laneLabel(lane)}: ${t('owner.granted')}`);
  } else {
    await postOwner({ action: 'revoke', lanes: [lane] });
  }
}

async function addFolder() {
  const raw = els.folderInput.value.trim();
  if (!raw) return;
  const data = await postOwner({ action: 'grant', folders: [raw] });
  if (data) {
    els.folderInput.value = '';
    toast(t('owner.folderAdded'));
  }
}

/** What MAJIN can do right now, per lane. Shown so a missing tool is visible. */
async function loadCapabilities() {
  try {
    const res = await api('/api/capabilities');
    if (!res.ok) return;
    const data = await res.json();
    state.capabilities = data;
  } catch { /* informative only */ }
}

async function loadSkills() {
  try {
    const res = await api('/api/skills');
    if (!res.ok) return;
    const data = await res.json();
    els.skillList.textContent = '';
    const list = data.installed || [];
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'skill-empty';
      li.textContent = t('skill.none');
      els.skillList.append(li);
      return;
    }
    for (const skill of list) {
      const li = document.createElement('li');
      li.className = 'skill-item';
      li.dataset.ready = skill.ready ? 'true' : 'false';
      const title = document.createElement('span');
      title.className = 'skill-title';
      title.textContent = skill.title;
      const meta = document.createElement('span');
      meta.className = 'skill-meta';
      if (skill.ready) meta.textContent = skill.degraded?.length ? t('skill.degraded', { what: skill.degraded.join(', ') }) : t('skill.ready');
      else meta.textContent = t('skill.blocked', { what: skill.blockedBy || (skill.requires || []).join(', ') });
      li.append(title, meta);
      if (skill.summary) {
        const p = document.createElement('p');
        p.className = 'skill-summary';
        p.textContent = skill.summary;
        li.append(p);
      }
      els.skillList.append(li);
    }
  } catch { /* informative only */ }
}

/* --------------------------------------------------------- attachments -- */

const ATTACH_TYPES = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv',
  'application/json': 'json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

function openLightbox(src) {
  els.lightboxImg.src = src;
  els.lightbox.hidden = false;
}

/**
 * Upload one file and show it in the thread as a real card.
 *
 * The bytes land in the workspace, which is the same directory the agent's own
 * tools read — so what the phone shows and what the model can use are the same
 * file, not two copies.
 */
async function uploadFile(file) {
  const type = file.type || 'application/octet-stream';
  if (!ATTACH_TYPES[type]) {
    toast(t('attach.unsupported'));
    return null;
  }
  const limits = await api('/api/uploads').then((r) => r.json()).catch(() => ({}));
  const maxBytes = limits?.maxBytes || 6 * 1024 * 1024;
  if (file.size > maxBytes) {
    toast(t('attach.tooBig', { mb: Math.round(maxBytes / (1024 * 1024)) }));
    return null;
  }

  els.attach.disabled = true;
  els.hint.textContent = t('attach.uploading');
  try {
    const data = await readAsBase64(file);
    const res = await api('/api/upload', { method: 'POST', body: { name: file.name, type, data } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
    renderAttachment(body.upload);
    els.hint.textContent = t('attach.ready', { name: body.upload.name });
    return body.upload;
  } catch (err) {
    els.hint.textContent = '';
    toast(t('attach.failed', { error: err.message }));
    return null;
  } finally {
    els.attach.disabled = false;
  }
}

/** A card in the thread: an image, or a chip with the file's name and size. */
function renderAttachment(upload) {
  const node = document.createElement('figure');
  node.className = 'attach-card';
  const body = document.createElement('div');
  body.className = 'attach-body';
  const url = `/api/uploads/${encodeURIComponent(upload.name)}`;

  if (String(upload.type).startsWith('image/')) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = upload.name;
    img.loading = 'lazy';
    img.addEventListener('click', () => openLightbox(url));
    body.append(img);
  } else {
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = (upload.name.split('.').pop() || 'bin').slice(0, 4);
    const label = document.createElement('span');
    label.textContent = upload.name;
    chip.append(icon, label);
    body.append(chip);
  }

  const meta = document.createElement('figcaption');
  meta.className = 'attach-meta';
  const left = document.createElement('span');
  left.textContent = humanBytes(upload.bytes || 0);
  const right = document.createElement('a');
  right.href = url;
  right.target = '_blank';
  right.rel = 'noopener noreferrer';
  right.textContent = t('preview.open');
  meta.append(left, right);

  node.append(body, meta);
  els.thread.append(node);
  setHero(false);
  scrollDown(true);
}

/**
 * Render an HTML file MAJIN created inside the conversation.
 *
 * The iframe carries `sandbox="allow-scripts"` WITHOUT `allow-same-origin`, so
 * the page runs in an opaque origin and cannot reach this app's DOM, storage or
 * session cookie. The server adds a matching `CSP: sandbox` header, so even a
 * client that forgot the attribute is contained.
 */
function renderPreview(name) {
  const url = `/api/uploads/${encodeURIComponent(name)}`;
  const node = document.createElement('div');
  node.className = 'preview';
  const head = document.createElement('div');
  head.className = 'preview-head';
  const label = document.createElement('span');
  label.className = 'preview-name';
  label.textContent = name;
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'preview-open';
  open.textContent = t('preview.open');
  open.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
  head.append(label, open);

  const frame = document.createElement('iframe');
  frame.className = 'preview-frame';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('loading', 'lazy');
  frame.title = t('preview.label', { name });
  frame.src = url;

  node.append(head, frame);
  // Keep preview inside the same expandable work row while the task runs.
  // Only actual verified HTML artifacts are previewable here; do not invent
  // screenshots or expose hidden model reasoning.
  (progressCard && !progressTerminal ? progressCard.detail : els.thread).append(node);
  setHero(false);
  scrollDown(true);
}

/** A file the agent just wrote, offered as a preview if the interface can show it. */
function offerPreview(name) {
  if (!state.previewOn) return;
  if (!/\.(html?|htm)$/i.test(name)) return;
  renderPreview(name);
}

/* ------------------------------------------------------------- rendering -- */

function addMessage(role, text, { error = false, meta = '' } = {}) {
  const article = document.createElement('article');
  article.className = 'msg';
  article.dataset.role = role;
  if (error) article.dataset.error = 'true';
  const body = document.createElement('div');
  body.className = 'msg-body';
  if (role === 'assistant') renderRich(body, text);
  else body.textContent = text;
  const metaEl = document.createElement('div');
  metaEl.className = 'msg-meta';
  metaEl.textContent = meta;
  article.append(body, metaEl);
  els.thread.append(article);
  setHero(false);
  scrollDown(true);
  return { article, body, metaEl };
}

function beginAssistantBubble() {
  if (state.bubble) return state.bubble;
  const { article, body } = addMessage('assistant', '', { meta: '' });
  body.classList.add('cursor');
  state.bubble = { article, body };
  state.bubbleText = '';
  return state.bubble;
}

function streamDelta(text) {
  const bubble = beginAssistantBubble();
  state.bubbleText += text;
  renderRich(bubble.body, state.bubbleText);
  scrollDown();
}

function endAssistantBubble(meta = '') {
  if (!state.bubble) return state.bubbleText;
  state.bubble.body.classList.remove('cursor');
  const metaEl = state.bubble.article.querySelector('.msg-meta');
  if (metaEl) metaEl.textContent = meta || timeLabel();
  const text = state.bubbleText;
  state.bubble = null;
  state.bubbleText = '';
  return text;
}

function toolLabel(name) {
  return {
    workspace_write: 'Creating a file',
    workspace_read: 'Reading a file',
    workspace_list: 'Finding files',
    document_read: 'Reading a document',
    fs_find: 'Finding a file',
    fs_read: 'Reading file contents',
    fs_list: 'Exploring folders',
    memory_save: 'Saving a memory',
    memory_search: 'Searching memory',
    browser_open: 'Opening a webpage',
    browser_read: 'Reading a webpage',
    browser_elements: 'Inspecting a form',
    browser_click: 'Clicking a webpage',
    browser_form: 'Inspecting a form',
    browser_form_fill: 'Filling in a form',
    browser_form_submit: 'Submitting a form',
    browser_screenshot: 'Taking a screenshot',
    browser_snapshot: 'Inspecting the webpage',
    exec_start: 'Running a command',
    exec_wait: 'Checking a command',
    tools_search: 'Searching for a tool',
    tools_activate: 'Activating a tool',
    agent_delegate: 'Delegating a task',
    agent_graph: 'Coordinating tasks',
  }[name] || String(name || 'Working').replaceAll('_', ' ');
}

/** Only show a short, non-secret hint from the server's redacted input. */
function activityHint(input) {
  if (!input || typeof input !== 'object') return '';
  const value = input.fileName || input.filename || input.name || input.url || input.path;
  if (typeof value !== 'string') return '';
  const clean = value.replace(/[\r\n\t]/g, ' ').trim();
  if (!clean || /(?:token|secret|password|api[_-]?key|bearer)=/i.test(clean)) return '';
  return clean.length > 72 ? clean.slice(0, 69) + '…' : clean;
}

function addToolCard(name, input) {
  const node = document.createElement('details');
  node.className = 'tool';
  node.dataset.state = 'running';
  node.dataset.tool = name;

  const summary = document.createElement('summary');
  const dot = document.createElement('span');
  dot.className = 'tool-state';
  const label = document.createElement('span');
  label.className = 'tool-name';
  label.textContent = toolLabel(name);
  const sum = document.createElement('span');
  sum.className = 'tool-summary';
  sum.textContent = input?.fileName || '';
  summary.append(dot, label, sum);

  const detail = document.createElement('div');
  detail.className = 'tool-detail';
  detail.textContent = t('state.running');

  node.append(summary, detail);
  els.thread.append(node);
  setHero(false);
  scrollDown(true);
  return { node, sum, detail };
}

const activeTools = new Map();
let progressCard = null;
let progressStart = 0;
let progressCount = 0;
let progressErrors = 0;
let progressTerminal = false;

/** One live row per turn; precise receipts remain in the expandable details. */
function updateProgress(label, { failed = false, complete = false, step = false } = {}) {
  if (progressTerminal && !complete) return;
  if (!progressCard) {
    progressCard = addToolCard('Working', {});
    progressCard.node.open = false;
    progressCard.node.classList.add('tool-progress');
    progressCard.node.querySelector('.tool-name').textContent = 'Working';
    progressCard.detail.textContent = '';
    progressStart = Date.now();
    progressCount = 0;
    progressErrors = 0;
  }
  if (failed) progressErrors += 1;
  if (step) progressCount += 1;
  const elapsed = Math.max(0, Math.round((Date.now() - progressStart) / 1000));
  progressCard.node.dataset.state = complete ? (progressErrors ? 'failed' : 'verified') : 'running';
  const activity = progressCard.node.querySelector('.tool-name');
  if (activity) activity.textContent = complete ? 'Worked' : (label || 'Working');
  progressCard.sum.textContent = complete
    ? `${elapsed} s · ${progressCount} steps${progressErrors ? ` · ${progressErrors} issues` : ''}`
    : `${progressCount} steps · details`;
  if (label && step) {
    const line = document.createElement('div');
    line.textContent = `${progressCount}. ${label}${failed ? ' · failed' : ''}`;
    progressCard.detail.append(line);
  }
  scrollDown();
}

function finishProgress() {
  if (progressCard) updateProgress('', { complete: true });
  progressCard = null;
  activeTools.clear();
}


/** Rebuild the transcript from server messages and their durable tool receipts. */
function renderConversationMessages(conversation) {
  activeTools.clear();
  progressCard = null;
  progressTerminal = true;
  const goals = new Map((conversation.goals || []).map((goal) => [goal.id, goal]));
  const rendered = new Set();
  for (const message of conversation.messages) {
    const goal = goals.get(message.meta?.goalId);
    if (message.role === 'assistant' && goal) {
      for (const receipt of goal.receipts || []) {
        if (rendered.has(receipt.id) || !receipt.action?.startsWith('tool:')) continue;
        // A resumed goal can have several answers. Put each receipt before the
        // answer that followed it, rather than moving future work into the past.
        if (receipt.at && message.at && receipt.at > message.at) continue;
        rendered.add(receipt.id);
        const name = receipt.action.slice(5);
        // One card per durable receipt. Grouping them would lose the receipt's
        // own state and could make unverified work inherit a sibling's
        // verified/failed state after reload or on another device.
        const card = addToolCard(name, {});
        card.node.open = false;
        card.node.dataset.receiptId = receipt.id;
        card.node.dataset.historical = 'true';
        card.node.dataset.state = receipt.result !== 'success'
          ? 'failed'
          : (receipt.verified ? 'verified' : 'ok');
        card.node.querySelector('.tool-name').textContent = `${t('history.recorded')} · ${toolLabel(name)}`;
        // Targets are untrusted recorded data: textContent keeps markup inert.
        card.sum.textContent = receipt.target || '';
        const status = receipt.result === 'success'
          ? (receipt.verified ? t('history.previouslyVerified') : t('state.done'))
          : t('state.failed');
        card.detail.textContent = [
          status,
          receipt.errorClass || null,
          `${t('state.receipt')} ${receipt.id}`,
          t('history.receiptTime'),
        ].filter(Boolean).join(' · ');
      }
    }
    addMessage(message.role === 'user' ? 'user' : 'assistant', message.content, {
      error: message.meta?.error === true, meta: timeLabel(message.at),
    });
  }
}

/* ------------------------------------------------------------------ auth -- */

function showGate(message = '') {
  state.started = false;
  els.gate.hidden = false;
  els.gateError.hidden = !message;
  els.gateError.textContent = message;
  setTimeout(() => els.gateCode.focus(), 80);
}

function hideGate() {
  els.gate.hidden = true;
}

async function pair(code) {
  els.gateSubmit.disabled = true;
  try {
    const res = await api('/api/auth/pair', { method: 'POST', body: { code } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      showGate(data?.error?.message === 'That pairing code is not valid.' ? t('gate.badCode') : t('gate.failed'));
      return;
    }
    hideGate();
    await loadState();
    // A device that pairs again (or comes back after a session expiry) lands
    // back in the conversation it had open, not in an empty one.
    await restoreConversation();
    toast(t('conn.back'));
  } catch {
    showGate(t('gate.offline'));
  } finally {
    els.gateSubmit.disabled = false;
  }
}

/* ------------------------------------------------------------------ boot -- */

async function boot() {
  try {
    const health = await api('/api/health');
    const h = await health.json().catch(() => ({}));
    state.version = h.version || null;
    if (els.versionNote) els.versionNote.textContent = `MAJIN ${h.version || ''} · Node ${h.node || ''}`.trim();
  } catch {
    setDot('offline');
    els.modelLabel.textContent = 'offline';
  }

  const me = await api('/api/me').then((r) => r.json()).catch(() => ({ authenticated: false }));
  if (!me.authenticated) {
    showGate();
    return;
  }
  hideGate();
  await loadState();
  await restoreConversation();
}

async function loadState() {
  const res = await api('/api/state');
  if (res.status === 401) {
    showGate();
    return;
  }
  const data = await res.json();
  if (!data.ok) return;
  state.model = data.model;
  state.version = data.version || state.version;
  const demo = data.model.demo;
  els.modelLabel.textContent = demo ? 'demo' : data.model.model;
  setDot(demo ? 'demo' : 'ok');
  els.sheetModel.textContent = data.model.label;
  els.sheetModelNote.textContent = demo
    ? t('model.demoNote')
    : t('model.providerNote', { provider: data.model.provider });
  els.versionNote.textContent = `MAJIN ${data.version} · policy: ${data.policy}`;
  renderFiles(data.workspace?.files || []);
  loadOwnerMode();
  loadApprovalPolicy();
  loadSkills();
  loadLearned();
  renderGoals(data.goals || []);
  refreshConversations({ force: true });
  loadModels();
  if (demo) els.hint.textContent = t('hero.demoHint');
  state.started = true;
  refreshHeartbeatSettings();
}

function renderFiles(files) {
  els.sheetFiles.textContent = '';
  if (!files.length) {
    const li = document.createElement('li');
    li.textContent = 'Tom arbetsyta';
    els.sheetFiles.append(li);
    return;
  }
  for (const f of files) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = f;
    li.append(name);
    els.sheetFiles.append(li);
  }
}

/**
 * Goals the host has on disk. A BLOCKED goal gets an explicit resume control:
 * resuming re-verifies against recorded hashes on the server and can still come
 * back BLOCKED, so the button never promises success.
 */
function renderGoals(list) {
  els.sheetGoals.textContent = '';
  const open = list.filter((g) => ['BLOCKED', 'FAILED', 'RUNNING', 'VERIFYING', 'WAITING_FOR_APPROVAL'].includes(g.state));
  if (!open.length) {
    const li = document.createElement('li');
    li.className = 'goal-empty';
    li.textContent = t('sheet.noGoals');
    els.sheetGoals.append(li);
    return;
  }
  for (const goal of open.slice(0, 10)) {
    const li = document.createElement('li');
    li.className = 'goal-item';
    const title = document.createElement('span');
    title.className = 'goal-title';
    title.textContent = goal.objective || goal.id;
    const state = document.createElement('span');
    state.className = 'goal-state';
    state.dataset.state = goal.state;
    state.textContent = t(`goal.state.${goal.state}`);
    li.append(title, state);
    if (goal.state === 'BLOCKED') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn ghost small';
      btn.textContent = t('goal.resume');
      btn.addEventListener('click', () => resumeGoal(goal.id, btn));
      li.append(btn);
    }
    els.sheetGoals.append(li);
  }
}

async function resumeGoal(goalId, button) {
  button.disabled = true;
  button.textContent = t('goal.resuming');
  try {
    const res = await api('/api/goal/resume', { method: 'POST', body: { goalId } });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await readStream(res.body, new AbortController().signal);
    await refreshSidebar();
  } catch (err) {
    toast(err.message || t('msg.genericError'));
  } finally {
    button.disabled = false;
    button.textContent = t('goal.resume');
  }
}

/**
 * The history drawer.
 *
 * One row per conversation with the actions that exist server-side: open,
 * rename, archive/restore, delete. Archive and delete are deliberately
 * different: archiving is a filter, deleting is permanent and confirmed.
 */
function renderHistory() {
  const list = state.conversations;
  els.historyList.textContent = '';
  const archivedView = state.historyView === 'archived';
  els.historyTabActive.setAttribute('aria-selected', String(!archivedView));
  els.historyTabArchived.setAttribute('aria-selected', String(archivedView));

  const visible = list.filter((c) => (archivedView ? Boolean(c.archivedAt) : !c.archivedAt));
  els.historyEmpty.hidden = visible.length > 0;
  if (!visible.length) {
    els.historyEmpty.textContent = state.historyQuery
      ? t('history.noMatches')
      : archivedView ? t('history.noArchived') : t('history.empty');
  }

  for (const conv of visible) {
    const li = document.createElement('li');
    li.className = 'history-item';
    li.dataset.id = conv.id;
    if (conv.id === state.conversationId) li.dataset.active = 'true';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'history-open';
    const title = document.createElement('span');
    title.className = 'history-title';
    title.textContent = conv.title;
    const meta = document.createElement('span');
    meta.className = 'history-meta';
    meta.textContent = `${conv.messages} medd. · ${relativeTime(conv.updatedAt)}`;
    open.append(title, meta);
    open.addEventListener('click', () => openConversation(conv.id));

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'history-more';
    more.setAttribute('aria-label', t('history.actionsFor', { title: conv.title }));
    more.textContent = '⋯';
    more.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openConversationMenu(conv);
    });

    li.append(open, more);
    els.historyList.append(li);
  }
}

/** A small action sheet for one conversation. */
function openConversationMenu(conv) {
  const archived = Boolean(conv.archivedAt);
  const choice = globalThis.prompt
    ? null
    : null;
  void choice;
  showDialog({
    title: conv.title,
    copy: archived ? t('history.archivedNote') : '',
    actions: [
      { label: t('history.rename'), run: () => askRename(conv) },
      { label: archived ? t('history.restore') : t('history.archive'), run: () => setArchived(conv, !archived) },
      { label: t('history.delete'), danger: true, run: () => askDelete(conv) },
    ],
  });
}

/** One reusable dialog shell: rename, confirm, and the action sheet use it. */
function showDialog({ title, copy = '', actions = [] }) {
  els.confirmTitle.textContent = title;
  els.confirmCopy.textContent = copy;
  els.confirmCopy.hidden = !copy;
  els.confirmDelete.hidden = true;
  const extra = els.confirmDialog.querySelector('.dialog-extra');
  if (extra) extra.remove();
  const list = document.createElement('div');
  list.className = 'dialog-extra';
  for (const action of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn ${action.danger ? 'danger' : 'ghost'} wide`;
    btn.textContent = action.label;
    btn.addEventListener('click', async () => {
      closeDialogs();
      await action.run();
    });
    list.append(btn);
  }
  els.confirmCancel.textContent = t('common.cancel');
  els.confirmCancel.onclick = closeDialogs;
  els.confirmDialog.append(list);
  els.confirmDialog.hidden = false;
  els.dialogBackdrop.hidden = false;
  list.querySelector('button')?.focus();
}

function closeDialogs() {
  els.renameDialog.hidden = true;
  els.confirmDialog.hidden = true;
  els.dialogBackdrop.hidden = true;
  const extra = els.confirmDialog.querySelector('.dialog-extra');
  if (extra) extra.remove();
}

function askRename(conv) {
  els.renameDialog.hidden = false;
  els.dialogBackdrop.hidden = false;
  els.renameInput.value = conv.title;
  els.renameInput.dataset.id = conv.id;
  els.renameInput.focus();
  els.renameInput.select();
}

async function submitRename() {
  const id = els.renameInput.dataset.id;
  const title = els.renameInput.value.trim();
  if (!id || !title) return;
  closeDialogs();
  try {
    const res = await api('/api/conversations', { method: 'PATCH', body: { id, title } });
    if (!res.ok) throw new Error(t('history.renameFailed'));
    await refreshConversations({ force: true });
    if (id === state.conversationId) els.heroTitle.textContent = title;
  } catch (err) {
    toast(err.message || t('msg.genericError'));
  }
}

async function setArchived(conv, archived) {
  try {
    const res = await api('/api/conversations', { method: 'PATCH', body: { id: conv.id, archived } });
    if (!res.ok) throw new Error(t('history.archiveFailed'));
    await refreshConversations({ force: true });
    toast(archived ? t('history.archived') : t('history.restored'));
  } catch (err) {
    toast(err.message || t('msg.genericError'));
  }
}

function askDelete(conv) {
  els.confirmTitle.textContent = t('history.deleteTitle');
  els.confirmCopy.textContent = t('history.deleteCopy', { title: conv.title });
  els.confirmCopy.hidden = false;
  els.confirmDelete.hidden = false;
  els.confirmDelete.textContent = t('history.delete');
  els.confirmCancel.textContent = t('common.cancel');
  els.confirmCancel.onclick = closeDialogs;
  const extra = els.confirmDialog.querySelector('.dialog-extra');
  if (extra) extra.remove();
  els.confirmDelete.onclick = () => deleteConversation(conv);
  els.confirmDialog.hidden = false;
  els.dialogBackdrop.hidden = false;
  els.confirmCancel.focus();
}

/**
 * Delete is permanent, so the server requires confirm=1. If a turn is still
 * running it answers 409: we then show exactly that and offer to stop it,
 * instead of silently killing work or deleting underneath it.
 */
async function deleteConversation(conv) {
  try {
    let res = await api(`/api/conversations?id=${encodeURIComponent(conv.id)}&confirm=1`, { method: 'DELETE' });
    if (res.status === 409) {
      const proceed = globalThis.confirm
        ? globalThis.confirm(t('history.deleteRunning'))
        : false;
      if (!proceed) return;
      res = await api(`/api/conversations?id=${encodeURIComponent(conv.id)}&confirm=1&cancel=1`, { method: 'DELETE' });
    }
    if (!res.ok) throw new Error(t('history.deleteFailed'));
    if (state.conversationId === conv.id) startNewChat();
    await refreshConversations({ force: true });
  } catch (err) {
    toast(err.message || t('msg.genericError'));
  } finally {
    closeDialogs();
  }
}

function relativeTime(iso) {
  const then = Date.parse(iso || '');
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return t('time.now');
  if (seconds < 3600) return t('time.minutes', { n: Math.round(seconds / 60) });
  if (seconds < 86400) return t('time.hours', { n: Math.round(seconds / 3600) });
  return t('time.days', { n: Math.round(seconds / 86400) });
}

async function openConversation(id) {
  closeSheet();
  closeHistory();
  const res = await api(`/api/conversation?id=${encodeURIComponent(id)}`);
  if (!res.ok) {
    if (res.status === 404) {
      toast(t('history.deletedElsewhere'));
      refreshConversations({ force: true });
    }
    return;
  }
  const data = await res.json();
  state.conversationId = data.conversation.id;
  state.conversationVersion = data.conversation.version;
  rememberConversation(state.conversationId);
  els.thread.textContent = '';
  state.bubble = null;
  state.bubbleText = '';
  renderConversationMessages(data.conversation);
  if (data.conversation.pendingApproval) {
    showApproval({ tool: data.conversation.pendingApproval.tool, reason: '' });
  } else {
    hideApproval();
  }
  setHero(!data.conversation.messages.length);
  scrollDown(true);
}

/* ------------------------------------------------------------------ chat -- */

function newRequestId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  state.requestSeq += 1;
  return `req_${Date.now()}_${state.requestSeq}`;
}

async function send(text, { voiceTurn = false } = {}) {
  const message = String(text || '').trim();
  if (!message || state.streaming) return;

  cancelSpeech();
  els.input.value = '';
  resizeInput();
  addMessage('user', message, { meta: timeLabel() });
  hideApproval();

  const controller = startStream();

  const body = { text: message, requestId: newRequestId() };
  if (voiceTurn) body.voiceTurn = true;
  if (state.conversationId) body.conversationId = state.conversationId;

  try {
    const res = await api('/api/chat', { method: 'POST', body, signal: controller.signal });
    if (res.status === 401) {
      finishStream();
      showGate(t('gate.expired'));
      return;
    }
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `HTTP ${res.status}`);
    }
    await readStream(res.body, controller.signal);
  } catch (err) {
    if (err.name === 'AbortError') {
      endAssistantBubble();
      addMessage('assistant', t('msg.cancelled'), { error: true, meta: timeLabel() });
    } else if (await tryReattach()) {
      // The connection dropped but the host kept working: pick the turn back up
      // instead of telling the user it failed.
      return;
    } else {
      endAssistantBubble();
      addMessage('assistant', t('msg.hostUnreachable', { error: err.message }), { error: true, meta: timeLabel() });
      setDot('offline');
    }
    spirit.set('error');
  } finally {
    finishStream();
  }
}

/**
 * Reattach to a turn the host is still running (or finished while we were
 * away). Returns true when the turn was picked back up. Bounded retries with
 * backoff, because a phone changing network often needs a second or two.
 */
async function tryReattach({ attempts = 3 } = {}) {
  const { turnId, lastSeq } = state.session;
  if (!turnId) return false;
  for (let i = 0; i < attempts; i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, 400 * 2 ** (i - 1)));
    try {
      const res = await api(`/api/chat/stream?turnId=${encodeURIComponent(turnId)}&from=${lastSeq}`);
      if (res.status === 404) return false; // buffer expired: nothing to resume
      if (!res.ok || !res.body) continue;
      state.session.reconnects += 1;
      els.hint.textContent = t('conn.resumed');
      await readStream(res.body, new AbortController().signal);
      return true;
    } catch {
      /* try again */
    }
  }
  return false;
}

function startStream(mode = 'thinking') {
  progressCard = null;
  progressStart = 0;
  progressCount = 0;
  progressErrors = 0;
  progressTerminal = false;
  state.streaming = true;
  els.send.hidden = true;
  els.stop.hidden = false;
  els.send.disabled = true;
  els.composer.dataset.streaming = 'true';
  spirit.set(mode);
  els.hint.textContent = '';
  state.controller = new AbortController();
  updateProgress('Thinking…');
  return state.controller;
}

function finishStream() {
  progressTerminal = true;
  finishProgress();
  state.streaming = false;
  state.controller = null;
  els.stop.hidden = true;
  els.send.hidden = false;
  els.composer.dataset.streaming = 'false';
  resizeInput();
  if (spirit.state !== 'error') setTimeout(() => spirit.set('idle'), 900);
}

async function readStream(stream, signal) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  let finalText = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
      if (Number.isFinite(ev.seq) && ev.seq > 0) state.session.lastSeq = ev.seq;
      const handled = dispatch(ev.event, ev.data);
      if (handled?.final) finalText = handled.final;
    }
    if (signal.aborted) {
      try {
        await reader.cancel();
      } catch { /* already closed */ }
      break;
    }
  }
  const tail = parser.pending;
  if (tail.trim()) {
    const last = handleEventText(tail);
    if (last) dispatch(last.event, last.data);
  }
  return finalText;
}

function handleEventText(chunk) {
  const lines = chunk.split('\n').filter(Boolean);
  let event = 'message';
  const data = [];
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  if (!data.length) return null;
  try {
    return { event, data: JSON.parse(data.join('\n')) };
  } catch {
    return null;
  }
}

/** Fold the event into client state, then let the view react. */
function dispatch(event, data) {
  const before = state.session;
  const { state: next, intents } = applyEvent(before, event, data);
  state.session = next;
  if (next.conversationId && next.conversationId !== state.conversationId) {
    state.conversationId = next.conversationId;
    state.conversationVersion += 1;
    // Bookmark it: a reload on this device must reopen the same conversation.
    rememberConversation(next.conversationId);
  }
  return viewIntents(event, data, intents);
}

function viewIntents(event, data, intents) {
  switch (event) {
    case 'open':
      if (data.model) {
        els.modelLabel.textContent = data.model.demo ? 'demo' : data.model.model;
        setDot(data.model.demo ? 'demo' : 'ok');
      }
      break;

    case 'user':
      break;

    case 'state':
      if (data.state === 'thinking') { spirit.set('thinking'); updateProgress('Thinking about the next step…'); }
      else if (data.state === 'working') { spirit.set('working'); if (!progressCount) updateProgress('Preparing the task…'); }
      else if (data.state === 'verifying') { spirit.set('working'); updateProgress('Verifying the result…'); }
      break;

    case 'delta':
      spirit.set('speaking');
      streamDelta(data.text);
      break;

    case 'tool_start': {
      const hint = activityHint(data.input);
      updateProgress(`${toolLabel(data.name)}${hint ? ' · ' + hint : '…'}`, { step: true });
      spirit.set('working');
      break;
    }

    case 'tool_result': {
      if (data.ok && data.verified && data.name === 'workspace_write' && data.summary) {
        // "name · 1234 byte" -> name
        const fileName = String(data.summary).split(' · ')[0].trim();
        if (fileName) offerPreview(fileName);
      }
      if (progressCard) {
        const activity = progressCard.node.querySelector('.tool-name');
        if (activity) activity.textContent = `${data.ok ? 'Done' : 'Issue'} · ${toolLabel(data.name)}`;
        const line = document.createElement('div');
        line.textContent = `${toolLabel(data.name)} · ${data.ok ? (data.verified ? t('state.verified') : t('state.done')) : t('state.failed')}`
          + (data.summary ? ` · ${data.summary}` : '')
          + (data.receiptId ? ` · ${t('state.receipt')} ${data.receiptId}` : '');
        progressCard.detail.append(line);
        if (!data.ok) progressErrors += 1;
      }
      spirit.set('working');
      break;
    }

    case 'context':
      // Quiet, factual: the turn still runs, just with a shorter history.
      els.hint.textContent = t('state.contextTrimmed');
      break;

    case 'recovery': {
      // The host is retrying on its own; say so instead of looking frozen.
      spirit.set('working');
      updateProgress('Trying to resolve a problem…');
      const reason = data.failureClass || t('common.unknownError');
      if (data.action && data.action !== 'none') {
        els.hint.textContent = t('state.recovering', { attempt: data.attempt || 1, reason });
      } else if (Array.isArray(data.advice) && data.advice.length) {
        // Translate the advisor's step names into something the owner can act on,
        // and prefer the first step that is actually about his next move.
        const readable = data.advice
          .map((step) => t(`recovery.${step}`))
          .filter((line) => line && !line.startsWith('recovery.'))
          .slice(0, 2)
          .join(' ');
        els.hint.textContent = t('state.recoveryAdvice', {
          advice: readable || t('recovery.unknown'),
        });
      }
      break;
    }

    case 'approval_required':
      state.pendingApproval = data;
      showApproval(data);
      spirit.set('thinking');
      break;

    case 'error':
      progressTerminal = true;
      finishProgress();
      addMessage('assistant', data.message || t('msg.genericError'), { error: true, meta: timeLabel() });
      spirit.set('error');
      break;

    case 'cancelled':
      progressTerminal = true;
      finishProgress();
      addMessage('assistant', t('msg.cancelledShort'), { error: true, meta: timeLabel() });
      break;

    case 'resume_result': {
      if (data.status === 'completed') {
        addMessage('assistant', t('goal.resumed'), { meta: timeLabel() });
        spirit.set('done');
      } else {
        addMessage('assistant', t('goal.stillBlocked', { items: (data.missing || []).join(', ') || '?' }), {
          error: true,
          meta: timeLabel(),
        });
        spirit.set('error');
      }
      break;
    }

    case 'replay':
      if (data.content) addMessage('assistant', data.content, { meta: t('state.replayed') });
      else if (data.truncated) addMessage('assistant', t('state.truncated'), { meta: t('state.replayed') });
      break;

    case 'done': {
      progressTerminal = true;
      finishProgress();
      const text = endAssistantBubble(timeLabel());
      const finalText = text || '';
      if (data.status === 'already_handled' && !finalText) {
        // Nothing was re-rendered above: say it once, plainly.
        addMessage('assistant', t('state.truncated'), { meta: timeLabel() });
      }
      if (data.status === 'completed') {
        spirit.set('done');
        if (state.tts && finalText) speak(finalText);
        refreshSidebar();
      } else if (data.status === 'awaiting_approval') {
        spirit.set('thinking');
      } else if (data.status === 'cancelled' || data.status === 'denied') {
        spirit.set('idle');
      } else if (data.status === 'failed') {
        spirit.set('error');
      }
      return { final: finalText };
    }

    default:
      break;
  }
  return null;
}

/* -------------------------------------------------------------- approval -- */

function showApproval({ tool, reason }) {
  els.approval.hidden = false;
  els.approvalText.textContent = `${t('approval.text', { tool: toolLabel(tool) })}${reason ? ` ${reason}` : ''}`;
}

function hideApproval() {
  els.approval.hidden = true;
  state.pendingApproval = null;
}

async function resolveApproval(approve) {
  if (state.streaming) return;
  if (!state.conversationId) {
    hideApproval();
    return;
  }
  hideApproval();
  const controller = startStream(approve ? 'working' : 'idle');
  try {
    const res = await api('/api/approve', { method: 'POST', body: { conversationId: state.conversationId, approve }, signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await readStream(res.body, controller.signal);
  } catch (err) {
    if (err.name !== 'AbortError') {
      addMessage('assistant', t('msg.approvalFailed', { error: err.message }), { error: true, meta: timeLabel() });
      spirit.set('error');
    }
  } finally {
    finishStream();
    refreshSidebar();
  }
}

/* ----------------------------------------------------------------- voice -- */

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const voiceSupport = detectVoiceSupport(window);
const canRecord = Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder && (window.AudioContext || window.webkitAudioContext));
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let preferRecording = isIOS || !SpeechRecognition;
let voiceRequest = null;
let narratorAudio = null;
let narratorRequest = null;
let narratorUrl = null;
let detectedVoiceLanguage = null;
const capture = new VoiceCapture({
  onState(mode) {
    state.listening = capture.active;
    els.mic.setAttribute('aria-pressed', String(capture.active));
    spirit.set(mode === 'listening' ? 'listening' : 'idle');
    els.hint.textContent = mode === 'idle' ? '' : t(`voice.capture.${mode}`);
  },
  onError(err) {
    els.hint.textContent = err.name === 'NotAllowedError'
      ? t('voice.capture.blocked')
      : err.name === 'NotFoundError' ? t('voice.capture.missing') : err.message;
  },
  onSpeech() { if (window.speechSynthesis?.speaking || (narratorAudio && !narratorAudio.paused) || narratorRequest || state.streaming) void interruptVoiceTurn(); },
  async onSegment(blob) {
    voiceRequest = new AbortController();
    const request = voiceRequest;
    const timer = setTimeout(() => request.abort(), 120000);
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob);
      });
      if (!capture.active) return;
      const response = await api('/api/voice/transcribe', { method: 'POST', body: { data, type: blob.type }, signal: request.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.code === 'STT_NOT_CONFIGURED' ? t('voice.capture.unconfigured') : t('voice.capture.failed'));
      if (!capture.active || request.signal.aborted) return;
      const text = String(result.transcript || '').trim();
      detectedVoiceLanguage = result.language || null;
      if (!text) return;
      els.input.value = text; resizeInput();
      if (shouldAutoSend({ finalTranscript: text, autosend: state.autosend, streaming: state.streaming })) send(text, { voiceTurn: true });
    } finally { clearTimeout(timer); if (voiceRequest === request) voiceRequest = null; }
  },
});

async function interruptVoiceTurn() {
  cancelSpeech();
  const body = state.session.turnId ? { turnId: state.session.turnId } : state.conversationId ? { conversationId: state.conversationId } : null;
  state.controller?.abort();
  if (body && state.streaming) { try { await api('/api/cancel', { method: 'POST', body }); } catch {} }
}

function stopCapture() { capture.stop(); voiceRequest?.abort(); state.recognition?.abort(); }
document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') { stopCapture(); cancelSpeech(); } });
window.addEventListener('pagehide', stopCapture);
window.addEventListener('offline', stopCapture);

function setupVoice() {
  if (canRecord && preferRecording) {
    els.voiceNote.textContent = t('voice.capture.ready');
    return;
  }
  if (!voiceSupport.recognition) {
    els.mic.disabled = true;
    els.mic.setAttribute('aria-disabled', 'true');
    els.voiceNote.textContent = t('voice.unsupported');
    return;
  }
  const rec = new SpeechRecognition();
  rec.lang = recognitionLang(navigator.language);
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  rec.onstart = () => {
    state.listening = true;
    els.mic.setAttribute('aria-pressed', 'true');
    spirit.set('listening');
    els.hint.textContent = 'Lyssnar…';
  };
  rec.onresult = (ev) => {
    let interim = '';
    let final = '';
    for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
      const r = ev.results[i];
      if (r.isFinal) final += r[0].transcript;
      else interim += r[0].transcript;
    }
    const text = final || interim;
    if (text) {
      els.input.value = text.trim();
      resizeInput();
    }
    spirit.level(Math.min(1, (ev.results[ev.results.length - 1]?.[0]?.confidence || 0.6)));
    if (final) {
      state.lastVoiceFinal = final.trim();
    }
  };
  rec.onerror = (ev) => {
    if (canRecord && ['network', 'service-not-allowed', 'audio-capture', 'not-allowed'].includes(ev.error)) {
      preferRecording = true;
      els.voiceNote.textContent = t('voice.capture.fallback');
    }
    const msg = voiceErrorMessage(ev.error);
    if (msg) els.hint.textContent = msg;
  };
  rec.onend = () => {
    state.listening = false;
    els.mic.setAttribute('aria-pressed', 'false');
    spirit.level(0);
    spirit.set('idle');
    els.hint.textContent = '';
    const spoken = state.lastVoiceFinal;
    state.lastVoiceFinal = null;
    if (shouldAutoSend({ finalTranscript: spoken, autosend: state.autosend, streaming: state.streaming })) {
      els.input.value = '';
      resizeInput();
      send(spoken, { voiceTurn: true });
    }
  };
  state.recognition = rec;
  els.voiceNote.textContent = voiceSupport.synthesis
    ? t('voice.readyTts')
    : t('voice.readyNoTts');
}

function toggleListening() {
  if (canRecord && preferRecording) {
    if (capture.active) { stopCapture(); return; }
    cancelSpeech();
    // Unlock synthesis in the actual microphone tap, before asynchronous iOS
    // permission/STT work. The owner explicitly starts a two-way voice session.
    if (voiceSupport.synthesis) {
      const unlock = new SpeechSynthesisUtterance('');
      window.speechSynthesis.speak(unlock);
      state.tts = true; els.ttsToggle.checked = true;
    }
    // Reuse this exact element for delayed server audio on iOS. Prime only in
    // the owner's tap; a rejected playback remains visible on the real reply.
    narratorAudio ||= new Audio();
    narratorAudio.src = 'data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEARKwAAESsAAABAAgAZGF0YQEAAACA';
    narratorAudio.play().catch(() => {});
    void capture.start();
    return;
  }
  const rec = state.recognition;
  if (!rec) return;
  if (state.listening) {
    rec.stop();
    return;
  }
  cancelSpeech();
  try {
    rec.start();
  } catch {
    /* start() throws if already started; ignore */
  }
}

function pickVoice(language = null) {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  const lang = language || document.documentElement.lang || 'sv-SE';
  return voices.find((v) => v.lang?.toLowerCase().startsWith(lang.slice(0, 2))) || voices[0] || null;
}

async function speak(text) {
  const clean = speechText(text, 600);
  if (!clean) return;
  cancelSpeech();
  const controller = new AbortController();
  narratorRequest = controller;
  try {
    const capabilities = await api('/api/voice', { signal: controller.signal }).then((r) => r.ok ? r.json() : null);
    if (controller.signal.aborted) return;
    if (capabilities?.serverSide?.tts?.some((lane) => lane.mode === 'command' && lane.available)) {
      const streamed = capabilities.serverSide.streamingTts?.available === true;
      const response = await api('/api/voice/speak', { method: 'POST', body: { text: clean, mode: 'command', ...(streamed ? { stream: true } : {}) }, signal: controller.signal });
      if (!response.ok) throw new Error(t('voice.narrator.failed'));
      if (streamed) {
        narratorAudio ||= new Audio();
        await playNarratorStream({ response, audio: narratorAudio, signal: controller.signal, onStart: () => spirit.set('speaking') });
        if (!controller.signal.aborted) spirit.set(capture.active ? 'listening' : 'idle');
        return;
      }
      const audio = await response.blob();
      if (controller.signal.aborted) return;
      narratorAudio ||= new Audio();
      narratorUrl = URL.createObjectURL(audio); narratorAudio.src = narratorUrl;
      narratorAudio.onended = () => { if (narratorUrl) URL.revokeObjectURL(narratorUrl); narratorUrl = null; spirit.set(capture.active ? 'listening' : 'idle'); };
      narratorAudio.onerror = () => { els.hint.textContent = t('voice.narrator.failed'); cancelSpeech(); };
      await narratorAudio.play();
      spirit.set('speaking');
      return;
    }
  } catch (err) {
    if (!controller.signal.aborted) els.hint.textContent = t('voice.narrator.failed');
    return; // never silently substitute another voice for a configured narrator
  } finally { if (narratorRequest === controller) narratorRequest = null; }
  if (!('speechSynthesis' in window)) {
    els.hint.textContent = t('voice.noTts');
    return;
  }
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(clean);
  utter.lang = recognitionLang(detectedVoiceLanguage || navigator.language);
  utter.rate = 1.02;
  utter.pitch = 1.0;
  const voice = pickVoice(utter.lang);
  if (voice) utter.voice = voice;
  utter.onstart = () => spirit.set('speaking');
  utter.onboundary = () => spirit.level(0.45 + Math.random() * 0.3);
  utter.onend = () => {
    spirit.level(0);
    spirit.set('idle');
  };
  window.speechSynthesis.speak(utter);
}

function cancelSpeech() {
  narratorRequest?.abort(); narratorRequest = null;
  narratorAudio?.pause();
  if (narratorUrl) URL.revokeObjectURL(narratorUrl);
  narratorUrl = null;
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

/* ------------------------------------------------------------------ ui -- */

function openSheet() {
  els.sheet.hidden = false;
  els.sheetBackdrop.hidden = false;
  els.menu.setAttribute('aria-expanded', 'true');
  els.sheet.querySelector('button, input')?.focus();
  refreshSidebar();
  refreshHeartbeatSettings();
}

function closeSheet() {
  els.sheet.hidden = true;
  els.sheetBackdrop.hidden = true;
  els.menu.setAttribute('aria-expanded', 'false');
}

async function loadModels({ refresh = false } = {}) {
  try {
    const res = await api(`/api/models${refresh ? '?refresh=1' : ''}`);
    if (!res.ok) return;
    const data = await res.json();
    state.modelCatalogue = data;
    state.modelSelectionVersion = data.selection?.version || 0;
    renderModels(data);
  } catch { /* model list is informational; chat still works */ }
}

const refreshModelsBtn = els.refreshModels;

function renderModels(data) {
  els.modelList.textContent = '';
  const query = String(els.modelSearch?.value || '').toLowerCase().trim();
  const active = data.selection?.modelId || data.current;
  const selected = (data.models || []).find((m) => m.id === active);
  state.modelId = active;
  if (selected) {
    els.modelLabel.textContent = selected.model;
    els.sheetModel.textContent = selected.label;
    els.sheetModelNote.textContent = selected.billing?.label || 'Cost unknown — verify with provider';
    const usage = data.providers?.find((p) => p.name === selected.provider)?.usage;
    if (usage?.windows) {
      const windows = usage.windows;
      els.sheetModelNote.textContent += ` · Go usage: 5h ${windows.rolling.percent}%, week ${windows.weekly.percent}%, month ${windows.monthly.percent}% · ${usage.at}${usage.stale ? ' · stale usage' : ''}`;
    }
  } else if (active) {
    els.modelLabel.textContent = t('model.selectionUnavailable');
    els.sheetModel.textContent = t('model.selectionUnavailable');
    els.sheetModelNote.textContent = t('model.error.unavailable');
  }
  const models = (data.models || []).filter((m) => m.configured && (!query || `${m.label} ${m.displayName || ''}`.toLowerCase().includes(query)) && (!els.modelIncluded?.checked || m.billing?.subscriptionIncluded === true));
  if (!models.length) {
    const li = document.createElement('li');
    li.className = 'model-empty';
    li.textContent = t('model.none');
    els.modelList.append(li);
    els.modelSource.textContent = data.configReadable
      ? t('model.readConfig', { path: data.configPath })
      : t('model.noConfig');
    return;
  }
  for (const m of models) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'model-item';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(m.id === active));
    btn.dataset.modelId = m.id;
    if (m.id === active) btn.dataset.active = 'true';
    const name = document.createElement('span');
    name.textContent = m.label;
    const status = document.createElement('span');
    status.className = 'model-status';
    status.dataset.status = m.status;
    status.textContent = `${m.offering === 'opencode-go' ? 'OpenCode Go · ' : m.offering === 'opencode-zen' ? 'OpenCode Zen · ' : ''}${m.statusLabel || t('model.unverified')} · ${m.billing?.label || 'Cost unknown — verify with provider'}${m.catalogStale ? ' · stale catalogue' : ''}`;
    btn.append(name, status);
    btn.addEventListener('click', () => selectModel(m.id));
    li.append(btn);
    els.modelList.append(li);
  }
  const catalogAt = data.catalog?.at ? new Date(data.catalog.at).toLocaleString('sv-SE') : null;
  els.modelSource.textContent = catalogAt
    ? `${t('model.summary', { count: models.length })} ${t('model.catalogAt', { at: catalogAt })}`
    : t('model.summary', { count: models.length });
  refreshModelsBtn.hidden = !(data.models || []).some((m) => m.configured);
}

async function selectModel(modelId) {
  if (state.streaming) {
    toast(t('model.waitForTurn'));
    return;
  }
  try {
    const entry = state.modelCatalogue?.models?.find((m) => m.id === modelId);
    const needsCostAuthorization = modelId !== state.modelId && !['included', 'free'].includes(entry?.billing?.status);
    if (needsCostAuthorization && !globalThis.confirm(`${entry?.billing?.label || 'Cost unknown — verify with provider'}. ${t('model.costConfirm')}`)) return;
    const res = await api('/api/model', { method: 'POST', body: { modelId, expectedVersion: state.modelSelectionVersion, authorizePotentialCost: needsCostAuthorization } });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data?.error?.message || t('model.selectFailed'));
    state.modelId = modelId;
    els.sheetModel.textContent = data.info.label;
    els.modelLabel.textContent = data.info.demo ? 'demo' : data.info.model;
    setDot(data.info.demo ? 'demo' : 'ok');
    await loadModels();
    toast(t('model.selected'));
  } catch (err) {
    await loadModels();
    toast(err.message || t('model.selectFailed'));
  }
}

/**
 * Fetch the conversation list.
 *
 * `since` is the sync cursor: the server returns only conversations updated
 * after it, so a poll on an idle machine transfers almost nothing. Tombstones
 * are merged too, so a chat deleted on the other device disappears here.
 * Rendering is driven by state.conversations, which is the merge of both.
 */
async function refreshConversations({ force = false } = {}) {
  try {
    const params = new URLSearchParams();
    if (!force && state.syncCursor) params.set('since', state.syncCursor);
    if (state.historyQuery) params.set('q', state.historyQuery);
    params.set('view', 'all');
    const res = await api(`/api/conversations?${params.toString()}`);
    if (!res.ok) return;
    const data = await res.json();
    // A filtered search or a full refresh REPLACES the list. Only an
    // incremental poll (since) merges, because only that response is a delta.
    const incremental = Boolean(params.get('since')) && !state.historyQuery;
    const byId = new Map(incremental ? state.conversations.map((c) => [c.id, c]) : []);
    for (const conv of data.conversations || []) byId.set(conv.id, conv);
    for (const tomb of data.deleted || []) byId.delete(tomb.id);
    state.conversations = [...byId.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    state.syncCursor = data.serverTime || state.syncCursor;
    renderHistory();
    // The open conversation may have changed on another device.
    if (state.conversationId && !state.streaming) {
      const current = byId.get(state.conversationId);
      if (current && current.version !== state.conversationVersion) {
        reloadOpenConversation(current.version);
      }
    }
  } catch { /* the drawer is not critical to sending a message */ }
}

/** Reload the open conversation from the server, preserving scroll position. */
async function reloadOpenConversation(version = null) {
  if (!state.conversationId || state.streaming) return;
  const id = state.conversationId;
  try {
    const res = await api(`/api/conversation?id=${encodeURIComponent(id)}`);
    if (!res.ok) {
      // It was deleted elsewhere: go back to an empty, honest state.
      if (res.status === 404) {
        startNewChat();
        toast(t('history.deletedElsewhere'));
      }
      return;
    }
    const data = await res.json();
    // A poll can finish after the owner switched chats or started a new turn.
    if (state.conversationId !== id || state.streaming) return;
    const atBottom = els.stage.scrollHeight - els.stage.scrollTop - els.stage.clientHeight < 80;
    els.thread.textContent = '';
    state.bubble = null;
    state.bubbleText = '';
    renderConversationMessages(data.conversation);
    state.conversationVersion = data.conversation.version;
    if (data.conversation.pendingApproval) {
      showApproval({ tool: data.conversation.pendingApproval.tool, reason: '' });
    } else {
      hideApproval();
    }
    setHero(!data.conversation.messages.length);
    if (atBottom) scrollDown(true);
    void version;
    renderHistory();
  } catch { /* keep what is on screen */ }
}

/** Poll only while the tab is visible; iOS may pause timers in the background. */
function startSync() {
  if (state.syncTimer) clearInterval(state.syncTimer);
  state.syncTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (state.streaming) return;
    refreshConversations();
    loadModels();
  }, 6000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshConversations({ force: true });
      loadModels();
    }
  });
  // Stop polling when the page goes away; a timer that outlives the document
  // only produces noise (and, in tests, a failure attributed to a later test).
  window.addEventListener('pagehide', () => {
    if (state.syncTimer) clearInterval(state.syncTimer);
    state.syncTimer = null;
  });
}

function openHistory() {
  state.historyOpen = true;
  els.history.hidden = false;
  els.historyBackdrop.hidden = false;
  els.historyBtn.setAttribute('aria-expanded', 'true');
  refreshConversations({ force: true });
  setTimeout(() => els.historyQuery?.focus(), 40);
}

function closeHistory() {
  state.historyOpen = false;
  els.history.hidden = true;
  els.historyBackdrop.hidden = true;
  els.historyBtn.setAttribute('aria-expanded', 'false');
}

/**
 * Which conversation was last open on THIS device.
 *
 * Switching between the phone and the computer is the normal case, so a reload
 * must land back in the same chat instead of an empty one. The id is not data
 * (the transcript lives on the server); it is a bookmark, and a stale one is
 * dropped the first time the server answers 404.
 */
function rememberConversation(id) {
  try {
    if (id) localStorage.setItem('majin.conversationId', id);
    else localStorage.removeItem('majin.conversationId');
  } catch { /* private mode may refuse storage; the app still works */ }
}

async function restoreConversation() {
  // Fully guarded: this runs while the shell is still settling (and after a
  // reload, when the session may already be gone). A failure here must never
  // surface as an unhandled rejection in the console.
  try {
    let id = null;
    try {
      id = localStorage.getItem('majin.conversationId');
    } catch {
      return;
    }
    if (!id) return;
    const res = await api(`/api/conversation?id=${encodeURIComponent(id)}`);
    if (!res.ok) {
      rememberConversation(null);
      return;
    }
    await openConversation(id);
  } catch { /* keep the empty state; the drawer still lists everything */ }
}

function startNewChat() {
  state.conversationId = null;
  state.conversationVersion = 0;
  rememberConversation(null);
  els.thread.textContent = '';
  state.bubble = null;
  state.bubbleText = '';
  setHero(true);
  hideApproval();
  renderHistory();
}

/**
 * What MAJIN learned from its own verified work.
 *
 * The state is shown verbatim: "experimental" is not the same promise as
 * "verified", and a stale procedure says so instead of looking trustworthy.
 */
async function loadLearned() {
  if (!els.learnedList) return;
  try {
    const res = await api('/api/learning');
    if (!res.ok) return;
    const data = await res.json();
    els.learnedList.textContent = '';
    const skills = data.skills || [];
    if (!skills.length) {
      const li = document.createElement('li');
      li.className = 'goal-empty';
      li.textContent = t('learned.empty');
      els.learnedList.append(li);
      return;
    }
    for (const skill of skills.slice(0, 8)) {
      const li = document.createElement('li');
      li.className = 'goal-item';
      const title = document.createElement('span');
      title.className = 'goal-title';
      title.textContent = skill.title;
      const state = document.createElement('span');
      state.className = 'goal-state';
      state.textContent = t(`learned.state.${skill.state}`);
      li.append(title, state);
      if (skill.verification) {
        const note = document.createElement('span');
        note.className = 'meta';
        note.textContent = t('learned.meta', {
          successes: skill.successes,
          failures: skill.failures,
        });
        li.append(note);
      }
      els.learnedList.append(li);
    }
  } catch { /* the learning list is informational */ }
}

/**
 * The approval policy, shown honestly.
 *
 * Full trust is a real choice the owner asked for, so it is one tap away — but it
 * is never a hidden default: the state line says which mode is live, and the
 * warning is only shown when prompts are OFF, so the consequence is visible at
 * the moment the choice is made.
 */
async function loadApprovalPolicy() {
  if (!els.approvalState) return;
  try {
    const res = await api('/api/approvals');
    if (!res.ok) return;
    const data = await res.json();
    renderApprovalPolicy(data.policy, data.note);
  } catch { /* the policy line is informational */ }
}

function renderApprovalPolicy(policy, note = '') {
  const auto = policy === 'auto';
  els.approvalState.textContent = auto ? t('approval.auto') : t('approval.ask');
  els.approvalNote.textContent = note || (auto ? t('approval.autoNote') : t('approval.askNote'));
  els.approvalAuto.checked = auto;
  els.approvalWarning.hidden = !auto;
  els.approvalWarning.textContent = auto ? t('approval.warning') : '';
}

async function setApprovalPolicy(policy) {
  try {
    const res = await api('/api/approvals', { method: 'POST', body: { policy } });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || t('approval.failed'));
    renderApprovalPolicy(data.policy, data.note);
    toast(data.policy === 'auto' ? t('approval.on') : t('approval.off'));
  } catch (err) {
    toast(err.message || t('msg.genericError'));
    // Put the checkbox back where the server says it is.
    await loadApprovalPolicy();
  }
}

async function refreshSidebar() {
  try {
    const res = await api('/api/state');
    if (!res.ok) return;
    const data = await res.json();
    renderFiles(data.workspace?.files || []);
    renderGoals(data.goals || []);
    refreshConversations({ force: true });
  } catch { /* sidebar is non-critical */ }
}

function bindEvents() {
  const filterModels = () => { if (state.modelCatalogue) renderModels(state.modelCatalogue); };
  els.modelSearch?.addEventListener('input', filterModels);
  els.modelIncluded?.addEventListener('change', filterModels);
  els.composer.addEventListener('submit', (ev) => {
    ev.preventDefault();
    send(els.input.value);
  });
  els.input.addEventListener('input', resizeInput);
  els.input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      send(els.input.value);
    }
  });
  els.stop.addEventListener('click', async () => {
    stopCapture();
    cancelSpeech();
    // The turn now outlives the socket on purpose, so stopping it is a request
    // to the host — aborting the fetch alone would just detach and let it run.
    // The turn id is the only handle a client has before it learns the
    // conversation id, which is exactly the case during a first message.
    const body = {};
    if (state.session.turnId) body.turnId = state.session.turnId;
    if (state.conversationId) body.conversationId = state.conversationId;
    if (Object.keys(body).length) {
      try {
        await api('/api/cancel', { method: 'POST', body });
      } catch { /* the local abort below still releases the UI */ }
    }
    state.controller?.abort();
    spirit.set('idle');
  });
  els.mic.addEventListener('click', toggleListening);

  // Attach: one tap on a phone, drag-and-drop on a desktop.
  els.attach.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', async () => {
    const files = [...(els.fileInput.files || [])];
    els.fileInput.value = '';
    for (const f of files) await uploadFile(f); // sequential: the phone may be on 5G
  });
  const dropZone = els.stage;
  for (const type of ['dragenter', 'dragover']) {
    dropZone.addEventListener(type, (ev) => {
      if (!ev.dataTransfer?.types?.includes('Files')) return;
      ev.preventDefault();
      dropZone.dataset.dropping = 'true';
    });
  }
  for (const type of ['dragleave', 'drop']) {
    dropZone.addEventListener(type, () => { delete dropZone.dataset.dropping; });
  }
  dropZone.addEventListener('drop', async (ev) => {
    if (!ev.dataTransfer?.files?.length) return;
    ev.preventDefault();
    for (const f of [...ev.dataTransfer.files]) await uploadFile(f);
  });

  els.lightbox.addEventListener('click', () => { els.lightbox.hidden = true; els.lightboxImg.src = ''; });
  els.lightboxX.addEventListener('click', (ev) => {
    ev.stopPropagation();
    els.lightbox.hidden = true;
    els.lightboxImg.src = '';
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !els.lightbox.hidden) {
      els.lightbox.hidden = true;
      els.lightboxImg.src = '';
    }
  });
  els.menu.addEventListener('click', openSheet);
  els.sheetBackdrop.addEventListener('click', closeSheet);
  els.newChat.addEventListener('click', () => {
    startNewChat();
    closeHistory();
    els.input.focus();
  });
  els.historyBtn.addEventListener('click', openHistory);
  els.historySettings.addEventListener('click', () => {
    closeHistory();
    openSheet();
    els.approvalAuto.scrollIntoView({ block: 'center', behavior: 'smooth' });
    els.approvalAuto.focus({ preventScroll: true });
  });
  els.historyClose.addEventListener('click', closeHistory);
  els.historyBackdrop.addEventListener('click', closeHistory);
  els.historyTabActive.addEventListener('click', () => {
    state.historyView = 'active';
    renderHistory();
  });
  els.historyTabArchived.addEventListener('click', () => {
    state.historyView = 'archived';
    renderHistory();
  });
  let searchTimer = null;
  els.historyQuery.addEventListener('input', () => {
    state.historyQuery = els.historyQuery.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => refreshConversations({ force: true }), 220);
  });
  els.importHistory.addEventListener('click', async () => {
    els.importNote.textContent = t('history.importChecking');
    try {
      const res = await api('/api/conversations/import', { method: 'POST', body: { source: 'v1', dryRun: true } });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || t('history.importFailed'));
      const plan = data.plan || {};
      const creates = plan.create?.length || 0;
      const merges = plan.merge?.length || 0;
      if (!creates && !merges) {
        els.importNote.textContent = t('history.importNothing');
        return;
      }
      els.importNote.textContent = t('history.importAsk', { creates, merges });
      const go = globalThis.confirm
        ? globalThis.confirm(t('history.importConfirm', { creates, merges }))
        : false;
      if (!go) return;
      const applied = await api('/api/conversations/import', { method: 'POST', body: { source: 'v1', dryRun: false } });
      const result = await applied.json();
      if (!applied.ok) throw new Error(result?.error?.message || t('history.importFailed'));
      els.importNote.textContent = t('history.importDone', {
        created: result.result?.created?.length || 0,
        merged: result.result?.merged?.length || 0,
      });
      await refreshConversations({ force: true });
    } catch (err) {
      els.importNote.textContent = err.message || t('history.importFailed');
    }
  });
  els.renameForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    submitRename();
  });
  els.renameCancel.addEventListener('click', closeDialogs);
  els.confirmCancel.addEventListener('click', closeDialogs);
  els.dialogBackdrop.addEventListener('click', closeDialogs);
  // Swipe: from the left screen edge to open the drawer, back to the left to
  // close it. Deliberately narrow triggers — a gesture that fires during a
  // scroll is worse than no gesture at all.
  let touch = null;
  document.addEventListener('touchstart', (ev) => {
    if (ev.touches.length !== 1) { touch = null; return; }
    const t0 = ev.touches[0];
    touch = {
      x: t0.clientX,
      y: t0.clientY,
      at: Date.now(),
      edge: t0.clientX <= 28,
      inDrawer: els.history.contains(ev.target),
    };
  }, { passive: true });
  document.addEventListener('touchend', (ev) => {
    if (!touch) return;
    const t1 = ev.changedTouches[0];
    const dx = t1.clientX - touch.x;
    const dy = touch.y - t1.clientY;
    const quick = Date.now() - touch.at < 700;
    const horizontal = Math.abs(dx) > 64 && Math.abs(dy) < 48;
    if (quick && horizontal) {
      if (touch.edge && dx > 0) openHistory();
      else if (touch.inDrawer && dx < 0) closeHistory();
    }
    touch = null;
  }, { passive: true });

  els.folderAdd.addEventListener('click', addFolder);
  els.folderInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      addFolder();
    }
  });
  els.approvalAuto.addEventListener('change', () => {
    setApprovalPolicy(els.approvalAuto.checked ? 'auto' : 'ask');
  });
  els.ownerRevoke.addEventListener('click', async () => {
    const data = await postOwner({ action: 'revoke' });
    if (data) toast(t('owner.revoked'));
  });
  els.logout.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    closeSheet();
    showGate(t('gate.loggedOut'));
  });
  els.ttsToggle.checked = state.tts;
  els.ttsToggle.addEventListener('change', () => {
    state.tts = els.ttsToggle.checked;
    if (!state.tts) cancelSpeech();
    localStorage.setItem('majin.tts', state.tts ? '1' : '0');
  });
  els.autosendToggle.checked = state.autosend;
  els.autosendToggle.addEventListener('change', () => {
    state.autosend = els.autosendToggle.checked;
    localStorage.setItem('majin.autosend', state.autosend ? '1' : '0');
  });
  els.gateForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const code = els.gateCode.value.trim();
    if (code.length >= 8) pair(code);
  });
  els.approvalAllow.addEventListener('click', () => resolveApproval(true));
  els.approvalDeny.addEventListener('click', () => resolveApproval(false));
  els.approvalDismiss.addEventListener('click', hideApproval);
  els.modelPill.addEventListener('click', openSheet);
  els.refreshModels.addEventListener('click', async () => {
    els.refreshModels.disabled = true;
    toast(t('model.refreshing'), 8000);
    await loadModels({ refresh: true });
    els.refreshModels.disabled = false;
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (!els.sheet.hidden) closeSheet();
    if (state.historyOpen) closeHistory();
    if (!els.renameDialog.hidden || !els.confirmDialog.hidden) closeDialogs();
  });
  window.addEventListener('online', () => {
    els.offline.hidden = true;
    setDot(state.model?.demo ? 'demo' : 'ok');
    toast(t('conn.back'));
  });
  window.addEventListener('offline', () => {
    els.offline.hidden = false;
    setDot('offline');
  });
  if (!navigator.onLine) els.offline.hidden = false;
  // Keep the composer visible when the mobile keyboard opens.
  if (window.visualViewport) {
    const resizeViewport = () => {
      // Safari resizes the visual viewport for its keyboard, while dvh can
      // continue to describe the larger layout viewport.
      document.documentElement.style.setProperty('--app-height', `${window.visualViewport.height}px`);
      if (document.activeElement === els.input) setTimeout(() => scrollDown(true), 50);
    };
    window.visualViewport.addEventListener('resize', resizeViewport);
    window.visualViewport.addEventListener('scroll', resizeViewport);
    resizeViewport();
  }
}

function restorePrefs() {
  try {
    if (localStorage.getItem('majin.tts') === '1') state.tts = true;
    if (localStorage.getItem('majin.autosend') === '0') state.autosend = false;
  } catch { /* storage may be blocked; defaults stand */ }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {
      /* offline shell is optional; the app works without it */
    });
  });
}

async function main() {
  restorePrefs();
  setupVoice();
  bindEvents();
  bindHeartbeat();
  registerServiceWorker();
  resizeInput();
  if (reducedMotion) spirit.set('idle');
  await boot();
  await restoreConversation();
  const linkedConversation=new URL(location.href).searchParams.get('conversation');
  if(linkedConversation&&/^conv_[a-z0-9_]+$/.test(linkedConversation))await openConversation(linkedConversation);
  bindPush();
  startSync();
}

main();

function bindPush(){
  const enable=$('#push-enable'),test=$('#push-test'),disable=$('#push-disable'),note=$('#push-status');
  if(!enable)return;
  const request=async body=>{const response=await api('/api/push',body?{method:'POST',body}:{});const data=await response.json();if(!response.ok||!data.ok)throw Error(data.error?.message||'Notification request failed');return data;};
  const supported='serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;
  if(!supported){enable.disabled=true;note.textContent='Notifications require a supported browser. On iPhone, add MAJIN to the Home Screen and open that app.';return;}
  enable.addEventListener('click',async()=>{
    enable.disabled=true;
    try{
      // Request in the actual click gesture; Safari requires an installed PWA.
      const permission=await Notification.requestPermission();
      if(permission!=='granted')throw Error('Notification permission was not granted. Check this device’s settings.');
      const config=await request();
      if(!config.enabled)throw Error('Host needs its HTTPS public origin configured.');
      const registration=await navigator.serviceWorker.ready;
      const bytes=Uint8Array.from(atob(config.publicKey.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
      const subscription=await registration.pushManager.getSubscription()||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});
      await request({action:'subscribe',subscription:subscription.toJSON()});
      test.hidden=false;disable.hidden=false;note.textContent='This device subscribed. A test must arrive while the phone is locked before physical acceptance.';
    }catch(error){note.textContent=error.message;}finally{enable.disabled=false;}
  });
  test.addEventListener('click',async()=>{
    test.disabled=true;try{await request({action:'test'});note.textContent='Test queued. Check the locked phone; server acceptance alone does not prove receipt.';}catch(error){note.textContent=error.message;}finally{test.disabled=false;}
  });
  disable.addEventListener('click',async()=>{
    try{const registration=await navigator.serviceWorker.ready;const subscription=await registration.pushManager.getSubscription();if(subscription){await request({action:'unsubscribe',endpoint:subscription.endpoint});await subscription.unsubscribe();}test.hidden=true;disable.hidden=true;note.textContent='Notifications disabled on this device.';}catch(error){note.textContent=error.message;}
  });
}

function bindHeartbeat(){
  const toggle=$('#heartbeat-notify'),note=$('#heartbeat-status'),resume=$('#heartbeat-resume');
  if(!toggle)return;
  const request=async body=>{const response=await api('/api/heartbeat',body?{method:'POST',body}:{});const data=await response.json();if(!response.ok||!data.ok)throw Error(data.error?.message||'Background settings unavailable');return body?data.result:data;};
  toggle.disabled=true;
  refreshHeartbeatSettings=()=>{
    if(!state.started||!els.gate.hidden)return;
    return request().then(data=>{toggle.disabled=false;toggle.checked=data.notify;if(resume)resume.hidden=data.enabled&&!data.deliveryPaused;note.textContent=data.deliveryPaused?'Background delivery paused after repeated failures.':!data.enabled?'Background collection is paused.':'Background updates appear in history. Push needs a subscribed device.';}).catch(error=>{toggle.disabled=true;note.textContent=error.message;});
  };
  resume?.addEventListener('click',async()=>{resume.disabled=true;try{await request({action:'resume'});resume.hidden=true;note.textContent='Background updates resumed.';}catch(error){note.textContent=error.message;}finally{resume.disabled=false;}});
  toggle.addEventListener('change',async()=>{
    const chosen=toggle.checked;toggle.disabled=true;
    try{await request({action:'configure',notify:chosen});note.textContent=chosen?'Notifications enabled for subscribed devices; physical delivery still requires verification.':'Background updates stay in history.';}
    catch(error){toggle.checked=!chosen;note.textContent=error.message;}
    finally{toggle.disabled=false;}
  });
}
