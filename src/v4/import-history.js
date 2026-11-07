/**
 * MAJIN V4 — import of earlier MAJIN history.
 *
 * V1 kept a durable transcript per chat: `<MAJIN_HOME>/sessions/<id>.jsonl`
 * (one JSON object per line) plus `chats-index.json` with title, title policy
 * and `archivedAt` (src/core/chats.js). That is the only earlier version with a
 * persisted conversation transcript — V2 kept goals/receipts/telemetry and V3
 * kept a single-file deliverable, neither has a chat log to import.
 *
 * What this module guarantees:
 *
 *   - the source is only ever READ. Nothing under sessions/ is renamed,
 *     rewritten or deleted; a failed import cannot damage V1.
 *   - re-running is idempotent. Each imported chat carries `sourceId =
 *     "v1:<chatId>"`, and a second run appends only the messages that are not
 *     already there, so a chat that kept growing in V1 converges instead of
 *     duplicating.
 *   - malformed lines are counted and skipped, never guessed at.
 *   - `dryRun` (the default in the CLI) reports exactly what would be created,
 *     merged or skipped before anything is written.
 */
import fs from 'node:fs';
import path from 'node:path';

export const IMPORT_SCHEMA = 'majin.v4.history-import/v1';

/** V4 renders user/assistant turns; tool output is not a chat message. */
const KEEP_ROLES = new Set(['user', 'assistant']);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Read one V1 JSONL transcript defensively: a bad line is counted, not fatal. */
export function readV1Transcript(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { messages: [], malformed: 0, read: false };
  }
  const messages = [];
  let malformed = 0;
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    let entry;
    try {
      entry = JSON.parse(text);
    } catch {
      malformed += 1;
      continue;
    }
    if (!entry || typeof entry !== 'object') {
      malformed += 1;
      continue;
    }
    const role = String(entry.role || '');
    if (!KEEP_ROLES.has(role)) continue;
    const content = typeof entry.content === 'string' ? entry.content : '';
    if (!content.trim()) continue;
    messages.push({
      role,
      content,
      at: entry.ts || entry.at || null,
    });
  }
  return { messages, malformed, read: true };
}

/**
 * The import plan. Pure: it reads the V1 directory and the existing V4
 * conversations, and returns what a write pass would do.
 */
export function planV1Import({ sessionsDir, indexFile = null, conversations }) {
  const plan = {
    schema: IMPORT_SCHEMA,
    source: 'v1',
    sessionsDir,
    found: 0,
    create: [],
    merge: [],
    skip: [],
    malformed: 0,
    reads: [],
    unreadable: [],
  };
  let files = [];
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    return { ...plan, error: `no V1 session directory at ${sessionsDir}` };
  }
  const index = indexFile ? readJson(indexFile) : readJson(path.join(sessionsDir, 'chats-index.json'));
  const indexChats = index && typeof index.chats === 'object' ? index.chats : {};
  plan.found = files.length;

  const bySource = new Map();
  for (const summary of conversations.list({ view: 'all' })) {
    const conv = conversations.get(summary.id);
    if (conv?.sourceId) bySource.set(conv.sourceId, conv);
  }

  for (const file of files) {
    const chatId = path.basename(file, '.jsonl');
    const sourceId = `v1:${chatId}`;
    const { messages, malformed, read } = readV1Transcript(path.join(sessionsDir, file));
    plan.malformed += malformed;
    if (!read) {
      plan.unreadable.push(chatId);
      continue;
    }
    if (!messages.length) {
      plan.skip.push({ chatId, reason: 'no user/assistant messages' });
      continue;
    }
    const meta = indexChats[chatId] || {};
    const existing = bySource.get(sourceId);
    if (existing) {
      const have = existing.messages.filter((m) => KEEP_ROLES.has(m.role)).length;
      if (messages.length > have) {
        plan.merge.push({
          chatId,
          conversationId: existing.id,
          add: messages.length - have,
          title: existing.title,
        });
      } else {
        plan.skip.push({ chatId, reason: 'already imported' });
      }
      continue;
    }
    plan.create.push({
      chatId,
      sourceId,
      title: String(meta.title || '').trim() || messages.find((m) => m.role === 'user')?.content.slice(0, 60) || 'Importerad konversation',
      titlePolicy: ['manual', 'auto', 'fixed', 'fallback'].includes(meta.titlePolicy) ? meta.titlePolicy : 'auto',
      archivedAt: meta.archivedAt || null,
      createdAt: meta.createdAt || null,
      messages,
    });
  }
  return plan;
}

/**
 * Apply a plan. `conversations` is the live V4 store, so an import uses the
 * same files, the same ids and the same API every device already reads.
 */
export function applyV1Import({ plan, conversations }) {
  const result = { created: [], merged: [], skipped: plan.skip.length, malformed: plan.malformed };
  if (plan.error) return { ...result, error: plan.error };

  for (const entry of plan.create) {
    const conv = conversations.create({
      title: entry.title,
      sourceId: entry.sourceId,
      titlePolicy: entry.titlePolicy === 'fixed' ? 'manual' : entry.titlePolicy,
    });
    for (const message of entry.messages) {
      conv.messages.push({
        id: `msg_import_${conv.id}_${conv.messages.length}`,
        at: message.at || conv.createdAt,
        role: message.role,
        content: message.content,
        meta: { importedFrom: 'v1' },
      });
    }
    if (entry.createdAt) conv.createdAt = entry.createdAt;
    conv.archivedAt = entry.archivedAt || null;
    conversations.save(conv);
    result.created.push({ chatId: entry.chatId, conversationId: conv.id, messages: entry.messages.length });
  }

  for (const entry of plan.merge) {
    const conv = conversations.get(entry.conversationId);
    if (!conv) continue;
    const { messages } = readV1Transcript(path.join(plan.sessionsDir, `${entry.chatId}.jsonl`));
    const have = conv.messages.filter((m) => KEEP_ROLES.has(m.role)).length;
    for (const message of messages.slice(have)) {
      conv.messages.push({
        id: `msg_import_${conv.id}_${conv.messages.length}`,
        at: message.at || new Date().toISOString(),
        role: message.role,
        content: message.content,
        meta: { importedFrom: 'v1' },
      });
    }
    conversations.save(conv);
    result.merged.push({ chatId: entry.chatId, conversationId: conv.id, added: messages.length - have });
  }

  return result;
}
