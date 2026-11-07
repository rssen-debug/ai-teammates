/**
 * MAJIN strategy recovery.
 *
 * Recover exactly once when an agent repeats a previously FAILED action.
 * Never re-execute the repeated action, never override permissions, and never
 * treat a changed prompt as proof of progress. The next model step must choose
 * an observably different tool/action; otherwise the existing watchdog stops.
 *
 * Uses no framework, model weights or additional services on the user's PC.
 */
const BROWSER=/^browser\./;
const FILE=/^fs\./;
const EXEC=/^(?:exec\.|shell\.|sys\.)/;

/**
 * Tool-specific, read-only recovery guidance inspired by accessibility-first
 * browser automation (agent-browser / Playwright MCP). This is a strategy
 * adapter, not a dependency or a claim that those projects were embedded.
 * These hints never authorize a new write, click, or permission bypass.
 */
export function browserRecoveryPlan(error='') {
  const msg=String(error||'').toLowerCase();
  const observe='Use browser.elements to read the CURRENT page\'s accessible controls and numbered references, then browser.read or take a fresh screenshot with browser.screenshot if needed. ';
  if(/ref_stale|stale|detached|not attached/.test(msg))
    return observe+'The DOM changed: discard the old reference and obtain a NEW browser.elements ref before any click. Never re-use coordinates or selectors from a prior page.';
  if(/not.found|no.such|selector|element|button|target/.test(msg))
    return observe+'Confirm the target exists and is visible/enabled; use a fresh grounded ref or a unique accessible label, not guessed nth-child selectors.';
  if(/timeout|navigation|loading|pending|network/.test(msg))
    return 'Inspect the current URL, page loading state, and visible error messages with browser.read and browser.screenshot. Check for redirects, login walls, and page readiness before choosing an alternative action.';
  if(/403|401|captcha|forbidden|permission|access.denied|auth/.test(msg))
    return 'Inspect the page for an authentication or permission boundary. Do not bypass CAPTCHA, login, approval, or security restrictions; ask the user to complete the required step if necessary.';
  if(/click|intercept|overlay|modal|blocked/.test(msg))
    return observe+'Look for a modal, overlay, cookie dialog, or disabled control. Resolve it only through authorized visible UI and confirm the new state.';
  return observe+'Check the URL and blockers. Select a NEW grounded target; do not retry the same coordinates or selector.';
}

export function recoveryHint(name, error='') {
  const tool=String(name||'tool').slice(0,70);
  const reason=String(error||'operation failed').slice(0,360);
  const method=BROWSER.test(tool)
    ? browserRecoveryPlan(reason)
    : FILE.test(tool)
      ? 'Inspect the actual filesystem path, permissions and existing content. Check the artifact independently before attempting a corrected write.'
      : EXEC.test(tool)
        ? 'Inspect exit code and stderr. Check the working directory, environment and dependencies, then use a materially different command.'
        : 'Observe the current state with a read-only tool and select a different evidence-based action.';
  return [
    'RECOVERY REQUIRED: Your identical tool action already FAILED and was NOT executed again.',
    'Tool: '+tool+'. Previous failure: '+reason+'.',
    method,
    'You have ONE corrective strategy turn. Do not repeat the same call or claim completion.',
    'If no safe alternative is possible, explain the blocker accurately.'
  ].join(' ');
}

export class RecoveryBudget {
  constructor(max=1){this.max=Math.max(0,Math.min(2,Number(max)||0));this.used=0;}
  assess({tool,key,toolLog=[]}={}){
    const k=String(key||'');
    const previous=[...toolLog].reverse().find(x=>x?.tool===tool && x?.repeatKey===k);
    if(!previous || previous.ok || this.used>=this.max){
      return {recover:false,why:previous?.ok?'duplicate successful action':this.used>=this.max?'recovery exhausted':'no matching failed action'};
    }
    this.used++;
    return {recover:true,attempt:this.used,remaining:this.max-this.used,hint:recoveryHint(tool,previous.error)};
  }
}
