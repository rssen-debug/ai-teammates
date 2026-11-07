/**
 * MAJIN W7 mission checkpoints — the durable state of a mission ON DISK.
 *
 * Purpose (W7, manus-level mission loop): "Continue a previously interrupted
 * task without losing completed work." A mission crash never discards verified
 * progress: this module persists each mission milestone as JSON + a JSONL
 * journal, and runMission consumes verified node results through the existing
 * carry mechanism (verified parts are never re-run — zero repeated side effects).
 * Safety: resumes match by both mission id and node-id set; unknown state never
 * convinces a done mission to redo anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function canonicalMissionId(goal) {
  const norm = String(goal || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

export function checkpointDir(workspaceDir, id) {
  return path.join(workspaceDir, 'missions', id);
}

export function writeState(dir, state) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.state.tmp');
  fs.writeFileSync(tmp, JSON.stringify({ ...state, savedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, path.join(dir, 'state.json'));
  return true;
}

export function readState(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  } catch { return null; }
}

export function journalEvent(dir, event) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'journal.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
  return true;
}

/* carry-derivation: only nodes marked verified pass through; side effects
   are preserved precisely because already-verified parts are never re-run. */
export function carryFromState(state) {
  if (!state || !Array.isArray(state.nodes)) return null;
  const carry = {};
  let n = 0;
  for (const node of state.nodes) {
    if (node.status === 'verified' && typeof node.text === 'string') {
      carry[node.id] = { verified: true, value: { text: node.text }, verifiedSummary: node.verifiedSummary || 'verified in earlier run (checkpoint)' };
      n += 1;
    }
  }
  return n > 0 ? carry : null;
}

export function buildStateFromParts({ id, goal, nodeIds, parts, compiled, verifiedCount, limitsHit }) {
  const nodes = compiled.nodes.map((n, i) => {
    const p = parts[i];
    let status = 'unknown';
    let error = null;
    let verifiedSummary = null;
    let text = null;
    if (p) {
      if (p.ok === true && p.verified) { status = 'verified'; verifiedSummary = p.verified.summary; text = String(p.value?.text || '').slice(0, 4000); }
      else if (p.ok === true) { status = 'done'; text = String(p.value?.text || '').slice(0, 4000); }
      else if (p.ok === false) { status = 'failed'; error = String(p.error || '').slice(0, 400); }
      else if (p.blocked) { status = 'blocked'; error = String(p.reason || '') + (p.limit ? ` [LIMIT:${p.limit.toUpperCase()}]` : ''); }
    }
    // Persist the exact task identity: node IDs alone are not stable across LLM recompilation.
    return { id: n.id, input: n.input, deps: n.deps || [], status, text, error, verifiedSummary };
  });
  const done = nodes.every((n) => ['verified', 'done'].includes(n.status));
  return { id, goal, status: done ? 'complete' : 'blocked', nodeIds, nodes, verifiedCount, limitsHit: [...(limitsHit || [])] };
}
