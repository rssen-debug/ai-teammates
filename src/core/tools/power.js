/**
 * MAJIN W6 — power.propose / power.approve / power.apply.
 * The approval gesture is an explicit, ledgared tool call; an apply without
 * an honest approve-event refuses with a diagnosis, never a bypass.
 */
import fs from 'node:fs';
import { def } from './registry.js';
import { journal } from '../browser.js';
import { extractSwarmAgents, extractCrewaiAgents, transferPlan, approvePlan, applyPlan, findApproval, ledgerRead, ledgerEvent, PowerError, POWER_VERSION } from '../power-transfer.js';

const wsOf = (ctx) => ctx.cfg.get('workspace') || process.cwd();

/** Extract from a real on-disk source file (swarm .py | crewai .yaml). */
async function extractFromFile({ file, pattern }) {
  const text = fs.readFileSync(String(file), 'utf8');
  if (/crewai/i.test(String(pattern))) {
    const yamlNs = await import('js-yaml');
    const yamlLoadFn = yamlNs.load ?? yamlNs.default?.load;
    if (typeof yamlLoadFn !== 'function') throw new PowerError('js-yaml load not available in this build', 'dep_missing');
    return extractCrewaiAgents(text, yamlLoadFn, { sourceFile: String(file) });
  }
  if (/swarm/i.test(String(pattern))) return extractSwarmAgents(text, { sourceFile: String(file) });
  throw new PowerError(`pattern "${pattern}" unknown — supported: openai/swarm | crewai`, 'bad_input');
}

const planFrom = async ({ sourceRepo, sourceRef, license, candidates, team }) =>
  transferPlan({ sourceRepo: String(sourceRepo), sourceRef, license: String(license || 'unknown'), candidates, team: String(team) });

export const powerTools = [
  def({
    name: 'power.propose',
    group: 'agent',
    risk: 'write',
    desc: 'W6 DISCOVER+PROPOSE: read upstream agent definitions (openai/swarm python Agent-literals or crewAI agents.yaml) from a source file, and produce a dry transfer plan (validated candidates → team roster upserts, license risk, planHash). Writes only an append-only ledger NOTE of the proposal — never touches the team.',
    params: {
      pattern: 'string openai/swarm | crewai',
      file: 'string path to .py or agents.yaml source (read-only; never executed)',
      sourceRepo: 'string e.g. "openai/swarm" (provenance — required)',
      sourceRef: 'string optional commit/tag of that source',
      license: 'string e.g. MIT | Apache-2.0 | AGPL-3.0 | unknown',
      team: 'string target team (roster upsert destination)',
    },
    examples: ['power.propose({pattern:"openai/swarm", file:"/abs/triage_agent/agents.py", sourceRepo:"openai/swarm", license:"MIT", team:"support"})'],
    async run({ pattern, file, sourceRepo, sourceRef = '', license = 'unknown', team }, ctx) {
      const session = ctx.session || 'default';
      journal.guard(session, `power.propose:${String(sourceRepo).slice(0, 24)}`);
      try {
        const { candidates, skipped } = await extractFromFile({ file, pattern });
        const plan = await planFrom({ sourceRepo, sourceRef, license, candidates, team });
        ledgerEvent(wsOf(ctx), { type: 'propose', planHash: plan.planHash, sourceRepo: plan.sourceRepo, license: plan.license, licenseRisk: plan.licenseRisk, candidates: plan.items.length, skipped });
        return {
          ok: true,
          result: JSON.stringify({ planHash: plan.planHash, licenseRisk: plan.licenseRisk, candidates: plan.items, skipped, next: `power.approve({planHash:"${plan.planHash}"${plan.licenseRisk !== 'low' ? ', acceptCopyleftRisk:"true"' : ''}}) then power.apply({planHash, team})` }, null, 2),
          summary: `plan ${plan.planHash}: ${plan.items.length} candidates (${skipped} unparsed)`,
          meta: { plan },
        };
      } catch (e) {
        return { ok: false, error: { code: e.code || 'power_error', message: String(e.message) } };
      }
    },
  }),

  def({
    name: 'power.approve',
    group: 'agent',
    risk: 'write',
    desc: 'W6 APPROVE: record the human approval gesture for a plan in the ledger. Copyleft/unknown-license plans REQUIRE acceptCopyleftRisk:"true" — legal risk is a gate, never an afterthought.',
    params: {
      planHash: 'string the plan to approve',
      acceptCopyleftRisk: 'string "true" only if you consciously accept copyleft/unknown-license risk [true|false]',
      sourceLicense: 'string license of the plan (for the ledger record)',
    },
    examples: ['power.approve({planHash:"ab12cd34"})'],
    async run({ planHash, acceptCopyleftRisk, sourceLicense = 'unknown' }, ctx) {
      const session = ctx.session || 'default';
      journal.guard(session, `power.approve:${String(planHash).slice(0, 16)}`);
      try {
        const proposals = ledgerRead(wsOf(ctx)).filter((e) => e.type === 'propose' && e.planHash === String(planHash));
        if (!proposals.length) return { ok: false, error: { code: 'not_found', message: `no propose event for plan ${planHash} — nothing was measured, nothing to approve` } };
        const last = proposals[proposals.length - 1];
        approvePlan(wsOf(ctx), { planHash: String(planHash), sourceRepo: last.sourceRepo, license: sourceLicense || last.license, licenseRisk: last.licenseRisk }, { by: session.includes(':') ? `channel ${session.split(':')[0]}` : 'user', acceptCopyleftRisk: String(acceptCopyleftRisk) === 'true' });
        return { ok: true, result: `plan ${planHash} approved (license=${last.license}, risk=${last.licenseRisk})`, summary: 'approved' };
      } catch (e) {
        return { ok: false, error: { code: e.code || 'power_error', message: String(e.message) } };
      }
    },
  }),

  def({
    name: 'power.apply',
    group: 'agent',
    risk: 'exec',
    desc: 'W6 INSTALL+VERIFY: apply an APPROVED plan into the target team (idempotent roster upserts with provenance in instructions + ledger action log), then READ BACK the roster and proof every id. Without approval → refuses with the exact missing step; never pretends.',
    params: {
      planHash: 'string approved plan hash',
      team: 'string target team (must match the plan)',
      membersJson: 'string JSON of plan items as returned by power.propose (id/name/role/instructions) — the plan body is re-validated, never trusted from caller memory',
      sourceRepo: 'string', sourceRef: 'string optional', sourceLicense: 'string',
    },
    examples: ['power.apply({planHash:"ab12cd34", team:"support", membersJson:"[...]", sourceRepo:"openai/swarm", sourceLicense:"MIT"})'],
    async run({ planHash, team, membersJson, sourceRepo, sourceRef = '', sourceLicense = 'unknown' }, ctx) {
      const session = ctx.session || 'default';
      journal.guard(session, `power.apply:${String(planHash).slice(0, 16)}`);
      let items;
      try { items = JSON.parse(String(membersJson || '[]')); } catch (e) { return { ok: false, error: { code: 'bad_input', message: `membersJson invalid: ${e.message}` } }; }
      try {
        const plan = { planHash: String(planHash), team: String(team), items, sourceRepo: String(sourceRepo), sourceRef, license: String(sourceLicense) };
        const out = applyPlan(wsOf(ctx), plan, { by: session.includes(':') ? `channel ${session.split(':')[0]}` : 'user' });
        return { ok: true, result: `installed ${out.verified} member(s) into team "${plan.team}" (verified by roster read-back)`, meta: { actions: out.actions }, summary: `installed ${out.verified}` };
      } catch (e) {
        return { ok: false, error: { code: e.code || 'power_error', message: String(e.message) } };
      }
    },
  }),
];
