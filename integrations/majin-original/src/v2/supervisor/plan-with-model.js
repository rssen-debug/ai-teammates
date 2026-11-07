/**
 * V2 supervisor with a model planner (sections 7 + 19 + 4.2): the planner
 * role may propose subtask splits, but we keep TWO guard-rails it cannot
 * bypass: every acceptance item still gets its OWN verifier task created by
 * US from the compiled goal, and plan() falls back LOUDLY to the template if
 * the model fails or misbehaves.
 */
import { TaskGraph } from '../runtime/dag.js';
import { plan as templatePlan } from './supervisor.js';
import { roleCall } from './roles.js';

/**
 * planWithModel(compiledGoal, provider, {goalId}) -> { graph, roles, planNotes, meta }
 */
export async function planWithModel(compiledGoal, provider, { goalId }) {
  if (!goalId) throw new Error('planWithModel requires goalId');
  try {
    const prompt = `Objective: ${compiledGoal.objective}\nDeliverables: ${compiledGoal.deliverables.join(', ')}\nAcceptance ids (do not verify them yourself): ${compiledGoal.acceptance.map((a) => a.id).join(', ')}\nPropose executor subtasks that produce the deliverables. Do not include verification tasks.`;
    const { value } = await roleCall('planner', prompt, provider);
    const graph = new TaskGraph({ goalId });
    const roles = {};
    graph.addTask({ id: 'plan', action: 'plan', maxAttempts: 1 });
    roles.plan = 'planner';
    const buildIds = [];
    const executorTasks = (value.subtasks || []).filter((t) => t.role === 'executor').slice(0, 20);
    executorTasks.forEach((t, i) => {
      const id = `build:${i}`;
      graph.addTask({ id, action: `build_${t.action}`, deps: ['plan'], maxAttempts: 2 });
      roles[id] = 'executor';
      buildIds.push(id);
    });
    if (buildIds.length === 0) throw new Error('planner produced no executor subtasks');
    // acceptance verifiers: created by US ALWAYS, not the model (section 22 independence)
    compiledGoal.acceptance.forEach((a) => {
      const id = `verify:${a.id}`;
      graph.addTask({ id, action: `verify_${a.id}`, deps: [...buildIds], maxAttempts: 2 });
      roles[id] = 'verifier';
    });
    return { graph, roles, planNotes: { strategy: 'model-planner+v2-verifier', plannerNotes: value.notes }, meta: { source: 'model' } };
  } catch (err) {
    const tpl = templatePlan(compiledGoal, { goalId });
    tpl.meta = { source: 'template', fallbackFrom: err.cls || 'MODEL_FAILURE' };
    return tpl;
  }
}
