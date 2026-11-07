/**
 * MAJIN W4 — Standing agent teams.
 *
 * Cirkulära W4-krav som var INCOMPLETE: persistent identitet, delat minne,
 * budgetar, checkpoint, recovery. Den här modulen är det lagret — byggt på
 * verifierade primitiver som redan finns i repot (aldrig om-uppfunna):
 *
 *   - Execution: runSwarm + subagentWorker (src/core/swarm.js) — oförändrade.
 *   - Identitet: roster.json per team (workspace/teams/<team>/).
 *   - Delat minne: memory.jsonl blackboard — mönstret från openai/swarm
 *     (context_variables=Result-context, verifierat via absorb-scan
 *     openai/swarm @ e83d7ff, MIT); här append-only och kraschtåligt.
 *   - Budget: per-member maxSteps (subagentWorker) + global teamStepCap,
 *     överträdelse är HÖGLJUDD (TeamBudgetError), aldrig tyst trunkering.
 *   - Checkpoint/recovery: sparas FÖRE en nod rapporteras klar till
 *     runSwarm => crash mellan save och done-markering = resume hoppar över
 *     noden (exactly-once vid sida­effekter), crash före save = omkörning
 *     (at-least-once, samme kontrakt som W7 mission-recovery mätte).
 *
 * Behållare: TeamStore (rent state). Ingen modell anropas här.
 */

import fs from 'node:fs';
import path from 'node:path';
import { runSwarm, subagentWorker } from './swarm.js';

export const TEAMS_VERSION = 'majin-teams/1';

export const TEAM_DEFAULTS = {
  /** stegbud per member om rostern inte säger annat — samma golv som
      subagentWorker:s eget default så ett team aldrig hemligt ändrar hvanor */
  maxStepsPerMember: 8,
  /** globalt tak för HELA teamkörningen (summan av member-stegen) */
  teamStepCap: 40,
  /** blackboard digest-budget i tecken för subagent-minnet */
  digestChars: 900,
};

export class TeamInputError extends Error {
  constructor(msg, cause = null) { super(msg); this.name = 'TeamInputError'; this.cause = cause; }
}
/** Budgetöverträdelse är permanent för run:en — aldrig transient-retrybart. */
export class TeamBudgetError extends Error {
  constructor(msg, cause = null) { super(msg); this.name = 'TeamBudgetError'; this.cause = cause; }
}

const TEAM_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MEMBER_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const assertName = (n, re, kind) => {
  if (typeof n !== 'string' || !re.test(n)) throw new TeamInputError(`${kind}: "${n}" — lowercase a-z0-9- (max 40), must start with letter/digit`);
};

function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file); // rename = atomisk på samma volym: en läsare ser aldrig en halv fil
}

/* ------------------------------------------------------------------ */

export class TeamStore {
  constructor({ workspaceDir }) {
    if (!workspaceDir) throw new TeamInputError('TeamStore: workspaceDir is required');
    this.root = path.join(workspaceDir, 'teams');
  }
  teamDir(name) { assertName(name, TEAM_RE, 'team'); return path.join(this.root, name); }
  runDir(name, runId) { assertName(runId, TEAM_RE, 'runId'); return path.join(this.teamDir(name), 'runs', runId); }

  /** Skapa (eller öppna befintligt) team. Idempotent: roster skrivs bara om den saknas. */
  ensureTeam(name) {
    const dir = this.teamDir(name);
    const rosterFile = path.join(dir, 'roster.json');
    const created = !fs.existsSync(rosterFile);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
    if (created) {
      atomicWrite(rosterFile, JSON.stringify({ version: TEAMS_VERSION, name, members: [], createdAt: new Date().toISOString() }, null, 2) + '\n');
      fs.writeFileSync(path.join(dir, 'memory.jsonl'), '');
    }
    return { created, dir };
  }

  #loadRoster(name) {
    const file = path.join(this.teamDir(name), 'roster.json');
    if (!fs.existsSync(file)) return null;
    let j;
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new TeamInputError(`roster korrupt: ${file}: ${e.message}`); }
    if (!j || !Array.isArray(j.members)) throw new TeamInputError(`roster has no members[]: ${file}`);
    return j;
  }

  /** tom sträng om teamet saknas, annars roster-objektet */
  getTeam(name) { this.ensureTeam(name); return this.#loadRoster(name); }

  listTeams() {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(this.root, d.name, 'roster.json')))
      .map((d) => d.name).sort();
  }

  /**
   * Persistent identitet: upsert på member.id. En members roll/instruktioner
   * får växa över tid men id:t är stabilt — exakt openai/swarm:s Agent(name,
   * instructions, functions) överförd till filbaserad form.
   */
  addMember(name, { id, role, instructions = '', tools = null, maxSteps = null }) {
    assertName(id, MEMBER_RE, 'member.id');
    if (typeof role !== 'string' || !role.trim()) throw new TeamInputError('member.role: required (what does this identity own?)');
    const r = this.getTeam(name);
    const member = {
      id, role: role.trim(), instructions: String(instructions).slice(0, 2000),
      tools: tools === null ? null : (Array.isArray(tools) ? tools.map(String) : (() => { throw new TeamInputError('member.tools: array eller null') })()),
      maxSteps: maxSteps === null ? null : Math.max(1, Math.min(64, Number(maxSteps) || 1)),
      addedAt: new Date().toISOString(),
    };
    const idx = r.members.findIndex((m) => m.id === id);
    if (idx >= 0) { member.addedAt = r.members[idx].addedAt; member.updatedAt = new Date().toISOString(); r.members[idx] = member; }
    else r.members.push(member);
    atomicWrite(path.join(this.teamDir(name), 'roster.json'), JSON.stringify(r, null, 2) + '\n');
    return { updated: idx >= 0, member };
  }

  removeMember(name, id) {
    const r = this.getTeam(name);
    const idx = r.members.findIndex((m) => m.id === id);
    if (idx < 0) return { removed: false };
    r.members.splice(idx, 1);
    atomicWrite(path.join(this.teamDir(name), 'roster.json'), JSON.stringify(r, null, 2) + '\n');
    return { removed: true };
  }

  /* ---------------------------------------------------------------
   * Blackboard = delat minne (openai/swarm context_variables → append-only
   * jsonl). Nyckel/ värde + författare + tid. Läsningen är den enda formen
   * av koppling mellan members — inga dolda sidokanaler.
   * --------------------------------------------------------------- */
  note(team, author, key, value) {
    assertName(author === 'team' ? 'team' : author, MEMBER_RE, 'author');
    if (!key || typeof key !== 'string') throw new TeamInputError('note.key: required');
    this.ensureTeam(team);
    const entry = { t: new Date().toISOString(), author, key: key.slice(0, 120), value: String(value ?? '').slice(0, 4000) };
    fs.appendFileSync(path.join(this.teamDir(team), 'memory.jsonl'), JSON.stringify(entry) + '\n');
    return entry;
  }

  board(team, { key = null, limit = 50 } = {}) {
    this.ensureTeam(team);
    const file = path.join(this.teamDir(team), 'memory.jsonl');
    if (!fs.existsSync(file)) return [];
    const all = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const parsed = [];
    for (const line of all) {
      try { const e = JSON.parse(line); if (!key || e.key === key) parsed.push(e); } catch { /* en trasig rad döljer aldrig de andra */ }
    }
    return parsed.slice(-Math.max(1, Math.min(500, Number(limit) || 50)));
  }

  /** Komprimerad blackboard för injektion i subagent-minne (bundet). */
  digest(team, { chars = TEAM_DEFAULTS.digestChars } = {}) {
    const lines = this.board(team, { limit: 20 }).map((e) => `${e.author}:${e.key}=${e.value.slice(0, 130)}`);
    let out = lines.join('\n');
    return out.length > chars ? out.slice(0, chars) + '…[truncated]' : out;
  }

  /* ------------------------- checkpoint ------------------------- */

  saveCheckpoint(team, runId, state) {
    const dir = this.runDir(team, runId);
    fs.mkdirSync(dir, { recursive: true });
    atomicWrite(path.join(dir, 'checkpoint.json'), JSON.stringify({
      version: TEAMS_VERSION, status: state.status || 'running', updatedAt: new Date().toISOString(), ...state,
    }, null, 2) + '\n');
  }

  loadCheckpoint(team, runId) {
    const file = path.join(this.runDir(team, runId), 'checkpoint.json');
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new TeamInputError(`checkpoint korrupt: ${file}: ${e.message}`); }
  }
}

/* ------------------------------------------------------------------ */

/**
 * runTeam — kör en mål-graf mot ett standing team.
 *
 * goals: [{ id, member, input, deps?, estMs? }] — varje mål pekar ut EN
 * roster-member som äger det (persistent identitet: samma id återanvänds i
 * varje run; subagent-sessionen prefixas med team:run:member så spårbarhet
 * i journal/jobs tydligt visar VILKEN identitet som handlat).
 *
 * resumeId: om satt, laddas checkpoint och klara noder ALDRIG körs igen —
 * deras lagrade värde returneras rakt (exactly-once vid sidoeffekter).
 */
export async function runTeam({
  cfg, registry, store, team, cap = 4, goals,
  resumeId = null, runId = null, emit = null, memory = null, job = 'tasks',
  teamStepCap = TEAM_DEFAULTS.teamStepCap,
  signal = null,
  makeWorker = null, // injicerbart för tester: (...) => workerFn; default subagentWorker
} = {}) {
  if (!store || !(store instanceof TeamStore)) throw new TeamInputError('runTeam: store (TeamStore) is required');
  assertName(team, TEAM_RE, 'team');
  const roster = store.getTeam(team);
  if (!roster.members.length) throw new TeamInputError(`team "${team}": empty roster — addMember first`);
  if (!Array.isArray(goals) || !goals.length) throw new TeamInputError('runTeam: goals[] is required');

  const byMember = new Map(roster.members.map((m) => [m.id, m]));
  const rid = resumeId || runId || `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const resumedCp = resumeId ? store.loadCheckpoint(team, resumeId) : null;
  // Older checkpoints could contain failed worker values. Never upgrade those
  // to successful resume skips merely because an entry exists on disk.
  const priorDone = new Map(Object.entries((resumedCp && resumedCp.done) || {}).filter(([, value]) => value?.ok !== false));
  /** vilka noder som faktiskt hoppades över av resume (fryst vid laddning —
      priorDone växer under körning och får inte tala om det som "resumed") */
  const resumeSkips = new Set(priorDone.keys());
  if (resumeId && !resumedCp) throw new TeamInputError(`resume: no checkpoint "${resumeId}" for team "${team}"`);

  /* Budget-ockurence: globalt räknar REALA steg från worker-resultat
     (subagent rapporterar steps); lansering som skulle överskrida taket
     failar HÖGLJUDT med TeamBudgetError — aldrig tyst drop. */
  let spent = 0;
  const capN = Math.max(1, Number(teamStepCap) || TEAM_DEFAULTS.teamStepCap);

  const mkWorker = makeWorker || ((member, extra) => subagentWorker({
    cfg, registry, job, emit, memory: extra.memoryShim || memory,
    sessionPrefix: `team:${team}:${rid}:${member.id}`,
    maxSteps: member.maxSteps || TEAM_DEFAULTS.maxStepsPerMember,
  }));

  /* Bygg noder åt runSwarm. Varje nod.run:
     1. resume-hit → returnera lagrat värde UTAN att anropa workern (exactly-once)
     2. budget-check FÖRE lansering (den enda punkten där taket kan brottas)
     3. anrop + checkpoint-save FÖRE return (krasch-ordning) */
  const nodes = goals.map((g) => {
    if (!g || typeof g.id !== 'string' || !g.id) throw new TeamInputError('goal: id is required');
    const memberId = String(g.member || '');
    const member = byMember.get(memberId);
    if (!member) throw new TeamInputError(`goal "${g.id}": unknown member "${memberId}" — roster: ${[...byMember.keys()].join(', ')}`);
    const worker = mkWorker(member, { memoryShim: { digest: () => store.digest(team) } });
    return {
      id: g.id, deps: g.deps || [], estMs: g.estMs, input: g.input, goal: g.input,
      run: async (node, ctx) => {
        if (priorDone.has(node.id)) {
          emit?.({ type: 'worker_resumed_skip', id: node.id, by: 'checkpoint' });
          return priorDone.get(node.id);
        }
        if (spent >= capN) {
          /* permanent: runSwarm markerar noden ok:false, berörda efterföljare
             block-as — budgetbrott är ett besked, inte en cope-hide */
          throw new TeamBudgetError(`teamStepCap ${capN} reached (spent=${spent}) at launch of "${node.id}" — rerun with a new runId or raise the cap consciously`);
        }
        const value = await worker({ ...node, attempt: node.attempt }, ctx);
        spent += Number(value && value.steps) || 0;
        /* EN enda save, INNAN runSwarm får veta att noden är klar:
           crash efter save = resume-skip (exactly-once); crash före save =
           omkörning (at-least-once) — det är hela garantin. */
        if (value?.ok !== false && !signal?.aborted) priorDone.set(node.id, value);
        store.saveCheckpoint(team, rid, {
          status: 'running', runId: rid, goals: goals.map((x) => x.id), cap: capN, spent,
          done: Object.fromEntries(priorDone),
        });
        return value;
      },
    };
  });

  const out = await runSwarm({ nodes, cap, timeoutMs: 0, signal, onEvent: (e) => emit?.({ team, runId: rid, ...e }) });

  const st = out.blockedCount === 0 && out.failCount === 0 ? 'complete' : 'partial';
  store.saveCheckpoint(team, rid, {
    status: st, runId: rid, goals: goals.map((x) => x.id), cap: capN, spent,
    okCount: out.okCount, failCount: out.failCount, blockedCount: out.blockedCount, wallMs: out.wallMs,
    done: Object.fromEntries(priorDone),
  });

  return {
    runId: rid, resumedFrom: resumeId, skipped: resumeId ? goals.map((g) => g.id).filter((id) => resumeSkips.has(id)) : [],
    spent, teamStepCap: capN,
    results: out.results, wallMs: out.wallMs, okCount: out.okCount, failCount: out.failCount, blockedCount: out.blockedCount,
    adaptive: out.adaptive, status: st,
  };
}
