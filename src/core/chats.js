/**
 * MAJIN chats — the canonical, durable conversation index.
 *
 * Spec: docs/MAJIN-UI-UX-REPAIR-MASTER-2026-10-20.md (owner complaints #1+#2):
 * rename, archive (reversible), delete (physical + confirmed, attachments
 * policy: unlink only the chat's own session artifacts — workspace files are
 * never touched), activity-sorted ordering that survives restarts.
 * Source of truth = SERVER (dirs.sessions + chats-index.json), never memory
 * arrays or browser localStorage alone.
 *
 * Deterministic rules:
 *  - stable id: chat file basename, sanitized [^\w.:-] → '_'
 *  - title policy:
 *      'desktop'  → "General" (fixed, never auto-overwritten)
 *      manual      → user's rename wins forever after
 *      auto        → first user message recorded → truncated to 60 chars
 *      fallback    → "New conversation"
 *  - ordering: lastActivityAt DESC, tie → id ASC
 *  - 'desktop' is never deletable/archivable — it is the safe landing chat
 */
import fs from 'node:fs';
import path from 'node:path';

export const VERSION = 'majin-chats/1';
export const sanitizeId = (s) => String(s || '').replace(/[^\w.:-]/g, '_').slice(0, 64) || 'desktop';

export function indexPath(dirs) { return path.join(dirs.sessions, 'chats-index.json'); }

export function loadIndex(dirs) {
  try { return JSON.parse(fs.readFileSync(indexPath(dirs), 'utf8')); } catch { return { version: VERSION, chats: {} }; }
}

export function saveIndex(dirs, idx) {
  fs.mkdirSync(dirs.sessions, { recursive: true });
  const tmp = indexPath(dirs) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 1));
  fs.renameSync(tmp, indexPath(dirs));
}

export function ensureChat(dirs, id0) {
  const id = sanitizeId(id0);
  const idx = loadIndex(dirs);
  if (!idx.chats[id]) {
    idx.chats[id] = {
      id,
      title: id === 'desktop' ? 'General' : 'New conversation',
      titlePolicy: id === 'desktop' ? 'fixed' : 'fallback',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      archivedAt: null,
    };
    saveIndex(dirs, idx);
  }
  return idx.chats[id];
}

/* Record real activity. firstUserText sets the title exactly once
   (auto policy) — then stays stable until an explicit rename. */
export function activity(dirs, id0, { firstUserText = null } = {}) {
  const id = sanitizeId(id0);
  const now = new Date().toISOString();
  const idx = loadIndex(dirs);
  const c = idx.chats[id] || (idx.chats[id] = {
    id,
    title: id === 'desktop' ? 'General' : 'New conversation',
    titlePolicy: id === 'desktop' ? 'fixed' : 'fallback',
    createdAt: now, updatedAt: now, lastActivityAt: now, archivedAt: null,
  });
  c.lastActivityAt = now;
  c.updatedAt = now;
  if (firstUserText && c.titlePolicy !== 'manual' && c.titlePolicy !== 'fixed') {
    const textTitle = String(firstUserText).replace(/\s+/g, ' ').trim().slice(0, 60);
    if (textTitle) { c.title = textTitle; c.titlePolicy = 'auto'; }
  }
  saveIndex(dirs, idx);
  return c;
}

export function rename(dirs, id0, title) {
  const id = sanitizeId(id0);
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 80) throw new Error('title must be 1..80 visible characters');
  const idx = loadIndex(dirs);
  if (!idx.chats[id]) throw new Error(`no chat "${id}" — cannot rename a chat that was never materialized`);
  if (id === 'desktop') throw new Error('"General" is the fixed landing chat — it keeps its name');
  idx.chats[id].title = t;
  idx.chats[id].titlePolicy = 'manual';
  idx.chats[id].updatedAt = new Date().toISOString();
  saveIndex(dirs, idx);
  return idx.chats[id];
}

export function setArchived(dirs, id0, archived) {
  const id = sanitizeId(id0);
  if (id === 'desktop') throw new Error('"General" cannot be archived — it is the safe landing chat');
  const idx = loadIndex(dirs);
  if (!idx.chats[id]) throw new Error(`no chat "${id}"`);
  idx.chats[id].archivedAt = archived ? new Date().toISOString() : null;
  idx.chats[id].updatedAt = new Date().toISOString();
  saveIndex(dirs, idx);
  return idx.chats[id];
}

/* Physical delete: ONLY the chat's own session artifacts. Workspace/output
   files the chat touched stay on disk — deleting documents is a separate,
   explicitly authorized operation (never silent side effects). */
export function deleteChat(dirs, id0, titleConfirm) {
  const id = sanitizeId(id0);
  if (id === 'desktop') throw new Error('"General" cannot be deleted — it is the safe landing chat');
  const idx = loadIndex(dirs);
  const c = idx.chats[id];
  if (!c) throw new Error(`no chat "${id}"`);
  if (String(titleConfirm || '') !== c.title) throw new Error(`title confirmation mismatch — type the exact chat title "${c.title}" to confirm deletion`);
  const removed = [];
  const main = path.join(dirs.sessions, `${id}.jsonl`);
  if (fs.existsSync(main)) { fs.unlinkSync(main); removed.push(path.basename(main)); }
  /* .bak siblings created by /api/session/clear belong to this chat */
  try {
    for (const f of fs.readdirSync(dirs.sessions)) {
      /* .bak siblings from /api/session/clear + the per-chat routing sidecar
         (<id>.route.json) both belong to this chat — and only to it. */
      if (f.startsWith(`${id}.jsonl.`) || f === `${id}.route.json`) {
        fs.unlinkSync(path.join(dirs.sessions, f));
        removed.push(f);
      }
    }
  } catch { /* directory list failure never blocks index truth */ }
  delete idx.chats[id];
  saveIndex(dirs, idx);
  return { id, removedFiles: removed };
}

export function listChats(dirs, { search = '', view = 'active' } = {}) {
  const idx = loadIndex(dirs);
  /* discover chat files not yet indexed (imported sessions) */
  let files = [];
  try { files = fs.readdirSync(dirs.sessions).filter((f) => f.endsWith('.jsonl')); } catch { /* empty */ }
  let dirty = false;
  for (const f of files) {
    const id = sanitizeId(path.basename(f, '.jsonl'));
    if (!idx.chats[id]) { dirty = true; ensureChat(dirs, id); }
  }
  const idx2 = dirty ? loadIndex(dirs) : idx;
  const readHistory = (id) => {
    try {
      const lines = fs.readFileSync(path.join(dirs.sessions, `${id}.jsonl`), 'utf8').trim().split('\n').filter(Boolean);
      const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
      return { messages: lines.length, lastText: last ? String(last.content || '').replace(/\s+/g, ' ').slice(0, 120) : '', lastRole: last?.role || null };
    } catch { return { messages: 0, lastText: '', lastRole: null }; }
  };
  const q = String(search || '').trim().toLowerCase();
  const all = Object.values(idx2.chats).map((c) => ({ ...c, ...readHistory(c.id), indexKnown: true }));
  const filtered = all
    .filter((c) => (view === 'archived' ? Boolean(c.archivedAt) : view === 'all' ? true : !c.archivedAt))
    .filter((c) => (!q ? true : c.title.toLowerCase().includes(q) || c.id.toLowerCase().includes(q) || String(c.lastText || '').toLowerCase().includes(q)))
    .sort((a, b) => (a.lastActivityAt === b.lastActivityAt ? (a.id < b.id ? -1 : 1) : a.lastActivityAt < b.lastActivityAt ? 1 : -1));
  return filtered;
}
