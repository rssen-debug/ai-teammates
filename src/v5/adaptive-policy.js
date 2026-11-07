import { z } from 'zod';
import { TaskGraph, TASK_STATES } from '../v2/runtime/dag.js';

/** Host policy: cheap decisions from observed state, never a second classifier model. */
export function ensureAdaptiveState(goal) {
  const state = goal.adaptive ||= {};
  state.version ??= 1;
  state.plan ??= [];
  state.transitions ??= [];
  state.observedHistory ??= [];
  state.planRevision ??= 0;
  state.steeringRevision ??= 0;
  state.needsReplan ??= false;
  return state;
}

const STOPWORDS = new Set(('the and for with from into this that then after before please make create write read use file files task goal verify ' +
  '\u{6f}\u{63}\u{68}\u{20}\u{61}\u{74}\u{74}\u{20}\u{64}\u{65}\u{74}\u{20}\u{64}\u{65}\u{6e}\u{20}\u{6d}\u{65}\u{64}\u{20}\u{74}\u{69}\u{6c}\u{6c}\u{20}\u{66}\u{72}\u{61}\u{6e}\u{20}\u{66}\u{72}\u{e5}\u{6e}\u{20}\u{64}\u{65}\u{74}\u{74}\u{61}\u{20}\u{73}\u{65}\u{64}\u{61}\u{6e}\u{20}\u{65}\u{66}\u{74}\u{65}\u{72}\u{20}\u{69}\u{6e}\u{6e}\u{61}\u{6e}\u{20}\u{73}\u{6b}\u{61}\u{70}\u{61}\u{20}\u{73}\u{6b}\u{72}\u{69}\u{76}\u{20}\u{6c}\u{e4}\u{73}\u{20}\u{61}\u{6e}\u{76}\u{e4}\u{6e}\u{64}\u{20}\u{66}\u{69}\u{6c}\u{20}\u{66}\u{69}\u{6c}\u{65}\u{72}\u{20}\u{75}\u{70}\u{70}\u{67}\u{69}\u{66}\u{74}\u{20}\u{76}\u{65}\u{72}\u{69}\u{66}\u{69}\u{65}\u{72}\u{61}').split(' '));
const tokens = text => [...new Set(String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 2 && !STOPWORDS.has(word)))];

export function readyAdaptiveSteps(state) {
  const plan = state?.plan || [];
  return plan.filter(step => step.state === 'PENDING' && step.dependsOn.every(id => plan.find(other => other.id === id)?.state === 'OBSERVED'));
}

export function chooseAdaptiveMode({ objective = '', criteria = [], procedures = [], adaptiveState = {} } = {}) {
  const ready = readyAdaptiveSteps(adaptiveState);
  const decision = (mode, reason, extra = {}) => ({ mode, reason, readyStepIds: ready.map(step => step.id), ...extra });
  if (adaptiveState.recoveryPending || Number(adaptiveState.unresolvedVerificationFailures || 0) > 0)
    return decision('recover', 'An observed failure remains unresolved; inspect evidence and change strategy.');
  if (adaptiveState.needsReplan) return decision('plan', 'Owner steering changed the task; revise pending work while preserving observed work.');
  if (adaptiveState.plan?.some(step => step.state === 'FAILED'))
    return decision('recover', 'A planned step failed; inspect its observations before retrying or revising the plan.');
  const independent = ready.filter(step => step.independent && step.delegateable);
  if (independent.length >= 2)
    return decision('delegate', 'At least two ready steps explicitly declare independent delegation; use bounded read-only workers.', { delegateStepIds: independent.map(step => step.id) });
  if (adaptiveState.plan?.some(step => step.state !== 'OBSERVED'))
    return decision('plan', 'Continue the saved dependency plan from its ready steps.');
  const words = tokens(objective);
  const match = procedures.filter(proc => proc.verifiedUses > 0).map(proc => ({ proc,
    overlap: words.filter(word => tokens([proc.summary, proc.canonicalSkillId, ...(proc.keywords || [])].join(' ')).includes(word)).length,
  })).filter(item => item.overlap > 0).sort((a, b) => b.overlap - a.overlap)[0];
  if (match) return decision('skill', 'A currently eligible, previously verified procedure matches this objective; inspect and adapt it.', { procedureName: match.proc.name || match.proc.procedureId });
  const outcomes = new Set(criteria.map((check, index) => check.path || check.pngPath || check.url || (check.kind === 'memory' ? `${check.memoryKind}:${check.key}` : `unknown-${index}`)));
  if (!adaptiveState.plan?.length && (outcomes.size > 1 || /\b(?:then|after|before|first|sedan|därefter|först)\b|(?:^|\n)\s*\d+[.)]/i.test(objective)))
    return decision('plan', 'The objective has multiple acceptance outcomes or an explicit sequence; track dependencies.');
  return decision('direct', 'No unresolved failure, dependency plan or matching procedure requires coordination.');
}

export function recordAdaptiveTransition(goal, decision) {
  const state = ensureAdaptiveState(goal);
  const previous = state.transitions.at(-1);
  state.mode = decision.mode; state.reason = decision.reason;
  if (previous?.mode !== decision.mode || previous?.reason !== decision.reason) {
    state.transitions.push({ mode: decision.mode, reason: decision.reason, at: new Date().toISOString() });
    state.transitions = state.transitions.slice(-64);
  }
  return state;
}

export function markAdaptiveSteering(goal) {
  const state = ensureAdaptiveState(goal);
  state.needsReplan = true; state.steeringRevision++;
  return state;
}

const id = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
const stepSchema = z.object({ id, task: z.string().min(1).max(2000), dependsOn: z.array(id).max(24).default([]),
  independent: z.boolean().default(false), delegateable: z.boolean().default(false) }).strict();

function validatePlan(goalId, steps) {
  const ids = new Set(steps.map(step => step.id));
  if (ids.size !== steps.length) throw new Error('Plan step IDs must be unique');
  if (steps.some(step => step.dependsOn.some(dep => !ids.has(dep)))) throw new Error('Plan dependency references an unknown step');
  // TaskGraph is the existing DAG engine. Feed it a topological order because
  // its addTask contract requires dependencies to have already been added.
  const graph = new TaskGraph({ goalId });
  const pending = [...steps];
  while (pending.length) {
    const index = pending.findIndex(step => step.dependsOn.every(dep => graph.tasks.has(dep)));
    if (index < 0) throw new Error('Plan contains a dependency cycle');
    const [step] = pending.splice(index, 1);
    graph.addTask({ id: step.id, action: step.task, deps: step.dependsOn });
  }
  return graph;
}

const sameDefinition = (a, b) => a?.task === b.task && JSON.stringify(a.dependsOn) === JSON.stringify(b.dependsOn);
const isWorkObservation = observation => observation.operationId && !/^(agent_|procedures_|skills_)/.test(observation.tool) && observation.tool !== 'driver_status';

/** Plan progress records tool observations, never independently verified success. */
export function createAdaptiveTools({ goal, onCheckpoint = () => {} }) {
  const map = new Map();
  const add = (name, description, schema, run) => map.set(name, {
    name, description, inputSchema: z.toJSONSchema(schema), run: args => run(schema.parse(args)),
  });
  add('agent_plan', 'Save or revise a dependency plan. Declare only genuinely independent work delegateable. Observed unchanged steps survive revisions; final success still requires independent acceptance checks.',
    z.object({ steps: z.array(stepSchema).min(1).max(24) }).strict(), ({ steps }) => {
      const graph = validatePlan(goal.goal_id, steps);
      const state = ensureAdaptiveState(goal);
      const prior = new Map(state.plan.map(step => [step.id, step]));
      const preserved = new Set();
      for (const task of graph.tasks.values()) {
        const step = steps.find(item => item.id === task.id), old = prior.get(step.id);
        if (old?.state === 'OBSERVED' && sameDefinition(old, step) && step.dependsOn.every(dep => preserved.has(dep))) preserved.add(step.id);
      }
      for (const old of state.plan.filter(step => step.state === 'OBSERVED' && !preserved.has(step.id))) {
        state.observedHistory.push({ ...structuredClone(old), planRevision: state.planRevision });
      }
      state.observedHistory = state.observedHistory.slice(-128);
      state.plan = steps.map(step => ({ ...step, state: preserved.has(step.id) ? 'OBSERVED' : 'PENDING',
        attempts: sameDefinition(prior.get(step.id), step) ? prior.get(step.id).attempts || 0 : 0,
        operationIds: preserved.has(step.id) ? [...prior.get(step.id).operationIds] : [],
      }));
      state.planRevision++; state.needsReplan = false;
      onCheckpoint();
      return { planRevision: state.planRevision, plan: structuredClone(state.plan), readyStepIds: readyAdaptiveSteps(state).map(step => step.id), independentlyVerified: false };
    });
  add('agent_checkpoint', 'Record a plan step using host-observed operation IDs. OBSERVED requires successful work tools; FAILED requires failed work tools. Neither means the whole task passed its acceptance checks. Retry a failed step with PENDING; attempts are bounded.',
    z.object({ stepId: id, state: z.enum(['PENDING', 'RUNNING', 'OBSERVED', 'FAILED']), operationIds: z.array(z.string().min(1).max(200)).max(32).default([]) }).strict(), args => {
      const state = ensureAdaptiveState(goal);
      if (state.needsReplan) throw new Error('Revise the plan after steering before recording new progress');
      const step = state.plan.find(item => item.id === args.stepId);
      if (!step) throw new Error('Unknown plan step');
      if (step.state === 'OBSERVED') {
        if (args.state !== 'OBSERVED' || JSON.stringify(args.operationIds) !== JSON.stringify(step.operationIds)) throw new Error('Observed work cannot be reset; revise the plan for changed work');
        return { step: structuredClone(step), independentlyVerified: false };
      }
      if (!step.dependsOn.every(dep => state.plan.find(item => item.id === dep)?.state === 'OBSERVED')) throw new Error('Plan dependencies have not been observed');
      if (args.state === 'PENDING' && !['FAILED', 'RUNNING'].includes(step.state)) throw new Error('Only a failed or interrupted running step can be retried');
      if (['RUNNING', 'OBSERVED', 'FAILED'].includes(args.state) && step.state !== 'RUNNING' && step.attempts >= 3) throw new Error('Plan step retry limit reached; revise the strategy');
      if (['OBSERVED', 'FAILED'].includes(args.state)) {
        if (!args.operationIds.length) throw new Error('Checkpoint requires actual tool operation IDs');
        for (const operationId of args.operationIds) {
          const observation = (goal.tool_results || []).find(item => item.operationId === operationId && isWorkObservation(item));
          if (!observation || observation.ok !== (args.state === 'OBSERVED')) throw new Error('Checkpoint references missing or mismatched tool evidence');
        }
      } else if (args.operationIds.length) throw new Error('Pending/running checkpoints cannot claim observations');
      const graph = validatePlan(goal.goal_id, state.plan);
      for (const item of state.plan) graph.markState(item.id, item.state === 'OBSERVED' ? TASK_STATES.DONE : TASK_STATES.PENDING);
      if (step.state === 'PENDING' && !graph.readySet().includes(step.id)) throw new Error('Plan step is not ready');
      if (['RUNNING', 'OBSERVED', 'FAILED'].includes(args.state) && step.state !== 'RUNNING') step.attempts++;
      step.state = args.state; step.operationIds = [...new Set(args.operationIds)];
      onCheckpoint();
      return { step: structuredClone(step), readyStepIds: readyAdaptiveSteps(state).map(item => item.id), independentlyVerified: false };
    });
  return map;
}
