/**
 * MAJIN browser recovery policy. Inspired by agent-browser and Playwright MCP:
 * re-observe stale refs and obstructed controls; never blindly replay writes.
 * Pure, bounded and deliberately advisory — cannot bypass tool permissions.
 */
const HELP = Object.freeze({
  ref_stale: {phase:'refresh_page',next:'browser.elements',message:'Page changed. Take a fresh interactive snapshot before choosing a new element reference.'},
  ref_unknown: {phase:'refresh_page',next:'browser.elements',message:'Reference not found. Read current elements; do not guess an old ref.'},
  no_such_element: {phase:'refresh_page',next:'browser.elements',message:'Selector is absent. Inspect visible controls and select a current element.'},
  click_blocked: {phase:'inspect_blocker',next:'browser.elements',message:'A dialog, disabled state or overlay may block interaction. Inspect the page; resolve the blocker before trying another click.'},
  assertion_failed: {phase:'verify_failed',next:'browser.read',message:'The expected result is not present. Read the current page and diagnose why before any new action.'},
  browser_closed: {phase:'reconnect',next:'browser.open',message:'The browser session is closed. Open it only if the task still needs browser access.'},
  tool_timeout: {phase:'outcome_unknown',next:'browser.read',message:'Action timed out. It may already have completed. Inspect state before deciding whether any write or click is safe to repeat.'},
  repeat_loop: {phase:'stop_repeat',next:null,message:'Repeated identical actions are not progress. Change approach and never replay the blocked call.'},
});
export function suggestBrowserRecovery(tool,error){
  const name=String(tool||'');
  if(!name.startsWith('browser.'))return null;
  const code=String(error?.code||'');
  const match=Object.hasOwn(HELP,code)?HELP[code]:null;if(!match)return null;
  return {phase:match.phase,next:match.next,message:match.message,code,tool:name};
}
