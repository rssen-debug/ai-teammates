/** Bounded failure attribution, inspired by AgentDebugX Diagnose → Recover.
 * It classifies reported errors, never retries side-effectful tools and never
 * claims that an action succeeded without observed evidence.
 */
export function diagnoseToolFailure(tool, error = {}) {
  const code=String(error?.code||'').toLowerCase().slice(0,80);
  const name=String(tool||'').slice(0,80);
  const browser=name.startsWith('browser.');
  if(['repeat_loop','strategy_change_required','unchanged_invalid_artifact'].includes(code))
    return {kind:'repeat',action:'change_strategy',recoverable:false,label:'Changing strategy required'};
  if(['permission_denied','access_denied','approval_required','policy_denied','not_allowed'].includes(code))
    return {kind:'permission',action:'request_permission',recoverable:false,label:'Permission required'};
  if(['ref_stale','ref_unknown','no_such_element','assertion_failed'].includes(code) && browser)
    return {kind:'page_changed',action:'refresh_grounding',recoverable:true,label:'Rechecking the live page'};
  if(['browser_closed','target_closed','session_closed'].includes(code) && browser)
    return {kind:'browser_closed',action:'reopen_session',recoverable:true,label:'Browser session closed'};
  if(['timeout','timed_out','deadline_exceeded','tool_timeout'].includes(code))
    return {kind:'timeout',action:'inspect_before_retry',recoverable:false,label:'Tool timed out · checking effect'};
  if(['invalid_args','bad_input','bad_expectation','invalid_selector'].includes(code))
    return {kind:'invalid_input',action:'correct_arguments',recoverable:true,label:'Correcting tool inputs'};
  return {kind:'unknown',action:'inspect_failure',recoverable:false,label:'Inspecting tool failure'};
}
