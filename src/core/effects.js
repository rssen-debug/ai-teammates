/**
 * MAJIN — side-effect journal (Del 1D foundation).
 *
 * Every external action that must never be executed twice (file writes, shell
 * commands, web submissions...) gets a journaled entry NEXT TO the session
 * history (`<sid>.journal.jsonl`). After a crash the code, never the model,
 * decides what may safely run again:
 *
 *   - entry completed + external evidence still matches -> skip (verified)
 *   - entry started but not completed -> inspect the external target first:
 *     if it already carries the intended result, mark completed and skip;
 *     only when the evidence is truly absent may the step run again.
 *
 * A retry with identical arguments and identical evidence is structurally
 * impossible: the evidence gate decides, not optimism.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { historyPath } from './context.js';

export function journalPath(session) {
  try {
    return historyPath(session).replace(/\.jsonl$/, '.journal.jsonl');
  } catch {
    return null;
  }
}

export function effectId(effect) {
  return crypto.createHash('sha1')
    .update(JSON.stringify([effect.kind, effect.target, effect.hash || null]))
    .digest('hex').slice(0, 12);
}

/** Append a journal line. Never throws — journaling must not break the task. */
export function recordEffect(session, effect) {
  try {
    const file = journalPath(session);
    if (!file) return null;
    const entry = {
      id: effect.id || effectId(effect),
      kind: effect.kind || 'unknown',
      target: effect.target || null,
      hash: effect.hash || null,
      status: effect.status || 'started',
      ts: Date.now(),
      ...(effect.result !== undefined ? { result: String(effect.result).slice(0, 600) } : {}),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    return entry;
  } catch {
    return null;
  }
}

export function readJournal(session) {
  try {
    const file = journalPath(session);
    if (!file || !fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Latest state per effect id. */
export function journalState(session) {
  const map = new Map();
  for (const e of readJournal(session)) map.set(e.id, e);
  return map;
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Inspect the external world for an effect. Returns
 * 'completed' (evidence matches), 'absent' (nothing to show), or 'unknown'
 * (kind we cannot prove — caller must NOT silently retry those).
 */
export function inspectEffect(effect, { workspaceRoot } = {}) {
  if (effect.kind === 'fs.write' && effect.target) {
    const abs = path.isAbsolute(effect.target)
      ? effect.target
      : path.resolve(workspaceRoot || process.cwd(), effect.target);
    try {
      const buf = fs.readFileSync(abs);
      if (effect.hash) return sha256(buf) === effect.hash ? 'completed' : 'absent';
      return buf.length > 0 ? 'completed' : 'absent';
    } catch {
      return 'absent';
    }
  }
  return 'unknown';
}

/**
 * Decide which plan steps may run, which are already done, and which need
 * human confirmation. NEVER mutates — decision first, execution second.
 * plan:  [{ id, text, effect: { kind, target, hash, content? } }]
 * returns { run:[], verifiedDone:[], uncertain:[], cancelled:[] }
 */
export function planResume(session, plan, { workspaceRoot } = {}) {
  const state = journalState(session);
  const out = { run: [], verifiedDone: [], uncertain: [], cancelled: [] };
  for (const step of plan || []) {
    const sid = step.id;
    const entry = state.get(sid) || state.get(effectId({ kind: step.effect?.kind, target: step.effect?.target, hash: step.effect?.hash }));
    if (entry?.status === 'cancelled') { out.cancelled.push(step); continue; }
    if (entry?.status === 'completed') {
      if (step.effect) {
        const seen = inspectEffect({ ...step.effect, id: sid }, { workspaceRoot });
        if (seen === 'completed') { out.verifiedDone.push({ step, evidence: 'external evidence matches' }); continue; }
        if (seen === 'absent') { out.uncertain.push({ step, reason: 'journal said completed but evidence is gone' }); continue; }
      } else {
        out.verifiedDone.push({ step, evidence: 'journaled no-op step (no external effect declared)' });
        continue;
      }
      out.uncertain.push({ step, reason: 'journal said completed; evidence kind not inspectable' });
      continue;
    }
    if (entry?.status === 'started' && step.effect) {
      const seen = inspectEffect({ ...step.effect, id: sid }, { workspaceRoot });
      if (seen === 'completed') { out.verifiedDone.push({ step, evidence: 'external evidence found; crash window closed before journaling' }); continue; }
      if (seen === 'unknown') { out.uncertain.push({ step, reason: 'cannot prove external state — asking before retry' }); continue; }
    }
    out.run.push(step);
  }
  return out;
}

/**
 * Resume a task = run only what planResume said is safe.
 * execute(step) performs the actual side effect and returns {ok, content?} or throws.
 * Every executed step is journaled started->completed (or ->failed).
 */
export async function recoverTask({ session, plan, execute, workspaceRoot } = {}) {
  const decision = planResume(session, plan, { workspaceRoot });
  const results = { ...decision, executed: [], failed: [] };
  for (const step of decision.run) {
    const eid = step.id || effectId(step.effect || { kind: 'task.step', target: step.text });
    recordEffect(session, { id: eid, kind: step.effect?.kind || 'task.step', target: step.effect?.target || null, hash: step.effect?.hash || null, status: 'started' });
    try {
      const value = await execute(step);
      const hash = value?.content !== undefined && step.effect?.kind === 'fs.write'
        ? sha256(Buffer.from(String(value.content)))
        : (step.effect?.hash || null);
      recordEffect(session, { id: eid, kind: step.effect?.kind || 'task.step', target: step.effect?.target || null, hash, status: 'completed' });
      results.executed.push({ step, value });
    } catch (err) {
      recordEffect(session, { id: eid, kind: step.effect?.kind || 'task.step', target: step.effect?.target || null, status: 'failed', result: String(err && err.message || err) });
      results.failed.push({ step, error: String(err && err.message || err) });
    }
  }
  return results;
}

/**
 * Explicit task actions (Del 1): resume | retry | cancel | startFresh.
 * startFresh archives the journal so nothing old can leak into new work.
 */
export async function taskAction({ session, action, plan, execute, workspaceRoot, reason = null } = {}) {
  const file = journalPath(session);
  if (action === 'cancel') {
    const state = journalState(session);
    for (const step of plan || []) {
      const eid = step.id || effectId(step.effect || { kind: 'task.step', target: step.text });
      if (state.get(eid)?.status === 'completed') continue;
      recordEffect(session, { id: eid, kind: step.effect?.kind || 'task.step', target: step.effect?.target || null, status: 'cancelled', result: reason });
    }
    return { action, cancelled: (plan || []).length };
  }
  if (action === 'startFresh') {
    let archived = null;
    try {
      if (file && fs.existsSync(file)) {
        archived = `${file}.archived.${Date.now()}`;
        fs.renameSync(file, archived);
      }
    } catch { /* archiving must never block a fresh start */ }
    return { action, archived };
  }
  if (action === 'retry' || action === 'resume') {
    return { action, ...(await recoverTask({ session, plan, execute, workspaceRoot })) };
  }
  return { action, error: 'unknown task action' };
}
