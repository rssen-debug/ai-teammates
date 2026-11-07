import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  extractSwarmAgents, extractCrewaiAgents, transferPlan,
  approvePlan, applyPlan, findApproval, ledgerRead, PowerError, POWER_VERSION,
} from '../src/core/power-transfer.js';
import { TeamStore } from '../src/core/teams.js';
import { powerTools } from '../src/core/tools/power.js';
import * as yamlNs from 'js-yaml';
const yamlLoad = yamlNs;

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'power-ws-'));

const SWARM_FIXTURE = `
from swarm import Agent


def transfer_to_sales():
    return sales_agent


triage_agent = Agent(
    name="Triage Agent",
    instructions="Determine which agent is best suited to handle the user's request, and transfer the conversation to that agent.",
)

refunds_agent = Agent(
    name="Refunds Agent",
    instructions=\"\"\"Help the user with a refund. If the reason is that it
was too expensive, offer the user a refund code. If they insist, then
process the refund.\"\"\",
    functions=[process_refund, apply_discount],
)
`;

const CREWAI_FIXTURE = `
agents:
  market_researcher:
    role: Senior Analyst
    goal: Validate market size claims with sources
    backstory: Ex-consultant who never trusts a number without a source
    tools:
      - web.search
      - files.read
  bogus_section: 42
`;

/* ------------------------------ extractors ------------------------------ */

test('W6 swarm-extractor: name/instructions/functions blir candidates — aldrig executing, definierad shape', () => {
  const { candidates, skipped } = extractSwarmAgents(SWARM_FIXTURE, { sourceFile: 'agents.py' });
  assert.equal(candidates.length, 2);
  const triage = candidates.find((c) => c.varName === 'triage_agent');
  assert.equal(triage.name, 'Triage Agent');
  assert.match(triage.instructions, /best suited/);
  assert.equal(triage.pattern, 'openai/swarm');
  const refunds = candidates.find((c) => c.varName === 'refunds_agent');
  assert.deepEqual(refunds.upstreamTools, ['process_refund', 'apply_discount']);
  assert.equal(skipped, 0);
});

test('W6 crewai-extractor: role/goal/backstory → instructions; skippar nonsens-sektioner; loader är INJICERAD, ingen tyst dep', () => {
  assert.throws(() => extractCrewaiAgents(CREWAI_FIXTURE, null), PowerError);
  const { candidates, skipped } = extractCrewaiAgents(CREWAI_FIXTURE, yamlLoad.load ?? yamlLoad.default?.load, { sourceFile: 'agents.yaml' });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].name, 'market researcher');
  assert.match(candidates[0].instructions, /Ex-consultant/);
  assert.deepEqual(candidates[0].upstreamTools, ['web.search', 'files.read']);
  assert.equal(skipped, 1, 'bogus-section:42 ignoreras — inte desperat-gissat som agent');
});

/* ------------------------------ plan ------------------------------ */

test('W6 plan: normaliserar ids, stabil planHash, dedupe-vägring, license risk map', () => {
  const { candidates } = extractSwarmAgents(SWARM_FIXTURE);
  const plan = transferPlan({ sourceRepo: 'openai/swarm', sourceRef: 'deadbeefcafef00d', license: 'MIT', candidates, team: 'support' });
  assert.equal(plan.version, POWER_VERSION);
  assert.equal(plan.licenseRisk, 'low');
  assert.ok(/^[a-z0-9-]+$/.test(plan.items[0].id));
  const again = transferPlan({ sourceRepo: 'openai/swarm', sourceRef: 'deadbeefcafef00d', license: 'MIT', candidates, team: 'support' });
  assert.equal(again.planHash, plan.planHash, 'planHash är deterministisk');
  assert.throws(() => transferPlan({ sourceRepo: 'x', license: 'MIT', candidates: [...candidates, candidates[0]], team: 't' }), /duplicate id/);
  assert.throws(() => transferPlan({ sourceRepo: 'x', license: 'MIT', candidates: [], team: 't' }), PowerError);
  const risky = transferPlan({ sourceRepo: 'x', license: 'AGPL-3.0', candidates: candidates.slice(0, 1), team: 't' });
  assert.equal(risky.licenseRisk, 'copyleft');
});

/* ------------------------------ approve/apply ------------------------------ */

test('W6 gateflow: apply utan approve = vägran med exakt steg; approve → apply; idempotent re-apply; provenance innestucken + verifierad återläsning', () => {
  const dir = ws();
  const { candidates } = extractSwarmAgents(SWARM_FIXTURE);
  const plan = transferPlan({ sourceRepo: 'openai/swarm', sourceRef: 'sha-abc123', license: 'MIT', candidates, team: 'helpdesk' });

  assert.throws(() => applyPlan(dir, plan), /not approved/);
  assert.equal(findApproval(dir, plan.planHash), null);
  approvePlan(dir, plan, { by: 'tester' });
  assert.ok(findApproval(dir, plan.planHash));

  const out = applyPlan(dir, plan, { by: 'tester' });
  assert.equal(out.verified, 2);
  const store = new TeamStore({ workspaceDir: dir });
  const roster = store.getTeam('helpdesk');
  assert.equal(roster.members.length, 2);
  const triage = roster.members.find((m) => m.id === plan.items.find((i) => i.upstreamPattern === 'openai/swarm' && i.name === 'Triage Agent').id);
  assert.match(triage.instructions, /openai\/swarm@sha-abc12/, 'povenance i instructions — öppet ursprung, aldrig dolt');
  assert.match(triage.instructions, /license: MIT/);
  const boardNotes = store.board('helpdesk').filter((e) => e.key.startsWith('power:transfer:'));
  assert.equal(boardNotes.length, 2, 'audit trail på blackboarden');

  // idempotent: återapplikation markerar updated, roster räknas inte upp
  const again = applyPlan(dir, plan);
  assert.deepEqual(again.actions.every((a) => a.updated === true), true);
  assert.equal(store.getTeam('helpdesk').members.length, 2);

  // ledger ordning: approve PRECEDER alltid apply
  const events = ledgerRead(dir).filter((e) => e.planHash === plan.planHash);
  assert.ok(events.findIndex((e) => e.type === 'approve') < events.findIndex((e) => e.type === 'apply'));
});

test('W6 license-gate: copyleft kräver uttrycklig acceptCopyleftRisk — aldrig tyst legalt risktagande', () => {
  const dir = ws();
  const { candidates } = extractSwarmAgents(SWARM_FIXTURE);
  const risky = transferPlan({ sourceRepo: 'evilcorp/copylefted', license: 'AGPL-3.0', candidates: candidates.slice(0, 1), team: 'g' });
  assert.throws(() => approvePlan(dir, risky), /acceptCopyleftRisk/);
  assert.throws(() => applyPlan(dir, risky), /not approved/);
  approvePlan(dir, risky, { acceptCopyleftRisk: true });
  const out = applyPlan(dir, risky);
  assert.equal(out.verified, 1);
});

/* ------------------------------ tool surface ------------------------------ */

test('W6 tools: propose → approve → apply över RIKTIG fil på disk, fel-paths ärliga (bad pattern, saknad propose, dålig JSON)', async () => {
  const dir = ws();
  const cfgOf = { get: (k) => (k === 'workspace' ? dir : undefined), patch: () => ({ ok: true }) };
  const ctx = { cfg: cfgOf, session: 'test' };
  const tool = (n) => powerTools.find((t) => t.name === n);

  const srcFile = path.join(dir, 'agents.py');
  fs.writeFileSync(srcFile, SWARM_FIXTURE);

  let r = await tool('power.propose').run({ pattern: 'openai/swarm', file: srcFile, sourceRepo: 'openai/swarm', license: 'MIT', team: 'hooked' }, ctx);
  assert.equal(r.ok, true);
  const planHash = r.meta.plan.planHash;
  r = await tool('power.approve').run({ planHash }, ctx);
  assert.equal(r.ok, true);
  const { candidates } = extractSwarmAgents(SWARM_FIXTURE);
  const p = transferPlan({ sourceRepo: 'openai/swarm', sourceRef: 'sha-xy', license: 'MIT', candidates, team: 'hooked' });
  const items = p.items.map((i) => ({ id: i.id, name: i.name, role: i.role, instructions: i.instructions, upstreamPattern: i.upstreamPattern }));
  r = await tool('power.apply').run({ planHash, team: 'hooked', membersJson: JSON.stringify(items), sourceRepo: 'openai/swarm', sourceLicense: 'MIT' }, ctx);
  assert.equal(r.ok, true);
  assert.match(r.result, /verified by roster read-back/);

  const badPattern = await tool('power.propose').run({ pattern: 'someunknown/thing', file: srcFile, sourceRepo: 'x', team: 'g' }, ctx);
  assert.equal(badPattern.ok, false);
  assert.match(badPattern.error.message, /pattern \"someunknown\/thing\" unknown/);

  const badApply = await tool('power.apply').run({ planHash: 'doesnotexist1', team: 'hooked', membersJson: '[]', sourceRepo: 'x' }, ctx);
  assert.equal(badApply.ok, false);
  assert.equal(badApply.error.code, 'not_approved');

  const badJson = await tool('power.apply').run({ planHash, team: 'hooked', membersJson: '{oops', sourceRepo: 'x' }, ctx);
  assert.equal(badJson.ok, false);
  assert.match(badJson.error.message, /membersJson invalid/);
});
