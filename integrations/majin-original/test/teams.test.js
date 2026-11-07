import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TeamStore, runTeam, TEAMS_VERSION, TEAM_DEFAULTS, TeamInputError, TeamBudgetError } from '../src/core/teams.js';
import { teamTools } from '../src/core/tools/teams.js';

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'teams-ws-'));

const storeOf = (dir) => new TeamStore({ workspaceDir: dir });

/** Deterministisk worker-fabrik: räknar anrop, aldrig modell, fyller steps. */
const stubMakeWorker = (calls, behavior = {}) => (member) => async (node) => {
  calls.push(`${member.id}:${node.id}`);
  const b = behavior[node.id] || {};
  if (b.throw) throw new Error(b.throw);
  return { text: b.text ?? `${node.id}-done`, steps: b.steps ?? 1, tools: [] };
};

/* ------------------------------ store ------------------------------ */

test('W4 identity: roster persists across reopen; addMember upsert håller stabilt addedAt', () => {
  const dir = ws();
  const s1 = storeOf(dir);
  const { created } = s1.ensureTeam('webui');
  assert.equal(created, true);
  const a1 = s1.addMember('webui', { id: 'researcher', role: 'verify facts', maxSteps: '6' });
  assert.equal(a1.updated, false);
  assert.equal(a1.member.maxSteps, 6);

  const s2 = storeOf(dir); // "ny process"
  const again = s2.ensureTeam('webui');
  assert.equal(again.created, false, 'idempotent: aldrig klubba ett befintligt roster');
  const r = s2.getTeam('webui');
  assert.equal(r.version, TEAMS_VERSION);
  assert.equal(r.members.length, 1);
  const a2 = s2.addMember('webui', { id: 'researcher', role: 'verify facts deeply' });
  assert.equal(a2.updated, true);
  assert.equal(a2.member.addedAt, a1.member.addedAt, 'persistent identity: addedAt ärvs vid upsert');
  assert.equal(a2.member.maxSteps, null, 'storen lagrar rådata; defaulten (' + TEAM_DEFAULTS.maxStepsPerMember + ') appliceras i runTeam');
});

test('W4 identity: removeMember + listTeams + namnvalidering', () => {
  const dir = ws();
  const s = storeOf(dir);
  s.ensureTeam('alpha'); s.ensureTeam('beta');
  assert.deepEqual(s.listTeams(), ['alpha', 'beta']);
  s.addMember('alpha', { id: 'writer', role: 'drafts' });
  assert.equal(s.removeMember('alpha', 'writer').removed, true);
  assert.equal(s.removeMember('alpha', 'writer').removed, false, 'idempotent remove');
  assert.throws(() => s.addMember('Bad Name', { id: 'x', role: 'r' }), TeamInputError);
  assert.throws(() => s.addMember('alpha', { id: 'no_underscores_ok', role: 'r' }), TeamInputError);
  assert.throws(() => s.addMember('alpha', { id: 'x', role: ' ' }), TeamInputError);
});

test('W4 shared memory: blackboard append, key-filter, bounded digest, korrupt rad döljer aldrig andra', () => {
  const dir = ws();
  const s = storeOf(dir);
  s.ensureTeam('t');
  s.note('t', 'researcher', 'finding:api', 'endpoint is /v2');
  s.note('t', 'writer', 'draft:intro', 'hello world'.repeat(400)); // klipps till 4000
  const all = s.board('t');
  assert.equal(all.length, 2);
  const f = s.board('t', { key: 'finding:api' });
  assert.equal(f.length, 1);
  assert.equal(f[0].author, 'researcher');
  assert.match(f[0].t, /^\d{4}-\d{2}-\d{2}T/);
  const d = s.digest('t', { chars: 60 });
  assert.ok(d.length <= 80, 'digest bunden');
  // korrupt rad
  fs.appendFileSync(path.join(s.teamDir('t'), 'memory.jsonl'), '{broken json line\n');
  assert.equal(s.board('t').length, 2, 'en trasig rad döljer inte de giltiga');
});

/* ------------------------------ runTeam ------------------------------ */

test('W4 execution: goals → runSwarm-graf, checkpoints skrivs löpande, spent summerar RIKTIGA steg', async () => {
  const dir = ws();
  const s = storeOf(dir);
  s.ensureTeam('webui');
  s.addMember('webui', { id: 'researcher', role: 'verify facts' });
  s.addMember('webui', { id: 'writer', role: 'drafts' });
  const calls = [];
  const out = await runTeam({
    team: 'webui', store: s, teamStepCap: 10,
    goals: [
      { id: 'g1', member: 'researcher', input: 'check the API version' },
      { id: 'g2', member: 'writer', input: 'write intro using g1', deps: ['g1'] },
    ],
    makeWorker: stubMakeWorker(calls, { g1: { steps: 2 } }),
    runId: 'run-a', cfg: null, registry: null,
  });
  assert.deepEqual(calls.sort(), ['researcher:g1', 'writer:g2']);
  assert.equal(out.okCount, 2);
  assert.equal(out.spent, 3, 'summan av worker-rapporterade steps, inte gissningar');
  assert.equal(out.status, 'complete');
  assert.equal(out.results.get('g1').ok, true);
  const cp = s.loadCheckpoint('webui', 'run-a');
  assert.equal(cp.status, 'complete');
  assert.deepEqual(Object.keys(cp.done).sort(), ['g1', 'g2']);
});

test('W4 execution: okänd member / tomt roster = högljudda input-fel', async () => {
  const dir = ws();
  const s = storeOf(dir);
  s.ensureTeam('empty');
  await assert.rejects(() => runTeam({ team: 'empty', store: s, goals: [{ id: 'g', member: 'x', input: 'y' }], makeWorker: stubMakeWorker([]) }), TeamInputError);
  s.ensureTeam('webui'); s.addMember('webui', { id: 'a', role: 'r' });
  await assert.rejects(() => runTeam({ team: 'webui', store: s, goals: [{ id: 'g', member: 'ghost', input: 'y' }], makeWorker: stubMakeWorker([]) }), /unknown member "ghost"/);
});

test('W4 budget: överträdelse är HÖGLJUDD (TeamBudgetError), klar nod behåller resultatet', async () => {
  const dir = ws();
  const s = storeOf(dir);
  s.ensureTeam('webui'); s.addMember('webui', { id: 'a', role: 'r' });
  const calls = [];
  const out = await runTeam({
    team: 'webui', store: s, teamStepCap: 2, runId: 'run-b',
    goals: [
      { id: 'g1', member: 'a', input: 'x', estMs: 1 },
      { id: 'g2', member: 'a', input: 'y', deps: ['g1'], estMs: 1 },
    ],
    makeWorker: stubMakeWorker(calls, { g1: { steps: 2 } }),
    cfg: null, registry: null,
  });
  assert.equal(out.okCount, 1);
  assert.equal(out.failCount, 1);
  assert.match(String(out.results.get('g2').error), /teamStepCap 2 reached/, 'budget-errorbubblar ärligt i resultatet');
  const cp = s.loadCheckpoint('webui', 'run-b');
  assert.equal(cp.status, 'partial');
  assert.deepEqual(Object.keys(cp.done), ['g1'], 'bara det som faktiskt klarades sparas');
});

test('W4 recovery: resume efter krasch kör ALDRIG om klar nod (exactly-once, counter-proof)', async () => {
  const dir = ws();
  const s = storeOf(dir);
  s.ensureTeam('webui'); s.addMember('webui', { id: 'a', role: 'r' });
  const callsA = [];
  // "Krasch": g2 failar permanent (inte transient) — g1 blir sparad i checkpoint
  const first = await runTeam({
    team: 'webui', store: s, runId: 'run-crash',
    goals: [
      { id: 'g1', member: 'a', input: 'x' },
      { id: 'g2', member: 'a', input: 'y', deps: ['g1'] },
    ],
    makeWorker: stubMakeWorker(callsA, { g2: { throw: 'disk is on fire' } }),
    cfg: null, registry: null,
  });
  assert.equal(first.okCount, 1);
  assert.equal(first.failCount, 1);
  assert.deepEqual(callsA, ['a:g1', 'a:g2']);

  const callsB = [];
  const resumed = await runTeam({
    team: 'webui', store: s, resumeId: 'run-crash',
    goals: [
      { id: 'g1', member: 'a', input: 'x' },
      { id: 'g2', member: 'a', input: 'y', deps: ['g1'] },
    ],
    makeWorker: stubMakeWorker(callsB),
    cfg: null, registry: null,
  });
  assert.deepEqual(callsB, ['a:g2'], 'g1 fick ALDRIG köras om — lagrat värde återanvändes');
  assert.deepEqual(resumed.skipped, ['g1']);
  assert.equal(resumed.resumedFrom, 'run-crash');
  assert.equal(resumed.okCount, 2, 'resumead run räknar både skip och nytt');
  assert.equal(resumed.results.get('g1').value.text, 'g1-done', 'det är run A:s värde som återlämnas');
  await assert.rejects(() => runTeam({ team: 'webui', store: s, resumeId: 'no-such-run', goals: [{ id: 'g', member: 'a', input: 'i' }], makeWorker: stubMakeWorker([]), cfg: null, registry: null }), /resume: no checkpoint/);
});

/* ------------------------------ tool surface ------------------------------ */

const cfgFor = (dir) => ({ get: (k) => (k === 'workspace' ? dir : undefined), patch: () => ({ ok: true }) });
const toolByName = (n) => teamTools.find((t) => t.name === n);

test('W4 tools: manage create → add → note → board → status (via def.run)', async () => {
  const dir = ws();
  const manage = toolByName('team.manage');
  const ctx = { cfg: cfgFor(dir), session: 'test' };
  let r = await manage.run({ action: 'create', team: 'webui' }, ctx);
  assert.equal(r.ok, true);
  r = await manage.run({ action: 'add', team: 'webui', id: 'researcher', role: 'verify facts', tools: 'research.run, files.read', maxSteps: '6' }, ctx);
  assert.equal(r.ok, true);
  r = await manage.run({ action: 'note', team: 'webui', id: 'researcher', key: 'finding:api', value: '/v2' }, ctx);
  assert.equal(r.ok, true);
  r = await manage.run({ action: 'board', team: 'webui', key: 'finding:api' }, ctx);
  assert.match(r.result, /\/v2/);
  // roster-note från add syns på boarden (audit trail av identitetsändringar)
  r = await manage.run({ action: 'board', team: 'webui', key: 'roster:add:researcher' }, ctx);
  assert.match(r.result, /verify facts/);
  r = await manage.run({ action: 'status', team: 'webui' }, ctx);
  assert.equal(r.ok, true);
  const st = JSON.parse(r.result);
  assert.equal(st.members.length, 1);
  assert.equal(st.members[0].tools.join(','), 'research.run,files.read');
  r = await manage.run({ action: 'list' }, ctx);
  assert.match(r.result, /webui/);
  r = await manage.run({ action: 'add', team: 'webui', id: 'x' }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /role is required/);
});

test('W4 tools: team.run utan riktig provider → ärligt fail + checkpoint kvar (ingen töm grattisning)', async () => {
  const dir = ws();
  const manage = toolByName('team.manage');
  const run = toolByName('team.run');
  const ctx = { cfg: cfgFor(dir), session: 'test', registry: { list: () => [], exec: async () => ({ ok: false }) } };
  await manage.run({ action: 'create', team: 'ops' }, ctx);
  await manage.run({ action: 'add', team: 'ops', id: 'probe', role: 'probe things' }, ctx);
  const r = await run.run({ team: 'ops', goals: JSON.stringify([{ id: 'g1', member: 'probe', input: 'noop' }]), runId: 'run-nopke' }, ctx);
  assert.equal(r.ok, false, 'utan modell/provider kan run inte ljuga om framgång');
  const store = storeOf(dir);
  const cp = store.loadCheckpoint('ops', 'run-nopke');
  assert.ok(cp, 'checkpointfilen skrevs även vid misslyckande');
  assert.equal(Object.keys(cp.done).length, 0, 'inget falskt "done" vid totalfel');
  const bad = await run.run({ team: 'ops', goals: '{"notjson"' }, ctx);
  assert.equal(bad.ok, false);
  assert.match(bad.error.message, /not valid JSON/);
});
