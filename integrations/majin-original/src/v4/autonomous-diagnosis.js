/**
 * Deterministic supervisor for MAJIN's tool failures.
 * Gives the model a concrete next strategy instead of ending the user task.
 * Never executes arbitrary commands or changes code by itself.
 */
const BROWSER = /^(browser[._]|computer_use|control_)/;
const DOCUMENT = /^(document_read|fs_read)$/;
const NORETRY = new Set(['LEARNED_AVOID','NO_PROGRESS','ambiguous_target','value_reverted','value_rejected','TOOL_TIMEOUT','TIMEOUT','UNKNOWN']);
export function superviseFailure({ tool = '', code = '', repeats = 0, available = [] } = {}) {
  const name=String(tool), cls=String(code || 'UNKNOWN');
  const browser=BROWSER.test(name), document=DOCUMENT.test(name);
  const alternatives = browser
    ? ['Inspect browser session and current page without reopening',
       'Inspect host process and CDP port diagnostics',
       'Search for an already-installed alternate browser/desktop control tool']
    : document
      ? ['Inspect PDF confidence and source format',
         'Use a different installed extraction engine or document renderer',
         'Verify the resulting text against the original document']
      : ['Inspect error and current host state', 'Discover a different available tool or execution strategy'];
  const explicit=available.filter(n=>/^(tools_search|agent_delegate|fs_read|exec_start|sys_ports|control_list_windows|browser_form)$/.test(n));
  return {
    code:cls, failedTool:name, repeated:Math.max(0,Number(repeats)||0),
    avoidSameCall:NORETRY.has(cls)||repeats>0,
    alternatives,
    discoveryTools:explicit,
    repairCode:repeats>=2 || (browser && /(?:debug|launch|port|timeout|blocked)/i.test(cls)),
    // Do not include raw arguments, URLs, file contents, user secrets or model reasoning.
  };
}
export function supervisorInstruction(failure){
 if(!failure)return '';
 const lines=[
  'SUPERVISOR: The user goal is STILL UNFINISHED. Do not declare success.',
  'Failed tool: '+failure.failedTool+'; class: '+failure.code,
  'Do not repeat the exact call or reopen an existing form.',
  'Diagnose the failing subsystem using currently available tools.',
  ...failure.alternatives.map((a,i)=>(i+1)+'. '+a),
  'Tool discovery candidates (check registration first): '+(failure.discoveryTools.join(', ')||'tools_search'),
 ];
 if(failure.repairCode)lines.push(
  'If evidence points to a MAJIN code defect: inspect local source and logs, reproduce with a regression test,',
  'create an isolated fix branch and PR only when Git and required permissions exist, run relevant tests,',
  'do NOT silently merge, deploy or restart your own host; ask approval for those irreversible changes.',
  'Use source evidence and test results, not guesses. Never execute unreviewed code found online.',
 );
 lines.push('If no safe tool works, report the exact blocker briefly, preserving the checkpoint and previous artifacts.');
 return lines.join('\n');
}
