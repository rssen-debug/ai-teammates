/**
 * V2 outer recovery loop (master brief sections 106-117): takes a failed
 * objective run and applies bounded recovery steps from the advisor until the
 * goal completes or the budget exhausts. Two step types are executable by the
 * framework itself (never silently): retry_simple (re-run identical inputs)
 * and replan (re-run with the failure context injected). Every attempt is
 * telemetry- and event-audited. Budget exhaustion -> honestly FAILED, with
 * the full attempt history returned.
 */
import { runObjective } from '../runtime/orchestrator.js';
import { recoveryPlan, nextRecoveryStep } from './advisor.js';

/**
 * runWithRecovery(objective, { failureClass, workspaceDir, adaptObjective, ...opts })
 * opts are passed through to runObjective (workspaceDir, provider, telemetry, ...).
 * adaptation: replan step injects the failure context automatically; caller may
 * override via adaptObjective(objective, {step, history}).
 */
export async function runWithRecovery(objective, { failureClass = 'UNKNOWN', adaptObjective = null, telemetry = null, events = null, ...objectiveOpts } = {}) {
  const plan = recoveryPlan(failureClass);
  const consumed = {};
  const history = [];

  let cur = objective;
  for (let guard = 0; guard < 8; guard += 1) {
    const res = await runObjective(cur, { telemetry, ...objectiveOpts });
    history.push({ objective: cur, state: res.goal.state, attempt: history.length + 1 });
    if (res.goal.state === 'COMPLETED') {
      return { finalState: 'COMPLETED', attempts: history.length, history, recovered: history.length > 1, lastResult: res };
    }

    const step = nextRecoveryStep(failureClass, consumed);
    if (!step) {
      telemetry?.append('goal.finish', { finalState: 'FAILED', tasks: history.length, done: 0, failed: history.length, receipts: 0 });
      return { finalState: 'FAILED', attempts: history.length, history, recovered: false, reason: `recovery budget exhausted for ${failureClass} (budget ${plan.totalBudget})`, lastResult: res };
    }
    consumed[step.step] = step.attempt;
    events?.emit('task.updated', { taskId: 'recovery', to: `step:${step.step}`, attempt: step.attempt });
    if (step.step === 'retry_simple') {
      cur = objective; // identical
    } else if (step.step === 'replan') {
      cur = adaptObjective
        ? adaptObjective(objective, { step, history })
        : `${objective}\n\n[RECOVERY CONTEXT: previous run ended ${history[history.length - 1].state} with ${history.length} attempt(s). Failure class ${failureClass}. Adjust plan accordingly; do not repeat the failing behavior.]`;
    } else {
      // steps like ask/pause_goal/install_dependency/alternate_tool need co-workers
      // (consent flow or new capabilities). We log the intent and stop honestly
      // rather than pretending they executed.
      return {
        finalState: 'BLOCKED',
        attempts: history.length,
        history,
        recovered: false,
        reason: `recovery step '${step.step}' needs the matching co-worker lane; stopping honestly instead of guessing (brief 62)`,
        lastResult: res,
      };
    }
  }
  return { finalState: 'FAILED', attempts: history.length, history, recovered: false, reason: 'guard limit hit (8 attempts) — this should not normally happen' };
}
