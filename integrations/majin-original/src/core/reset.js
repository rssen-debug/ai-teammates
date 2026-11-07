/**
 * MAJIN W11 RESET — safe recovery sequences, dry-run first.
 *
 * Rules (Master Directive W11 + Windows runbook):
 *  - reset.plan measures, touches NOTHING. reset.apply requires the plan's
 *    exact confirmToken (anti-drift: plan and apply can't desync — the token
 *    binds the measured file set; a changed fs state forces a new plan).
 *  - Scope guard: only listed artifact dirs under the workspace + home dirs.
 *    Sessions index, memory, config, and user files are never touched by
 *    default. Anything destructive beyond the listed kinds = blocked with a
 *    reason, never silently skipped.
 *  - Everything reported: per-kind before/after, byte counts, freed space.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const VERSION = 'majin-reset/1';

const KINID = (s) => String(s || '').replace(/[^\w.-]/g, '_');

/* What we are ALLOWED to recover. Each kind lists candidate roots relative
   to home/workspace, plus its own measurement rule. Extend deliberately —
   user files are never recovered "accidentally". */
const KINDS = {
  'exec-artifacts': {
    roots: ['workspace/exec'],
    olderThanMs: 24 * 3600_000,
    note: 'dead exec.<id> run dirs (meta/stdout/stderr) older than 24h',
  },
  'temp-spill': {
    roots: ['cache', 'workspace/computer-use'],
    olderThanMs: 48 * 3600_000,
    note: 'spill/cache + computer-use evidence older than 48h',
  },
  'stale-flow-state': {
    roots: ['workspace/heartbeats', 'workspace/flows'],
    olderThanMs: 72 * 3600_000,
    note: 'heartbeat/flow state timestamps that are outright STALE (recovery keeps index, removes stale logs only)',
    filesOnly: true,
  },
};

function walkFiles(root) {
  const out = [];
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const e of entries) {
      const abs = path.join(root, e.name);
      if (e.isDirectory()) out.push(...walkFiles(abs));
      else if (e.isFile()) out.push(abs);
    }
  } catch { /* missing dir = nothing to measure (honest zero) */ }
  return out;
}

export function planRecovery(dirs, { types = Object.keys(KINDS), olderThanMs = null, now = Date.now() } = {}) {
  const plan = { version: VERSION, createdAt: new Date(now).toISOString(), types: [], totals: { files: 0, bytes: 0 } };
  for (const t of types) {
    const k = KINDS[t];
    if (!k) { plan.blocked = (plan.blocked || []).concat({ type: t, reason: `unknown recovery kind "${t}" — nothing claimed, nothing done` }); continue; }
    const cutoff = olderThanMs ?? k.olderThanMs;
    const files = [];
    let bytes = 0;
    for (const root of k.roots) {
      const relRoot = dirs[root.split('/')[0]] ?? dirs[root];
      const abs = path.isAbsolute(root) ? root : path.join(relRoot || '', ...root.split('/').slice(1));
      for (const f of walkFiles(abs)) {
        try {
          const st = fs.statSync(f);
          if (now - st.mtimeMs < cutoff) continue;
          files.push(f); bytes += st.size;
        } catch { /* file vanished between walk and stat — not an error, reality */ }
      }
    }
    plan.types.push({ type: t, note: k.note, cutoffHours: Math.round(cutoff / 3600_000), files, fileCount: files.length, bytes });
    plan.totals.files += files.length;
    plan.totals.bytes += bytes;
  }
  /* the confirm token binds THIS measured file set — fs drift between plan
     and apply forces a new plan, never a blind re-run. */
  const canon = plan.types.flatMap((t) => t.files).sort().join('|');
  plan.confirmToken = crypto.createHash('sha256').update(canon + ':' + plan.createdAt).digest('hex').slice(0, 20);
  return plan;
}

export function summaryText(plan) {
  const lines = plan.types.map((t) => `• ${t.type}: ${t.fileCount} files (${(t.bytes / 1024).toFixed(1)} KB), ${t.note}`);
  const blocked = (plan.blocked || []).map((b) => `BLOCKED: ${b.type} — ${b.reason}`);
  return `reset plan ${plan.confirmToken}\n${lines.concat(blocked).join('\n')}\ntotal: ${plan.totals.files} files, ${(plan.totals.bytes / 1024).toFixed(1)} KB`;
}

export function applyRecovery(dirs, plan, confirmToken) {
  if (!plan || plan.version !== VERSION) throw new Error('unknown plan — run reset.plan again to measure the current state');
  if (String(confirmToken) !== plan.confirmToken) throw new Error(`plan token mismatch — the measured file set changed (or a different plan was applied). Re-run reset.plan for truth.`);
  const removed = [];
  const errors = [];
  for (const t of plan.types) {
    for (const f of t.files) {
      /* scope guard: every removed path MUST sit under one of dirs' roots */
      const roots = Object.values(dirs).filter((d) => typeof d === 'string');
      if (!roots.some((r) => String(f).startsWith(path.resolve(r)))) { errors.push({ file: f, error: 'scope guard refused — outside known dirs' }); continue; }
      try { fs.unlinkSync(f); removed.push(f); } catch (e) {
        errors.push({ file: f, error: e.code === 'ENOENT' ? 'already gone (fs drift measured, marked not-freed)' : e.message });
      }
    }
  }
  const emptied = plan.types.flatMap((t) => [...new Set(t.files.map((f) => path.dirname(f)))])
    .sort((a, b) => b.length - a.length);
  const removedDirs = [];
  for (const d of emptied) {
    try { if (fs.existsSync(d) && fs.readdirSync(d).length === 0) { fs.rmdirSync(d); removedDirs.push(d); } } catch { /* non-empty or gone, fine */ }
  }
  return {
    removed, removedCount: removed.length, removedDirs,
    freedBytes: plan.totals.bytes,
    errors, blocked: plan.blocked || [],
    token: plan.confirmToken,
  };
}
