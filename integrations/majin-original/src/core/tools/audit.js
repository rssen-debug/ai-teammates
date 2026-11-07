import { def } from './registry.js';
import { runAudit, renderAudit, VERSION, RULES } from '../self-audit.js';
import { planRecovery } from '../reset.js';
import { repoRoot, dataDir } from '../paths.js';

export const auditTools = [
  def({
    name: 'majin.self_audit',
    group: 'system',
    risk: 'read',
    desc: 'W14 self-audit: MAJIN interrogates its own honesty — rules: unsupported claims in shipped source, mock-mode rows in REAL sessions, unfinished TODO/FIXME/HACK markers, status-doc drift, recovery readiness. Every finding carries file:line evidence; never a vibe report.',
    params: {
      scope: `string: comma-separated rules (${RULES.join(', ')}) — default: all; "quick" = claims + mock-residue only`,
      includeRecovery: 'string: "true" also computes a dry-run reset plan and adds recovery-readiness findings (no side effects)',
    },
    examples: ['majin.self_audit({})', 'majin.self_audit({scope:"mock-mode-residue"})'],
    async run({ scope, includeRecovery }) {
      let scopes = RULES;
      if (String(scope || '').trim()) {
        const want = String(scope).trim() === 'quick'
          ? ['unsupported-claims', 'mock-mode-residue']
          : String(scope).split(',').map((s) => s.trim()).filter(Boolean);
        const unknown = want.filter((w) => !RULES.includes(w));
        if (unknown.length) return { ok: false, error: { code: 'unknown_scope', message: `unknown audit scope(s): ${unknown.join(', ')}. Valid: ${RULES.join(', ')}, quick` } };
        scopes = want;
      }
      let recoveryPlan = null;
      if (String(includeRecovery) === 'true' && scopes.includes('recovery-readiness')) {
        recoveryPlan = planRecovery({ home: dataDir() });
      }
      const report = runAudit({ root: repoRoot, home: dataDir(), recoveryPlan, scopes });
      return {
        ok: true,
        result: renderAudit(report),
        meta: { version: VERSION, ...report },
        summary: `self-audit complete — verdict: ${report.verdict}`,
      };
    },
  }),
];
