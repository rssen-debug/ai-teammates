/**
 * V2 supervisor (master brief sections 7 + 19).
 *
 * Compiles a validated goal into a role-tagged TaskGraph. Roles are labels
 * (planner/executor/verifier/qa/researcher) — the same capable model may
 * stand behind several roles; the graph is what matters for ordering,
 * parallelism, and proof. This is the bridge from compiled goal -> DAG.
 */
import { TaskGraph } from '../runtime/dag.js';

export const ROLES = Object.freeze(['planner', 'researcher', 'executor', 'verifier', 'qa']);

/**
 * plan(compiledGoal, {goalId}) -> { graph, roles, planNotes }
 * Default template:
 *   planner: plan (dependencies: none)
 *   executor: build:<deliverable i> (deps: plan)
 *   verifier: verify:<acceptance.id> (deps: related build tasks)
 * The executor/verifier split mirrors brief 22 (verification stays independent).
 */
export function plan(compiledGoal, { goalId } = {}) {
  if (!goalId) throw new Error('plan requires goalId');
  if (!compiledGoal || !Array.isArray(compiledGoal.acceptance)) {
    throw new Error('plan requires a compiled goal with acceptance items');
  }
  const graph = new TaskGraph({ goalId });
  const roles = {};

  graph.addTask({ id: 'plan', action: 'plan', maxAttempts: 1 });
  roles.plan = 'planner';

  // one executor task per deliverable; keeps independent creation parallel (brief 21)
  const buildIds = [];
  compiledGoal.deliverables.forEach((deliverable, i) => {
    const id = `build:${i}`;
    graph.addTask({ id, action: `build_${deliverable}`, deps: ['plan'] });
    roles[id] = 'executor';
    buildIds.push(id);
  });

  // every acceptance item gets its own verification task depending on builds
  compiledGoal.acceptance.forEach((a) => {
    const id = `verify:${a.id}`;
    graph.addTask({ id, action: `verify_${a.id}`, deps: buildIds.length ? [...buildIds] : ['plan'], maxAttempts: 2 });
    roles[id] = 'verifier';
  });

  return {
    graph,
    roles,
    planNotes: {
      deliverableCount: compiledGoal.deliverables.length,
      acceptanceCount: compiledGoal.acceptance.length,
      strategy: 'plan -> parallel builds -> independent verifications',
      risk: compiledGoal.risk,
    },
  };
}
