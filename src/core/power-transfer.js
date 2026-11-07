/**
 * MAJIN W6 POWER TRANSFER — DISCOVER → PROPOSE → APPROVE → APPLY → VERIFY.
 *
 * The absorb report's own caution defines W6: "integration requires the W6
 * pipeline (DISCOVER -> APPROVE -> INSTALL)". This module is that pipeline —
 * deliberately built on ALREADY-VERIFIED parts, never parallel wheels:
 *
 *   DISCOVER  absorb() (W1 engine) supplies the clone + capability map;
 *             extractors here READ the upstream definitions:
 *               - openai/swarm-style: python `x = Agent(name=..., instructions=...)
 *               - crewAI-style: agents.yaml (role/goal/backstory) via js-yaml
 *   PROPOSE   dry plan: validated TransferCandidate[] + per-item action
 *             (team roster upsert) + license risk + planHash. Writes nothing.
 *   APPROVE   human gesture stored append-only in ledger.jsonl — the only
 *             way a plan becomes installable; copyleft/unknown licenses
 *             demand an explicit acceptCopyleftRisk flag inside the gesture.
 *   APPLY     idempotent TeamStore.addMember upsert; provenance carved into
 *             member.instructions + a blackboard note (roster audit trail).
 *   VERIFY    re-read the roster and PROVE each transferred id exists —
 *             claimed-but-not-readable is not transferred.
 *
 * Nothing from the source repo is EVER executed. Code is not transferred;
 * definitions (name/instructions/tools shape) are. License risk is a gate,
 * not a garnish.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TeamStore, TeamInputError } from './teams.js';

export const POWER_VERSION = 'majin-power-transfer/1';

export class PowerError extends Error {
  constructor(msg, code = 'power_error', cause = null) { super(msg); this.name = 'PowerError'; this.code = code; this.cause = cause; }
}

const LICENSE_RISK = (license) => {
  const l = String(license || '').toLowerCase();
  if (!l || l === 'unknown' || l === 'none') return 'unknown';
  if (/agpl|gpl-2|gpl-3|lgpl|sspl/.test(l)) return 'copyleft';
  return 'low';
};

/* ------------------------------- extractors ------------------------------ */

/**
 * openai/swarm pattern: identifier = Agent(name="...", instructions="...",
 * functions=[...]). Parsed as DATA (regex on the literal) — the file is never
 * imported or executed. Unparseable Agent-literals are counted as skipped,
 * honestly.
 */
export function extractSwarmAgents(pySource, { sourceFile = '<memory>' } = {}) {
  const out = []; let skipped = 0;
  const re = /(\w+)\s*=\s*Agent\(\s*\n?\s*name\s*=\s*["']([^"']+)["']\s*,\s*instructions\s*=\s*(f?"""([\s\S]*?)"""|f?["']([\s\S]*?)["'])(?:\s*,\s*functions\s*=\s*\[([^\]]*)\])?/g;
  let m;
  while ((m = re.exec(String(pySource))) !== null) {
    const [, varName, name, , instr3, instr1, fnList] = m;
    const instructions = (instr3 ?? instr1 ?? '').replace(/\{[^}]*\}/g, '').trim();
    if (!name || !instructions) { skipped += 1; continue; }
    const functions = fnList ? fnList.split(',').map((f) => f.trim()).filter((f) => /^[A-Za-z_]\w*$/.test(f)) : [];
    out.push({ kind: 'team-member', pattern: 'openai/swarm', varName, name, instructions: instructions.slice(0, 1800), upstreamTools: functions, sourceFile });
  }
  return { candidates: out, skipped };
}

/** crewAI pattern: agents.yaml mapping of name → {role, goal, backstory}. */
export function extractCrewaiAgents(yamlText, yamlLoad, { sourceFile = '<memory>' } = {}) {
  if (typeof yamlLoad !== 'function') throw new PowerError('extractCrewaiAgents: a yaml load function must be injected (never a silent optional dep)', 'bad_input');
  const data = yamlLoad(String(yamlText || '')) || {};
  const section = data && typeof data === 'object' ? (data.agents && typeof data.agents === 'object' ? data.agents : data) : {};
  const out = []; let skipped = 0;
  for (const [agentName, def] of Object.entries(section)) {
    if (!def || typeof def !== 'object' || (!def.role && !def.backstory && !def.goal)) { skipped += 1; continue; }
    const instructions = [
      def.role ? `Role: ${def.role}` : '',
      def.goal ? `Goal: ${def.goal}` : '',
      def.backstory ? `Backstory: ${def.backstory}` : '',
    ].filter(Boolean).join('\n');
    out.push({ kind: 'team-member', pattern: 'crewai/agents.yaml', varName: agentName, name: agentName.replace(/_/g, ' '), instructions: instructions.slice(0, 1800), upstreamTools: Array.isArray(def.tools) ? def.tools.map(String) : [], sourceFile });
  }
  return { candidates: out, skipped };
}

/* --------------------------------- plan ---------------------------------- */

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function transferPlan({ sourceRepo, sourceRef = null, license = 'unknown', candidates, team }) {
  if (!Array.isArray(candidates) || !candidates.length) throw new PowerError('transferPlan: candidates[] is empty — nothing to transfer', 'bad_input');
  if (typeof team !== 'string' || !team) throw new PowerError('transferPlan: target team is required', 'bad_input');
  const licenseRisk = LICENSE_RISK(license);
  const seen = new Set();
  const items = candidates.map((c, i) => {
    const id = String(c.varName || c.name || `member${i}`).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 39);
    if (!id) throw new PowerError(`candidate ${i}: cannot derive a valid member id from "${c.varName || c.name}"`, 'bad_input');
    if (seen.has(id)) throw new PowerError(`candidate ${i}: duplicate id "${id}" in this plan`, 'bad_input');
    seen.add(id);
    return {
      id,
      name: String(c.name || id).slice(0, 80),
      role: `power-transferred from ${sourceRepo} (${c.pattern}) — ${String(c.name || id).slice(0, 60)}`,
      instructions: [
        `[origin: ${sourceRepo}${sourceRef ? '@' + sourceRef.slice(0, 10) : ''}, license: ${license}, pattern: ${c.pattern}, file: ${c.sourceFile || '?'}]`,
        String(c.instructions || '').slice(0, 1500),
        c.upstreamTools?.length ? `[upstream tool-hints: ${c.upstreamTools.join(', ')} — map consciously to MAJIN tools before live use]` : '',
      ].filter(Boolean).join('\n').slice(0, 1900),
      upstreamPattern: c.pattern,
    };
  });
  const planCore = { version: POWER_VERSION, sourceRepo, sourceRef, license, licenseRisk, team, items: items.map((i) => ({ id: i.id, name: i.name })) };
  return { ...planCore, planHash: sha(JSON.stringify(planCore)).slice(0, 16), items };
}

/* ------------------------------- ledger ---------------------------------- */

export function powerLedgerDir(workspaceDir) { return path.join(workspaceDir, 'power-transfer'); }

export function ledgerEvent(workspaceDir, event) {
  const dir = powerLedgerDir(workspaceDir);
  fs.mkdirSync(dir, { recursive: true });
  const entry = { at: new Date().toISOString(), ...event };
  fs.appendFileSync(path.join(dir, 'ledger.jsonl'), JSON.stringify(entry) + '\n');
  return entry;
}

export function ledgerRead(workspaceDir) {
  try {
    return fs.readFileSync(path.join(powerLedgerDir(workspaceDir), 'ledger.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/* ------------------------------- apply ----------------------------------- */

/**
 * Approve a plan. Copyleft/unknown license REQUIRES acceptCopyleftRisk — the
 * gate cannot be walked around by staying quiet about legal risk.
 */
export function approvePlan(workspaceDir, plan, { by = 'user', acceptCopyleftRisk = false } = {}) {
  if (!plan || !plan.planHash) throw new PowerError('approvePlan: a transferPlan is required', 'bad_input');
  const risky = plan.licenseRisk !== 'low';
  if (risky && !acceptCopyleftRisk) {
    throw new PowerError(`license "${plan.license}" (risk=${plan.licenseRisk}) requires explicit acceptCopyleftRisk=true — W6 never installs legal risk silently`, 'license_risk');
  }
  return ledgerEvent(workspaceDir, { type: 'approve', planHash: plan.planHash, sourceRepo: plan.sourceRepo, license: plan.license, acceptCopyleftRisk: Boolean(acceptCopyleftRisk), by });
}

export function findApproval(workspaceDir, planHash) {
  return ledgerRead(workspaceDir).find((e) => e.type === 'approve' && e.planHash === planHash) || null;
}

/**
 * applyPlan: idempotent upsert into TeamStore. Requires a prior ledger
 * approval. postVERIFY re-reads the roster — transfer is only true if
 * readable back, never just "wrote happened".
 */
export function applyPlan(workspaceDir, plan, { by = 'user' } = {}) {
  if (!findApproval(workspaceDir, plan.planHash)) {
    throw new PowerError(`plan ${plan.planHash}: not approved — power.approve first (DISCOVER→APPROVE→INSTALL has no shortcut)`, 'not_approved');
  }
  const store = new TeamStore({ workspaceDir });
  store.ensureTeam(plan.team);
  const actions = [];
  for (const item of plan.items) {
    const { updated } = store.addMember(plan.team, { id: item.id, role: item.role, instructions: item.instructions, tools: null });
    store.note(plan.team, 'team', `power:transfer:${item.id}`, `${plan.sourceRepo} ${plan.license} (${item.upstreamPattern}) ${updated ? 're-applied' : 'installed'} by ${by}`);
    actions.push({ id: item.id, updated });
  }
  // VERIFY: läs tillbaka, bevisa varje id
  const roster = store.getTeam(plan.team);
  const missing = plan.items.filter((i) => !roster.members.some((m) => m.id === i.id)).map((i) => i.id);
  if (missing.length) throw new PowerError(`post-verify failed: ${missing.join(', ')} not readable in roster "${plan.team}" — claimed-but-unreadable is not transferred`, 'verify_failed');
  const entry = ledgerEvent(workspaceDir, {
    type: 'apply', planHash: plan.planHash, team: plan.team, by,
    actions, verified: plan.items.length, sourceRepo: plan.sourceRepo, sourceRef: plan.sourceRef, license: plan.license,
  });
  return { entry, actions, team: plan.team, verified: plan.items.length };
}
