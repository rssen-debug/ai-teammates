/**
 * MAJIN V4 — multi-step work as a dependency graph.
 *
 * The architect's second point: V2 has a task DAG, a scheduler with retries and
 * blocked-descendant propagation, and an orchestrator; V4 used a single flat
 * turn with bounded delegation. For work that is genuinely parallel — "read
 * these three files, then write one summary from all of them" — a flat loop is
 * the wrong shape.
 *
 * This module reuses V2's proven pieces unchanged:
 *
 *   graph model, cycles, ready set, failure propagation   src/v2/runtime/dag.js
 *   concurrency, retries, receipts per task, blocked      src/v2/runtime/scheduler.js
 *   the goal + receipts the scheduler writes into         src/v2/runtime/goal.js
 *
 * and supplies only the leaf executor: V4's bounded subagent. So every node is
 * a real V4 run with the owner's approval policy, and every node's outcome is a
 * receipt on a goal rather than a sentence in the transcript.
 *
 * The graph goal is deliberately a CHILD goal: the parent is inside this tool
 * call (WAITING_FOR_TOOL), where V2 does not accept receipts. Verified artifacts
 * are lifted onto the parent by the agent, exactly like delegation.
 */
import { z } from 'zod';
import { Goal } from '../v2/runtime/goal.js';
import { STATES } from '../v2/runtime/states.js';
import { TaskGraph, TASK_STATES, CycleError } from '../v2/runtime/dag.js';
import { runGraph } from '../v2/runtime/scheduler.js';

/**
 * Turn a list of planned steps into V2's TaskGraph.
 *
 * Kept separate from execution so the shape is testable on its own: a plan with
 * a cycle or a missing dependency must fail before a single model call.
 */
export function buildGraph({ goalId, steps, concurrency }) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('steps must be a non-empty array');
  const graph = new TaskGraph({ goalId, failurePolicy: 'block' });
  for (const step of steps) {
    if (!step?.id) throw new Error('every step needs an id');
    graph.addTask({
      id: String(step.id),
      action: String(step.task || step.action || step.id).slice(0, 200),
      deps: Array.isArray(step.deps) ? step.deps.map(String) : [],
      maxAttempts: Math.max(1, Math.min(3, Number(step.attempts) || 1)),
    });
  }
  void concurrency;
  return graph;
}

export function createGraphTool({ runSubtask }) {
  return {
    name: 'agent_graph',
    description:
      'Run a small dependency graph of sub-tasks instead of doing everything in one thread. Each step '
      + 'is a bounded subagent run with its own tools; steps with no dependency between them run in '
      + 'parallel, dependents wait, and a failed step blocks only its descendants. Every step leaves a '
      + 'receipt. Use it for work that is genuinely parallel (analyse several inputs, then combine).',
    // The container performs no side effect: every leaf sub-task runs through
    // the same approval policy as a direct call, so authority stays with the
    // leaves (same rule as agent_delegate).
    tier: 'read',
    inputSchema: z.object({
      steps: z.array(z.object({
        id: z.string().min(1).max(60),
        task: z.string().min(3).max(4000),
        deps: z.array(z.string().min(1).max(60)).max(20).optional(),
        tools: z.array(z.string().min(1).max(80)).max(20).optional(),
        attempts: z.number().int().min(1).max(3).optional(),
      })).min(1).max(12),
      concurrency: z.number().int().min(1).max(4).optional(),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      total: z.number(),
      done: z.number(),
      failed: z.number(),
      blocked: z.number(),
      results: z.array(z.object({
        id: z.string(),
        state: z.string(),
        answer: z.string(),
        tools: z.array(z.string()),
        error: z.string().optional(),
      })),
      artifacts: z.array(z.object({
        fileName: z.string(),
        acceptanceId: z.string(),
        evidence: z.unknown(),
      })).optional(),
    }),
    execute: async ({ steps, concurrency = 2 }) => {
      const { turnState } = await import('./turn-state.js');
      const st = turnState();
      if (!st) throw Object.assign(new Error('agent_graph can only run inside a turn'), { cls: 'INVALID_TOOL_INPUT' });
      if ((st.depth || 0) >= 1) {
        throw Object.assign(new Error('a subagent cannot start a graph'), { cls: 'PERMISSION_DENIED' });
      }

      // The graph's own goal: receipts and blocked states belong here, not on
      // the parent, which is mid-call.
      const graphGoal = new Goal({
        objective: `graph: ${steps.map((s) => s.id).join(' → ')}`.slice(0, 400),
        acceptance: [],
        risk: 'low',
        permissions: [],
        budgets: {},
      });
      graphGoal.transition(STATES.PLANNING, 'graph accepted');
      graphGoal.transition(STATES.READY, 'graph ready');
      graphGoal.transition(STATES.RUNNING, 'graph running');

      let graph;
      try {
        graph = buildGraph({ goalId: graphGoal.id, steps });
      } catch (err) {
        const cls = err instanceof CycleError ? 'INVALID_TOOL_INPUT' : 'INVALID_TOOL_INPUT';
        throw Object.assign(new Error(`plan rejected: ${err.message}`), { cls });
      }

      const byId = new Map(steps.map((s) => [String(s.id), s]));
      const answers = new Map();
      const artifacts = [];

      const outcome = await runGraph({
        goal: graphGoal,
        graph,
        concurrency: Math.max(1, Math.min(4, Number(concurrency) || 2)),
        signal: st.signal || null,
        onEvent: (e) => {
          try {
            st.emit?.('graph', { type: e.type, taskId: e.taskId || null });
          } catch { /* a broken listener must not fail the run */ }
        },
        execute: async (task) => {
          const spec = byId.get(task.id) || {};
          // Earlier steps' answers are given to later steps: that is what makes
          // a graph different from three unrelated subagents.
          const prior = [...answers.entries()]
            .map(([id, value]) => `[${id}] ${String(value).slice(0, 700)}`)
            .join('\n');
          const taskText = prior
            ? `${spec.task}\n\nResults from earlier steps in this graph:\n${prior}`
            : spec.task;
          const out = await runSubtask({
            task: taskText,
            tools: spec.tools || null,
            maxRounds: 3,
            turn: st,
            countsAgainstCap: false,
          });
          if (out.answer) answers.set(task.id, out.answer);
          for (const artifact of out.artifacts || []) artifacts.push(artifact);
          if (out.failure) {
            task.error = String(out.failure).slice(0, 2000);
            return { result: 'failure', error: { message: out.failure, cls: 'TOOL_FAILURE' } };
          }
          return {
            result: 'success',
            target: task.id,
            evidence: {
              answerChars: String(out.answer || '').length,
              tools: out.tools,
              ...(out.failure ? { warning: out.failure } : {}),
            },
          };
        },
      });

      const results = [...graph.tasks.values()].map((task) => {
        const stored = [...(graphGoal.receipts || [])].reverse().find((r) => r.taskId === task.id);
        return {
          id: task.id,
          state: task.state,
          answer: String(answers.get(task.id) || ''),
          tools: Array.isArray(stored?.evidence?.tools) ? stored.evidence.tools : [],
          ...(task.error ? { error: String(task.error) } : task.state === TASK_STATES.FAILED ? { error: stored?.errorClass || 'failed' } : {}),
        };
      });

      return {
        ok: outcome.summary.failed === 0 && outcome.summary.blocked === 0,
        total: outcome.summary.total,
        done: outcome.summary.done,
        failed: outcome.summary.failed,
        blocked: outcome.summary.blocked,
        results,
        ...(artifacts.length ? { artifacts } : {}),
      };
    },
  };
}
