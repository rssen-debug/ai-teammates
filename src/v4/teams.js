/**
 * MAJIN V4 — standing agent teams.
 *
 * The architect's critique was concrete: V1 had `team.manage` / `team.run` with
 * a persistent roster, per-member identity, a shared blackboard, a step budget
 * and resumable runs; V4 had only `agent_delegate` (two subagents per turn, one
 * level deep). That is not equivalence, and pretending otherwise would be the
 * kind of claim this project exists to avoid.
 *
 * The fix is not a new team runtime. V1's `runTeam` already accepts a
 * **`makeWorker`** injection — that seam is why this module can reuse the whole
 * proven layer verbatim:
 *
 *   roster + blackboard + checkpoint   src/core/teams.js  (TeamStore, unchanged)
 *   DAG execution (critical path,
 *   adaptive width, blocked
 *   propagation, retries)              src/core/swarm.js   (runSwarm, unchanged)
 *   resume with exactly-once skips     src/core/teams.js  (runTeam, unchanged)
 *   the actual work                    V4 runSubtask — V4's model, registry,
 *                                      approval policy and receipts
 *
 * A team member is therefore a bounded V4 subagent wearing a persistent
 * identity, and the team's execution graph is the one V1 already tested.
 * Nothing here calls V1's own agent loop.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { TeamStore, runTeam, TEAM_DEFAULTS, TeamInputError, TeamBudgetError } from '../core/teams.js';

/** Explicit allowlist for a member; null means "all tools except delegation". */
export function normaliseMemberTools(list) {
  if (list == null) return null;
  const items = Array.isArray(list) ? list : String(list).split(',');
  return items.map((s) => String(s).trim()).filter(Boolean).slice(0, 24);
}

/**
 * The V4 worker `runTeam` calls for one member.
 *
 * The returned value must carry `steps`: V1 counts the real cost of a run
 * against `teamStepCap`, and a worker that reports nothing would make the
 * budget decorative.
 */
export function makeV4Worker({ runSubtask, turn, team, digest, budget = null, completed = new Map() }) {
  return (member) => async (node) => {
    const need = Math.max(1, Math.min(5, Number(member.maxSteps) || TEAM_DEFAULTS.maxStepsPerMember));
    /**
     * V1's runTeam checks the cap at launch, which two nodes starting in the
     * same tick both pass — a parallel burst could spend more than the cap
     * (measured: cap 1, spent 2). The worker is V4's, so the reservation lives
     * here: reserve the worst case BEFORE the first await, so the sum of
     * in-flight reservations can never exceed the cap, and release whatever the
     * run did not use afterwards.
     */
    if (budget) {
      if (budget.spent + budget.reserved + need > budget.cap) {
        throw new TeamBudgetError(
          `teamStepCap ${budget.cap} would be exceeded by "${node.id}" `
          + `(spent=${budget.spent}, reserved=${budget.reserved}, needs=${need}) — `
          + 'resume with a new runId or raise the cap consciously',
        );
      }
      budget.reserved += need;
    }
    let out;
    try {
      out = await runSubtask({
        task: String(node.input || node.goal || node.id) + (node.deps?.length
          ? `\n\nDependency results:\n${node.deps.map((id) => `[${id}] ${String(completed.get(id)?.text || '').slice(0, 1000)}`).join('\n')}`
          : ''),
        tools: normaliseMemberTools(member.tools),
        maxRounds: need,
        maxCalls: need,
        instructions: member.instructions || member.role || '',
        digest,
        turn,
        countsAgainstCap: false,
      });
    } finally {
      if (budget) budget.reserved -= need;
    }
    const steps = Math.max(1, out.calls || 0);
    if (budget) budget.spent += steps;
    const result = {
      ok: !out.failure,
      text: out.answer,
      tools: out.tools,
      steps,
      ...(out.failure ? { error: out.failure } : {}),
      member: member.id,
      team,
      artifacts: out.artifacts || [],
    };
    if (result.ok) completed.set(node.id, result);
    return result;
  };
}

/** The on-disk view of a team: roster, newest board entries, recent runs. */
export function describeTeam({ workspaceDir, team }) {
  const store = new TeamStore({ workspaceDir });
  const roster = store.getTeam(team);
  let runs = [];
  try {
    const dir = path.join(workspaceDir, 'teams', team, 'runs');
    runs = fs.readdirSync(dir)
      .map((id) => {
        try {
          return { id, ...JSON.parse(fs.readFileSync(path.join(dir, id, 'checkpoint.json'), 'utf8')) };
        } catch {
          return { id, status: 'unknown' };
        }
      })
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, 10);
  } catch {
    runs = [];
  }
  return { team, members: roster.members, board: store.board(team, { limit: 50 }), runs };
}

const TEAM = z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9-]*$/);

/**
 * The two tools, built around the reused store and runner.
 *
 * `runSubtask` is V4's bounded subagent loop, so a team member inherits the
 * parent turn's approval policy, cancellation signal and receipts. It cannot
 * approve anything a direct call could not.
 */
export function createTeamTools({ workspaceDir, runSubtask }) {
  const store = new TeamStore({ workspaceDir });

  const team_manage = {
    name: 'team_manage',
    description:
      'Standing agent team on disk: create, list, add/remove members (persistent identity with a role, '
      + 'instructions and an optional tool allowlist), read/write the shared blackboard, show a team or '
      + 'its runs. The roster and blackboard survive restarts. Run work with team_run.',
    // Writes the roster/board on disk, but only inside the workspace, and the
    // work it launches carries its own approvals (see team_run).
    tier: 'write',
    inputSchema: z.object({
      action: z.enum(['create', 'list', 'add', 'remove', 'note', 'board', 'status']),
      team: TEAM.optional(),
      id: z.string().min(1).max(40).optional(),
      role: z.string().min(1).max(400).optional(),
      instructions: z.string().max(2000).optional(),
      tools: z.array(z.string().min(1).max(80)).max(24).optional(),
      maxSteps: z.number().int().min(1).max(64).optional(),
      key: z.string().min(1).max(120).optional(),
      value: z.string().max(4000).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    outputSchema: z.object({
      ok: z.literal(true),
      action: z.string(),
      teams: z.array(z.string()).optional(),
      team: z.string().optional(),
      member: z.unknown().optional(),
      members: z.array(z.unknown()).optional(),
      board: z.array(z.unknown()).optional(),
      runs: z.array(z.unknown()).optional(),
      entry: z.unknown().optional(),
      removed: z.boolean().optional(),
      created: z.boolean().optional(),
      updated: z.boolean().optional(),
    }),
    execute: async (input = {}) => {
      const { action, team, id, role, instructions, tools: memberTools, maxSteps, key, value, limit } = input;
      try {
        if (action === 'list') {
          return { ok: true, action, teams: store.listTeams() };
        }
        if (!team) throw new TeamInputError('team is required for every action except list');
        if (action === 'create') {
          const { created } = store.ensureTeam(team);
          return { ok: true, action, team, created };
        }
        if (action === 'add') {
          if (!id) throw new TeamInputError('id is required to add a member');
          if (!role) throw new TeamInputError('role is required: what does this identity own?');
          const { member, updated } = store.addMember(team, {
            id,
            role,
            instructions: instructions || '',
            tools: memberTools ? memberTools : null,
            maxSteps: maxSteps || null,
          });
          return { ok: true, action, team, member, updated };
        }
        if (action === 'remove') {
          if (!id) throw new TeamInputError('id is required to remove a member');
          const { removed } = store.removeMember(team, id);
          return { ok: true, action, team, removed };
        }
        if (action === 'note') {
          if (!key) throw new TeamInputError('key is required for a blackboard note');
          const entry = store.note(team, id || 'team', key, value ?? '');
          return { ok: true, action, team, entry };
        }
        if (action === 'board') {
          return { ok: true, action, team, board: store.board(team, { key: key || null, limit: limit || 50 }) };
        }
        // status
        const view = describeTeam({ workspaceDir, team });
        return { ok: true, action: 'status', team, members: view.members, board: view.board, runs: view.runs };
      } catch (err) {
        if (err instanceof TeamInputError) {
          throw Object.assign(new Error(err.message), { cls: 'INVALID_TOOL_INPUT' });
        }
        throw err;
      }
    },
  };

  const team_run = {
    name: 'team_run',
    description:
      'Run a goal graph against a standing team. Each goal names the member who owns it and may depend '
      + 'on earlier goals; independent goals run in parallel up to cap. Members are run by V4 with their '
      + 'own bounded step budget; every node is checkpointed before it is reported done, so a run can be '
      + 'resumed by runId without repeating finished work. Returns per-node results, cost and status.',
    // The container performs no side effect of its own: each member's calls go
    // through the same approval policy as a direct call.
    tier: 'read',
    inputSchema: z.object({
      team: TEAM,
      goals: z.array(z.object({
        id: z.string().min(1).max(60),
        member: z.string().min(1).max(40),
        input: z.string().min(1).max(4000),
        deps: z.array(z.string().min(1).max(60)).max(20).optional(),
      })).min(1).max(20),
      cap: z.number().int().min(1).max(8).optional(),
      teamStepCap: z.number().int().min(1).max(200).optional(),
      resumeId: z.string().min(1).max(60).optional(),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      team: z.string(),
      runId: z.string(),
      status: z.string(),
      okCount: z.number(),
      failCount: z.number(),
      blockedCount: z.number(),
      spent: z.number(),
      teamStepCap: z.number(),
      skipped: z.array(z.string()),
      results: z.unknown(),
      artifacts: z.array(z.unknown()).optional(),
    }),
    execute: async ({ team, goals, cap = 4, teamStepCap = TEAM_DEFAULTS.teamStepCap, resumeId = null }) => {
      const { turnState } = await import('./turn-state.js');
      const st = turnState();
      if (!st) throw Object.assign(new Error('team_run can only run inside a turn'), { cls: 'INVALID_TOOL_INPUT' });
      if ((st.depth || 0) >= 1) {
        throw Object.assign(new Error('a subagent or team member cannot start another team run'), { cls: 'PERMISSION_DENIED' });
      }
      const digest = store.digest(team);
      // One budget object per run: V4's worker reserves against it before the
      // first await, so a parallel launch cannot overshoot the cap.
      const budget = { cap: Number(teamStepCap) || TEAM_DEFAULTS.teamStepCap, reserved: 0, spent: 0 };
      const completed = new Map(Object.entries(resumeId ? store.loadCheckpoint(team, resumeId)?.done || {} : {}));
      const out = await runTeam({
        store,
        team,
        goals,
        cap,
        teamStepCap,
        resumeId,
        signal: st.signal || null,
        emit: (e) => {
          try {
            st.emit?.('team', { team, runId: e.runId || null, type: e.type, node: e.id || null });
          } catch { /* a broken listener must not fail the run */ }
        },
        makeWorker: (member) => makeV4Worker({
          runSubtask,
          turn: st,
          team,
          digest,
          budget,
          completed,
        })(member),
      });
      const okCount = Number(out.okCount || 0);
      const failCount = Number(out.failCount || 0);
      const blockedCount = Number(out.blockedCount || 0);
      return {
        ok: failCount === 0 && blockedCount === 0,
        team,
        runId: out.runId,
        status: out.status,
        okCount,
        failCount,
        blockedCount,
        spent: Number(out.spent || 0),
        teamStepCap: Number(out.teamStepCap || teamStepCap),
        skipped: out.skipped || [],
        results: out.results,
        artifacts: [...completed.values()].flatMap((value) => value.artifacts || []),
      };
    },
  };

  return [team_manage, team_run];
}

export { TeamStore, runTeam, TEAM_DEFAULTS, TeamInputError, TeamBudgetError };
