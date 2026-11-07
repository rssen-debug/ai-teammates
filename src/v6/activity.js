/** Human-readable activity lines from real persisted events only. */

const KNOWN = new Map([
  ['engine.started', (e) => `Work engine started (max ${e.data.maxTasks ?? '?'} tasks)`],
  ['engine.stopped', (e) => `Work engine stopped: ${e.data.reason || 'unknown reason'}`],
  ['engine.budget_reached', (e) => `Budget reached: ${e.data.budget || 'unspecified'}`],
  ['engine.error', (e) => `Engine error ${e.data.code || ''}`.trim()],
  ['task.queued', (e) => `Task queued: ${e.data.kind || e.taskId || ''}`],
  ['task.claimed', (e) => `Worker assigned ${e.data.kind || 'task'} (attempt ${e.data.attempt ?? '?'})`],
  ['task.progress', (e) => `${e.data.action || 'working'}`],
  ['task.completed', (e) => `Task completed: ${e.data.summary || e.taskId || ''}`],
  ['task.blocked', (e) => `Task blocked: ${e.data.code || 'BLOCKED'}${e.data.requiresOwner ? ' (owner action)' : ''}`],
  ['task.failed', (e) => `Task failed: ${e.data.code || 'ERROR'} (attempt ${e.data.attempt ?? '?'}${e.data.final ? ', final' : ''})`],
  ['task.uncertain', (e) => `Outcome uncertain: ${e.data.code || 'UNCERTAIN'} — not retried`],
  ['task.cancelled', (e) => 'Task cancelled'],
  ['task.deduplicated', (e) => `Duplicate work suppressed (${e.data.kind || e.taskId || ''})`],
  ['task.recovered', (e) => `Recovered task after ${e.data.code || 'worker loss'}`],
  ['tool.started', (e) => `Tool started: ${e.data.tool || 'unknown'}`],
  ['tool.completed', (e) => `Tool completed: ${e.data.tool || 'unknown'}`],
  ['tool.failed', (e) => `Tool failed: ${e.data.tool || 'unknown'} (${e.data.code || 'ERROR'})`],
  ['worker.assigned', (e) => `Worker assigned: ${e.data.kind || 'task'}`],
  ['worker.stalled', (e) => `Worker stalled: ${e.data.code || 'STALL'}`],
  ['watchdog.stalled', (e) => `Watchdog: no progress for ${Math.round((e.data.silentMs || 0) / 1000)}s`],
  ['permission.blocked', (e) => `Permission blocker: ${e.data.code || 'unknown'} (owner action required)`],
  ['receipt.observed', (e) => `Receipt observed: ${e.data.receiptRef || 'reference recorded'}`],
  ['job.discovered', (e) => `Job discovered (${e.data.site || 'site'})`],
  ['job.matched', (e) => `Job matched, score ${e.data.score ?? '?'} → ${e.data.state || ''}`],
  ['job.state', (e) => `Application state → ${e.data.state || e.data.event || ''}`],
  ['job.submitted', (e) => `Application submitted with acknowledgement${e.data.receiptReference ? ` (${e.data.receiptReference})` : ''}`],
  ['job.confirmed', (e) => `Application confirmed (${e.data.source || 'evidence'})`],
  ['gmail.checked', (e) => `Gmail checked: ${e.data.scanned ?? 0} messages, ${e.data.matched ? `${e.data.kind || 'match'} found` : 'no match'}`],
  ['sync.skipped', (e) => `Private sync skipped: ${e.data.code || 'not configured'}`],
  ['sync.refused', (e) => `Private sync refused: ${e.data.code || 'policy'}`],
  ['sync.completed', (e) => `Private report uploaded: ${e.data.path || 'unknown path'}`],
  ['mcp.started', () => 'MAJIN MCP bridge started'],
  ['mcp.stopped', () => 'MAJIN MCP bridge stopped'],
]);

export function formatActivityLine(event) {
  if (!event?.type) return 'unknown event';
  const time = String(event.at || '').slice(11, 16) || '--:--';
  if (event.type === 'heartbeat') return `${time} Heartbeat`;
  const builder = KNOWN.get(event.type);
  const text = builder ? builder(event) : event.type;
  return `${time} ${text}`.slice(0, 160);
}
