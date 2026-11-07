/** Durable evidence-only continuation for MAJIN V4 unfinished user goals. */
const CONTINUE = /^(?:(?:ja|okej|ok|yes)[,! .]*)?(?:fortsätt|continue|resume|försök igen|testa igen|kör igen|igen sök|lös(?: det)?(?: nu)?|fixa(?: det)?|kör vidare|gör klart|slutför|retry)[\s.!?…]*$/iu;
export function isResumeRequest(message) { return CONTINUE.test(String(message || '').trim()); }
export function checkpointForFailure({objective, goalId, trace = [], code = ''} = {}) {
  // Argument SHAPES only: never persist form values, selectors, paths or tokens.
  const steps = trace.slice(-32).map(({name,argsShape,ok,verified,cls})=>({
    tool:String(name||'').slice(0,90),args:String(argsShape||'').slice(0,180),
    ok:Boolean(ok),verified:Boolean(verified),
    ...(cls?{failure:String(cls).slice(0,100)}:{})
  }));
  return {version:1,state:'unfinished',originalObjective:String(objective||'').slice(0,500),
    goalId:String(goalId||'').slice(0,100),failureClass:String(code||'UNKNOWN').slice(0,100),
    steps,verifiedSteps:steps.filter(s=>s.ok&&s.verified).length,updatedAt:new Date().toISOString()};
}
export function shouldResume(message,checkpoint) {
  return Boolean(checkpoint?.version===1 && checkpoint.state==='unfinished'&&isResumeRequest(message));
}
export function resumeGuidance(checkpoint) {
  if(!checkpoint||checkpoint.version!==1||checkpoint.state!=='unfinished')return '';
  const done=checkpoint.steps.filter(s=>s.ok).map(s=>s.tool).slice(-12);
  const failed=checkpoint.steps.filter(s=>!s.ok).map(s=>s.tool+(s.failure?' ['+s.failure+']':'')).slice(-6);
  return [
    '## SUPERVISOR: RESUME UNFINISHED USER TASK',
    'The owner is continuing the previous goal. Do NOT start a new task.',
    'Original objective: '+checkpoint.originalObjective,
    'Last failure class: '+checkpoint.failureClass,
    'Completed tool calls (NOT proof that external effects landed): '+(done.join(', ')||'none'),
    'Failed tools: '+(failed.join(', ')||'none'),
    'FIRST inspect saved artifacts, receipts and current external/browser state.',
    'Never automatically repeat a possible external submission, payment or destructive operation.',
    'On failures choose a DIFFERENT grounded approach; discover tools or delegate diagnostics if needed.',
    'Continue the original objective; independently verify success. If blocked, save a new checkpoint.',
  ].join('\n');
}
