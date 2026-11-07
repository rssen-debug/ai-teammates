/** Action receipts inspired by agenttool's separate dispatch/outcome contract.
 * A local click return is NOT proof of a remote form submit, purchase or save.
 * Keep receipts bounded and omit URLs, input values, credentials and page text.
 */
export function browserActionReceipt({ dispatched=false, verified=false, uncertain=false, reason=''} = {}) {
  const status = !dispatched ? 'not_started' : uncertain ? 'unknown' : 'browser_completed';
  const evidence = verified ? 'postcondition_verified' : dispatched ? 'action_only' : 'none';
  const retryAdvice = !dispatched ? 'correct_or_reobserve' : 'do_not_automatically_retry';
  return { status, evidence, retryAdvice, reason: String(reason||'').slice(0,80) };
}
