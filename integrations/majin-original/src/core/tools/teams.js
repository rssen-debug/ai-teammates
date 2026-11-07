/**
 * MAJIN W4 — team.tools: standing agent teams från agentytan.
 *
 * team.manage = roster + blackboard (persistent identitet / delat minne).
 * team.run    = kör mål-graf mot roster (budget + checkpoint + resume via
 *               runId). Execution legat i runSwarm;sidan — oförändrad.
 */
import { def } from './registry.js';
import { journal } from '../browser.js';
import { TeamStore, runTeam, TEAM_DEFAULTS, TeamInputError, TeamBudgetError } from '../teams.js';

function storeFor(ctx) {
  const ws = ctx.cfg.get('workspace') || process.cwd();
  return new TeamStore({ workspaceDir: ws });
}

const summarizeRun = (r) => `run ${r.runId}: ok=${r.okCount} fail=${r.failCount} blocked=${r.blockedCount} steps=${r.spent}/${r.teamStepCap} status=${r.status}${r.resumedFrom ? ` (resumed from ${r.resumedFrom}, skipped ${r.skipped.length} done node(s))` : ''}`;

export const teamTools = [
  def({
    name: 'team.manage',
    group: 'agent',
    risk: 'write',
    desc: 'W4 standing teams: handle roster (persistent identity per member), shared blackboard memory, and team/run status. Identity = stable member.id with role/instructions/tools-allowlist (pattern: openai/swarm Agent); memory = append-only blackboard every member reads (pattern: openai/swarm context_variables).',
    params: {
      action: 'string create|list|status|add|remove|note|board',
      team: 'string team name (lowercase a-z0-9-, max 40)',
      id: 'string: member id for add/remove',
      role: 'string: what this identity OWNS (required for add)',
      instructions: 'string optional: standing guidance for the member (max 2000)',
      tools: 'string optional: comma-separated tool allowlist for the member (empty = all)',
      maxSteps: 'string optional: per-member step budget (default ' + TEAM_DEFAULTS.maxStepsPerMember + ', max 64)',
      key: 'string: blackboard key for note/board',
      value: 'string: blackboard value for note',
      limit: 'string optional: max blackboard entries returned (default 50)',
    },
    examples: [
      'team.manage({action:"create", team:"webui"})',
      'team.manage({action:"add", team:"webui", id:"researcher", role:"find and verify facts", tools:"research.run,files.read"})',
      'team.manage({action:"note", team:"webui", id:"researcher", key:"finding:api", value:"endpoint is /v2 not /v1"})',
      'team.manage({action:"board", team:"webui", key:"finding:api"})',
    ],
    async run({ action, team, id, role, instructions, tools, maxSteps, key, value, limit }, ctx) {
      const session = ctx.session || 'default';
      const store = storeFor(ctx);
      const act = String(action || '').toLowerCase();
      journal.guard(session, `team.manage:${act}:${String(team || '').slice(0, 24)}`);
      if (act === 'list') return { ok: true, result: JSON.stringify(store.listTeams(), null, 2), summary: 'teams listed' };
      if (!team) return { ok: false, error: { code: 'bad_input', message: 'team is required' } };
      if (act === 'create') {
        const { created } = store.ensureTeam(team);
        return { ok: true, result: created ? `team "${team}" created at workspace/teams/${team}/` : `team "${team}" already exists — roster untouched`, summary: created ? 'created' : 'exists' };
      }
      if (act === 'status') {
        const r = store.getTeam(team);
        return { ok: true, result: JSON.stringify({ team: r.name, members: r.members, notes: store.board(team, { limit: 10 }).length }, null, 2), summary: `roster: ${r.members.length} member(s)` };
      }
      if (act === 'add') {
        if (!id) return { ok: false, error: { code: 'bad_input', message: 'id is required for add' } };
        if (!role) return { ok: false, error: { code: 'bad_input', message: 'role is required — what does this identity own?' } };
        const out = store.addMember(team, {
          id, role, instructions,
          tools: tools ? String(tools).split(',').map((s) => s.trim()).filter(Boolean) : null,
          maxSteps: maxSteps ? Number(maxSteps) : null,
        });
        store.note(team, 'team', `roster:${out.updated ? 'update' : 'add'}:${id}`, role);
        return { ok: true, result: `member "${id}" ${out.updated ? 'updated' : 'added'} — owns: ${role}`, summary: out.updated ? 'member updated' : 'member added' };
      }
      if (act === 'remove') {
        const out = store.removeMember(team, String(id || ''));
        return { ok: true, result: out.removed ? `member "${id}" removed` : `no such member "${id}"`, summary: out.removed ? 'removed' : 'noop' };
      }
      if (act === 'note') {
        if (!key) return { ok: false, error: { code: 'bad_input', message: 'key is required for note' } };
        const e = store.note(team, id || 'team', key, value ?? '');
        return { ok: true, result: JSON.stringify(e), summary: `board += ${key}` };
      }
      if (act === 'board') {
        return { ok: true, result: JSON.stringify(store.board(team, { key: key || null, limit: limit ? Number(limit) : 50 }), null, 2), summary: 'board read' };
      }
      return { ok: false, error: { code: 'bad_input', message: `unknown action "${action}" — create|list|status|add|remove|note|board` } };
    },
  }),

  def({
    name: 'team.run',
    group: 'agent',
    risk: 'exec',
    desc: 'W4: run a goal-graph against a standing team. goals = JSON array [{id, member, input, deps?, estMs?}]; each goal is owned by ONE member id from the roster. Enforces a global step budget LOUDLY (never silently truncates) and checkpoints after every node — crash + resume via resumeRunId means completed nodes are NEVER re-run (exactly-once for side effects).',
    params: {
      team: 'string team name',
      goals: 'string JSON: [{"id":"g1","member":"researcher","input":"task text","deps":["g0"],"estMs":3000}, ...]',
      cap: 'string optional: max parallel workers (default 4)',
      teamStepCap: 'string optional: global step budget for the whole run (default ' + TEAM_DEFAULTS.teamStepCap + ')',
      runId: 'string optional: stable id for this run (auto-generated if empty)',
      resumeRunId: 'string optional: resume this earlier run — checkpoint-loaded nodes are skipped with their stored results',
    },
    examples: ['team.run({team:"webui", goals:"[{\\"id\\":\\"g1\\",\\"member\\":\\"researcher\\",\\"input\\":\\"check the API version\\"}]"})'],
    async run({ team, goals, cap, teamStepCap, runId, resumeRunId }, ctx) {
      const session = ctx.session || 'default';
      const store = storeFor(ctx);
      journal.guard(session, `team.run:${String(team || '').slice(0, 24)}:${String(runId || resumeRunId || 'new').slice(0, 24)}`);
      if (!team) return { ok: false, error: { code: 'bad_input', message: 'team is required' } };
      let parsed;
      try { parsed = JSON.parse(String(goals || '[]')); } catch (e) { return { ok: false, error: { code: 'bad_input', message: `goals is not valid JSON: ${e.message}` } }; }
      try {
        const r = await runTeam({
          cfg: ctx.cfg, registry: ctx.registry, store, team: String(team), goals: parsed,
          cap: cap ? Math.max(1, Math.min(16, Number(cap) || 4)) : 4,
          teamStepCap: teamStepCap ? Number(teamStepCap) : TEAM_DEFAULTS.teamStepCap,
          runId: runId || null, resumeId: resumeRunId || null,
          emit: (e) => ctx.emit?.(e), job: 'tasks',
        });
        const rows = [];
        for (const [nid, res] of r.results.entries()) {
          if (res && res.ok === true) rows.push(`✓ ${nid}=${String(res.value?.text ?? res.value ?? '').slice(0, 120)}`);
          else if (res && res.ok === false) rows.push(`✗ ${nid} — ${res.error}`);
          else if (res && res.blocked) rows.push(`■ ${nid} blocked (${res.reason || res.by || ''})`);
        }
        return { ok: r.failCount === 0, result: summarizeRun(r) + '\n' + rows.join('\n'), summary: summarizeRun(r), meta: { runId: r.runId, status: r.status, spent: r.spent } };
      } catch (e) {
        const code = e instanceof TeamBudgetError ? 'budget_exceeded' : e instanceof TeamInputError ? 'bad_input' : 'team_run_failed';
        return { ok: false, error: { code, message: String(e.message || e) } };
      }
    },
  }),
];
