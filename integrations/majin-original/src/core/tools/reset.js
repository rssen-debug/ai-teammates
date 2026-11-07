/**
 * MAJIN W11 RESET — tools over src/core/reset.js (dry-run first, token-bound).
 */
import { def } from './registry.js';
import { journal } from '../browser.js';
import { dirs } from '../paths.js';
import { planRecovery, summaryText, applyRecovery, VERSION } from '../reset.js';

let LAST_PLAN = null; /* server-side single-handoff: plan → apply, bound by token */

export const resetTools = [
  def({
    name: 'reset.plan',
    group: 'meta',
    risk: 'read',
    desc: 'W11 safe recovery, step 1 (dry-run): measure recoverable artifacts (dead exec runs, temp spill, stale flow/heartbeat logs) WITHOUT touching anything. Returns per-kind counts, KB, and a confirm token that binds the measured state — apply needs that exact token.',
    params: {
      types: 'string: comma-list of recovery kinds (optional, default: all measured kinds for this host)',
    },
    examples: ['reset.plan({})'],
    async run({ types }, ctx) {
      const session = ctx.session || 'default';
      journal.guard(session, 'reset.plan');
      const t = types ? String(types).split(',').map((x) => x.trim()).filter(Boolean) : undefined;
      LAST_PLAN = planRecovery(dirs, { types: t });
      return {
        ok: true,
        result: summaryText(LAST_PLAN),
        meta: { version: VERSION, types: LAST_PLAN.types.map((x) => ({ type: x.type, files: x.fileCount, bytes: x.bytes })), totals: LAST_PLAN.totals, confirmToken: LAST_PLAN.confirmToken },
        summary: `plan: ${LAST_PLAN.totals.files} files measured`,
      };
    },
  }),
  def({
    name: 'reset.apply',
    group: 'meta',
    risk: 'exec',
    desc: 'W11 safe recovery, step 2: apply EXACTLY the files measured by your last reset.plan, identified by its token. fs drift between plan and apply aborts with an honest error instead of blindly deleting. Lists removed paths + freed bytes + per-file failures.',
    params: {
      confirmToken: 'string: the token your reset.plan returned (required, anti-drift)',
    },
    examples: ['reset.apply({confirmToken:"…from your plan…"})'],
    async run({ confirmToken }, ctx) {
      const session = ctx.session || 'default';
      journal.guard(session, 'reset.apply');
      if (!LAST_PLAN) return { ok: false, error: { code: 'no_plan', message: 'no reset.plan measured yet — run reset.plan first in this runtime (never recover blind)' } };
      if (String(confirmToken || '') !== LAST_PLAN.confirmToken) {
        return { ok: false, error: { code: 'token_mismatch', message: `the supplied token doesn't match the last measured plan (${LAST_PLAN.confirmToken}) — state may have drifted; re-run reset.plan`, } };
      }
      const r = applyRecovery(dirs, LAST_PLAN, confirmToken);
      LAST_PLAN = null;
      return {
        ok: r.errors.length === 0,
        result: `applied: ${r.removedCount} files removed, ${(r.freedBytes / 1024).toFixed(1)} KB freed, ${r.removedDirs.length} empty dirs collapsed${r.errors.length ? `\nNOTE: ${r.errors.length} file-level issues (details)` : ''}${r.blocked.length ? `\nBLOCKED kinds: ${r.blocked.map((b) => b.type).join(', ')}` : ''}`,
        meta: r,
        summary: `${r.removedCount} removed, ${r.errors.length} errors`,
      };
    },
  }),
];
