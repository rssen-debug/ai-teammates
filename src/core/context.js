/**
 * MAJIN — context management.
 * Tokens are estimated, not tokenised (no 200 MB tokenizer dependency).
 * Tool output never vanishes: oversized results spill to disk and the model
 * gets a head+tail excerpt with the file path so it can re-read exactly what it needs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dirs } from './paths.js';
import { bus } from './log.js';
import { complete } from './provider/chat.js';

export function estimateTokens(text) {
  if (!text) return 0;
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  let cjk = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c > 0x2e80 && c < 0xffff) cjk += 1;
  }
  return Math.ceil((s.length - cjk) / 3.6 + cjk / 1.1);
}

export function messagesTokens(messages) {
  return messages.reduce((n, m) => n + estimateTokens(m.content) + estimateTokens(m.tool_calls) + 6, 0);
}

/** Spill big tool results so the transcript stays readable and searchable. */
export function spill(name, data) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dirs.out, `${stamp}-${name.replace(/[^\w.-]/g, '_')}`);
  try {
    fs.mkdirSync(dirs.out, { recursive: true });
    fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    return file;
  } catch (err) {
    bus.warn('spill.failed', { error: err.message });
    return null;
  }
}

export function capText(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return { text: s, spilled: null, clipped: false };
  const head = s.slice(0, Math.floor(max * 0.62));
  const tail = s.slice(s.length - Math.floor(max * 0.24));
  const file = spill('tool-output.txt', s);
  return {
    text: `${head}\n\n…${s.length - head.length - tail.length} characters omitted…\n${tail}\n\n[full output: ${file || 'could not be saved'}]`,
    spilled: file,
    clipped: true,
    chars: s.length,
  };
}

const SUMMER = `Summarise the conversation below into one compact "working memory" block of at most {max} words.
Keep: active goals, decisions, promises made to the user, file paths, commands that ran and what they did, open errors.
Drop: pleasantries, repetition, anything already finished.
Svara bar med punkterna, ingen rubrik.`;

/**
 * Keep the tail verbatim, replace the head with a rolling brief.
 * @returns {Promise<{messages:Array, brief:string, compacted:boolean}>}
 */
export async function compact({ cfg, messages, brief }) {
  const cap = cfg.get('agent.contextTokens') || 48000;
  const keep = cfg.get('agent.keepRecent') || 12;
  const now = messagesTokens(messages);
  if (now < cap * 0.72) return { messages, brief, compacted: false, tokens: now };
  const keepFrom = Math.max(0, messages.length - keep);
  const head = messages.slice(0, keepFrom);
  const tail = messages.slice(keepFrom);
  if (!head.length) return { messages, brief, compacted: false, tokens: now };
  // The full tool/safety instructions and original user goal cannot disappear
  // just because a weak model has used many steps. Preserve them as an anchor.
  const originalSystem = messages.find((m) => m.role === 'system' &&
    !/^(?:WORKING MEMORY BRIEF|ARBETSMINNESBRIEF|ACTIVE GOAL)/.test(String(m.content || '')));
  const originalGoal = messages.find((m) => m.role === 'system' &&
    String(m.content || '').startsWith('ACTIVE GOAL:'));
  const anchors = [originalSystem, originalGoal].filter(Boolean);
  const anchoredTail = tail.filter((m) => !anchors.includes(m));
  const dialog = head
    .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '').slice(0, 900)}`)
    .join('\n')
    .slice(-24000);
  try {
    // Summarizer route resolution can itself fail (missing key/model). Even then
    // compaction must keep the working system prompt and goal, not abort the turn.
    const route = cfg.resolveModel(cfg.get('models.routes.summarize'), 'summarize');
    const res = await complete({
      route,
      job: 'summarize',
      stream: false,
      temperature: 0,
      maxTokens: 800,
      messages: [
        { role: 'system', content: SUMMER.replace('{max}', '320') },
        { role: 'user', content: `${brief ? `EARLIER BRIEF (merge, do not replace):\n${brief}\n\n` : ''}NEW DIALOG:\n${dialog}` },
      ],
    });
    const nextBrief = (res.text || '').trim();
    bus.info('context.compacted', { before: now, headDropped: head.length, briefChars: nextBrief.length });
    return {
      messages: [...anchors, { role: 'system', content: `WORKING MEMORY BRIEF (from MAJIN, compressed history):\n${nextBrief}` }, ...anchoredTail],
      brief: nextBrief,
      compacted: true,
      tokens: messagesTokens(anchors) + messagesTokens(anchoredTail) + estimateTokens(nextBrief),
    };
  } catch (err) {
    bus.warn('context.compact.failed', { error: err.message });
    // V1: keep the existing working-memory brief if the summarizer fails.
    const fallbackBrief = brief ? [{ role: 'system', content: `WORKING MEMORY BRIEF (from MAJIN, previous summary):\n${brief}` }] : [];
    const fallbackMessages = [...anchors, ...fallbackBrief, ...anchoredTail];
    return { messages: fallbackMessages, brief, compacted: true, tokens: messagesTokens(fallbackMessages) };
  }
}

export function trimTools(messages, maxChars) {
  return messages.map((m) => (m.role === 'tool' && String(m.content || '').length > maxChars ? { ...m, content: `${m.content.slice(0, maxChars)}\n…[klippt]` } : m));
}

export function historyPath(sessionId, dir = dirs.sessions) {
  return path.join(dir, `${sessionId.replace(/[^\w-]/g, '_')}.jsonl`);
}

/* History stays best-effort, but silently swallowing disk errors hid the very
   outages the UI-agent handover (2026-10-19) flagged: callers now get the truth
   (true/false) plus the last error, and may decide to surface it. */
export const historyErrors = [];
export function appendHistory(sessionId, msg, dir = dirs.sessions) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(historyPath(sessionId, dir), JSON.stringify({ ...msg, ts: new Date().toISOString() }) + '\n');
    return true;
  } catch (err) {
    historyErrors.push({ sessionId, message: String(err?.message || err), code: err?.code || 'write_failed', when: new Date().toISOString() });
    if (historyErrors.length > 50) historyErrors.splice(0, historyErrors.length - 50);
    return false;
  }
}

export function readHistory(sessionId, cap = 400, dir = dirs.sessions) {
  try {
    const lines = fs.readFileSync(historyPath(sessionId, dir), 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-cap).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    });
  } catch {
    return [];
  }
}
