/**
 * V2 recovery advisor (master brief sections 106-117).
 * Maps failure class -> ordered, bounded recovery plan. Steps not listed get
 * the honest generic plan: replan with the failure context. No class may map
 * to "retry forever"; every plan is finite by construction.
 */
const PLANS = {
  TIMEOUT:              [ { step: 'retry_simple', maxAttempts: 1 }, { step: 'split_scope', maxAttempts: 1 }, { step: 'replan', maxAttempts: 2 } ],
  AUTH_REQUIRED:        [ { step: 'ask', maxAttempts: 1 }, { step: 'pause_goal', maxAttempts: 1 } ],
  PERMISSION_DENIED:    [ { step: 'escalate', maxAttempts: 1 }, { step: 'pause_goal', maxAttempts: 1 } ],
  DEPENDENCY_MISSING:   [ { step: 'install_dependency', maxAttempts: 1 }, { step: 'alternate_tool', maxAttempts: 1 } ],
  ELEMENT_NOT_FOUND:    [ { step: 'refresh_ui_map', maxAttempts: 1 }, { step: 'replan', maxAttempts: 2 } ],
  ELEMENT_OBSCURED:     [ { step: 'refocus_or_dismiss', maxAttempts: 1 }, { step: 'replan', maxAttempts: 1 } ],
  WINDOW_NOT_FOUND:     [ { step: 'reopen_or_retarget', maxAttempts: 1 }, { step: 'replan', maxAttempts: 1 } ],
  PROCESS_CRASH:        [ { step: 'restart_process', maxAttempts: 1 }, { step: 'replan', maxAttempts: 1 } ],
  MODEL_FAILURE:        [ { step: 'retry_backoff', maxAttempts: 1 }, { step: 'alternate_model', maxAttempts: 1 } ],
  MODEL_RATE_LIMIT:     [ { step: 'retry_backoff', maxAttempts: 2 } ],
  MODEL_CONTEXT_LIMIT:  [ { step: 'compress_context', maxAttempts: 1 }, { step: 'split_task', maxAttempts: 1 } ],
  NETWORK_FAILURE:      [ { step: 'retry_backoff', maxAttempts: 2 }, { step: 'pause_goal', maxAttempts: 1 } ],
  INVALID_TOOL_OUTPUT:  [ { step: 'revalidate_input', maxAttempts: 1 }, { step: 'alternate_tool', maxAttempts: 1 } ],
  STALE_STATE:          [ { step: 'refresh_state', maxAttempts: 1 }, { step: 'replan', maxAttempts: 1 } ],
  BUILD_FAILURE:        [ { step: 'replan', maxAttempts: 2 }, { step: 'alternate_tool', maxAttempts: 1 } ],
  TEST_FAILURE:         [ { step: 'diagnose_failure', maxAttempts: 1 }, { step: 'replan', maxAttempts: 2 } ],
  VERIFICATION_FAILURE: [ { step: 'reverify_from_evidence', maxAttempts: 1 }, { step: 'replan', maxAttempts: 2 } ],
  USER_ACTION_REQUIRED: [ { step: 'ask', maxAttempts: 1 }, { step: 'pause_goal', maxAttempts: 1 } ],
  UNKNOWN:              [ { step: 'replan', maxAttempts: 2 } ],
};
const GENERIC = [ { step: 'replan', maxAttempts: 2 } ];

export function recoveryPlan(failureClass) {
  const plan = PLANS[failureClass] || GENERIC;
  return { failureClass, plan, bounded: true, totalBudget: plan.reduce((n, p) => n + p.maxAttempts, 0) };
}

/** nextRecoveryStep(class, consumedSoFar) -> step or null when budget exhausted */
export function nextRecoveryStep(failureClass, consumed) {
  const { plan } = recoveryPlan(failureClass);
  for (const p of plan) {
    if ((consumed[p.step] || 0) < p.maxAttempts) return { ...p, attempt: (consumed[p.step] || 0) + 1 };
  }
  return null;
}
