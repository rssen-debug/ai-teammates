import { stripVTControlCharacters } from 'node:util';

export const cleanTerminalText = value => stripVTControlCharacters(String(value ?? ''))
  .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
const singleLine = value => cleanTerminalText(value).replace(/\s+/g, ' ').trim();
const statuses = { COMPLETED: 'DONE · verified', PARTIAL: 'PARTIAL · not final-verified',
  BLOCKED: 'BLOCKED', WAITING_USER: 'WAITING FOR YOU', PAUSED: 'PAUSED', CANCELLED: 'CANCELLED', FAILED: 'FAILED' };

export function compactHeader({ version, model, goal, color = false }) {
  const brand = color ? '\x1b[1;36mMAJIN\x1b[0m' : 'MAJIN';
  return `\n${brand}  ${singleLine(version)}\n${singleLine(model || 'Choose a model with /model')}\n`
    + (goal ? `Saved: ${statuses[goal.status] || singleLine(goal.status)} · ${singleLine(goal.objective).slice(0, 140)}\n` : '')
    + '\nTell MAJIN what to do. /help help · /status status · /logs details\n'
    + (goal && ['PAUSED', 'BLOCKED', 'WAITING_USER'].includes(goal.status) ? '/resume continues · /new <task> starts fresh\n' : '');
}

export function compactEvent(event) {
  const labels = { browser_open: 'Opening page', browser_inspect: 'Reading page', browser_click: 'Clicking',
    browser_fill: 'Filling field', browser_upload: 'Attaching file', browser_shot: 'Saving screenshot',
    browser_verify: 'Checking page', fs_find: 'Finding file', fs_read: 'Reading file',
    fs_write: 'Writing file', documents_extract: 'Reading document', web_search: 'Searching web' };
  switch (event.type) {
    case 'model_round_started': return event.round === 0 ? '  Thinking…' : null;
    case 'tool_call_started': return `  › ${labels[event.tool] || singleLine(event.tool)}${event.args ? ' · ' + singleLine(event.args) : ''}`;
    case 'tool_call_finished': return event.ok ? null : `  ! ${singleLine(event.tool)} · ${singleLine(event.errorCode || 'Error')}${event.blocker ? ' — ' + singleLine(event.blocker) : ''}`;
    case 'verification_started': return '  Checking the outcome…';
    case 'verification_failed': return `  ! Verification failed · ${singleLine(event.failure?.error || event.failure?.label)}`;
    case 'repair_requested': return '  Repairing the result…';
    case 'model_stream_retry': return '  Retrying the connection…';
    case 'waiting_user': return `  ! Needs your attention · ${singleLine(event.kind)} ${singleLine(event.origin || event.url)}`;
    case 'owner_steering_applied': return '  Your new instruction was received.';
    case 'delegate_batch_started': return `  Working on ${event.tasks?.length || 0} subtasks…`;
    default: return null;
  }
}

export function compactResult(goal) {
  const rows = goal.tool_results || [];
  const evidence = goal.verification_evidence || [];
  const summary = cleanTerminalText(goal.model_reply || goal.summaryText || '').trim();
  const parts = [`\n${statuses[goal.status] || singleLine(goal.status || 'UNKNOWN STATUS')}`, summary];
  if (goal.blocker && !summary.includes(goal.blocker)) parts.push(`Blocker: ${cleanTerminalText(goal.blocker)}`);
  const failed = rows.filter(row => !row.ok);
  parts.push(`${rows.length} tool calls · ${evidence.length} verification receipts${failed.length ? ` · ${failed.length} errors during this run` : ''}`);
  if (goal.cost) parts.push(`${goal.cost.modelCalls || 0} model rounds · ${(goal.cost.inputTokens || 0).toLocaleString('sv-SE')} in / ${(goal.cost.outputTokens || 0).toLocaleString('sv-SE')} out tokens`);
  if (goal.learning) parts.push(`Learning: ${goal.learning.status === 'saved' ? 'saved' : goal.learning.status === 'pending' ? 'pending storage' : 'no new method'}`);
  if (goal.browser_handoff?.action) parts.push(`Next step: ${cleanTerminalText(goal.browser_handoff.action)}`);
  else if (['PAUSED', 'BLOCKED', 'WAITING_USER'].includes(goal.status)) parts.push('/resume continues from the checkpoint · /logs shows errors and evidence');
  else parts.push('/logs shows tools, errors and verification details');
  return parts.filter(Boolean).join('\n\n') + '\n';
}
