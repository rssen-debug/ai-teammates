/**
 * Unified kernel — human-readable activity lines from real persisted events.
 *
 * Ported from MAJIN V6 (`src/v6/activity.js`). An event type with no known
 * builder is printed as its raw type rather than being embellished.
 */
import type { KernelEvent } from './events.js';

type Builder = (event: KernelEvent) => string;

const KNOWN = new Map<string, Builder>([
  ['engine.started', (e) => `Work engine started (max ${String(e.data.maxTasks ?? '?')} tasks)`],
  ['engine.stopped', (e) => `Work engine stopped: ${String(e.data.reason || 'unknown reason')}`],
  ['engine.budget_reached', (e) => `Budget reached: ${String(e.data.budget || 'unspecified')}`],
  ['engine.error', (e) => `Engine error ${String(e.data.code || '')}`.trim()],
  ['task.queued', (e) => `Task queued: ${String(e.data.kind || e.taskId || '')}`],
  ['task.claimed', (e) => `Worker assigned ${String(e.data.kind || 'task')} (attempt ${String(e.data.attempt ?? '?')})`],
  ['task.progress', (e) => `${String(e.data.action || 'working')}`],
  ['task.completed', (e) => `Task completed: ${String(e.data.summary || e.taskId || '')}`],
  ['task.blocked', (e) => `Task blocked: ${String(e.data.code || 'BLOCKED')}${e.data.requiresOwner ? ' (owner action)' : ''}`],
  ['task.failed', (e) => `Task failed: ${String(e.data.code || 'ERROR')} (attempt ${String(e.data.attempt ?? '?')}${e.data.final ? ', final' : ''})`],
  ['task.uncertain', (e) => `Outcome uncertain: ${String(e.data.code || 'UNCERTAIN')} — not retried`],
  ['task.cancelled', () => 'Task cancelled'],
  ['task.deduplicated', (e) => `Duplicate work suppressed (${String(e.data.kind || e.taskId || '')})`],
  ['task.recovered', (e) => `Recovered task after ${String(e.data.code || 'worker loss')}`],
  ['tool.started', (e) => `Tool started: ${String(e.data.tool || 'unknown')}`],
  ['tool.completed', (e) => `Tool completed: ${String(e.data.tool || 'unknown')}`],
  ['tool.failed', (e) => `Tool failed: ${String(e.data.tool || 'unknown')} (${String(e.data.code || 'ERROR')})`],
  ['worker.assigned', (e) => `Worker assigned: ${String(e.data.kind || 'task')}`],
  ['worker.stalled', (e) => `Worker stalled: ${String(e.data.code || 'STALL')}`],
  ['watchdog.stalled', (e) => `Watchdog: no progress for ${Math.round(Number(e.data.silentMs || 0) / 1000)}s`],
  ['permission.blocked', (e) => `Permission blocker: ${String(e.data.code || 'unknown')} (owner action required)`],
  ['receipt.observed', (e) => `Receipt observed: ${String(e.data.receiptRef || 'reference recorded')}`],
  ['job.discovered', (e) => `Job discovered (${String(e.data.site || 'site')})`],
  ['job.matched', (e) => `Job matched, score ${String(e.data.score ?? '?')} → ${String(e.data.state || '')}`],
  ['job.state', (e) => `Application state → ${String(e.data.state || e.data.event || '')}`],
  ['job.submitted', (e) => `Application submitted with acknowledgement${e.data.receiptReference ? ` (${String(e.data.receiptReference)})` : ''}`],
  ['job.confirmed', (e) => `Application confirmed (${String(e.data.source || 'evidence')})`],
  ['gmail.checked', (e) => `Gmail checked: ${String(e.data.scanned ?? 0)} messages, ${e.data.matched ? `${String(e.data.kind || 'match')} found` : 'no match'}`],
  ['sync.skipped', (e) => `Private sync skipped: ${String(e.data.code || 'not configured')}`],
  ['sync.refused', (e) => `Private sync refused: ${String(e.data.code || 'policy')}`],
  ['sync.completed', (e) => `Private report uploaded: ${String(e.data.path || 'unknown path')}`],
  ['mcp.started', () => 'MCP bridge started'],
  ['mcp.stopped', () => 'MCP bridge stopped'],
  // Legacy Buddy / Omega bridge.
  ['buddy.probe', (e) => `Buddy probe: ${String(e.data.subsystem || 'unknown')} → ${String(e.data.state || 'unknown')}`],
  ['buddy.blocked', (e) => `Buddy blocked: ${String(e.data.code || 'BLOCKED')}${e.data.reason ? ` — ${String(e.data.reason).slice(0, 80)}` : ''}`],
  ['buddy.verified', (e) => `Buddy verified: ${String(e.data.claim || 'claim')} with ${String(e.data.evidenceKind || 'evidence')}`],
  ['buddy.planned', (e) => `Buddy planned ${String(e.data.steps ?? '?')} step(s)`],
  ['buddy.refused', (e) => `Buddy refused: ${String(e.data.code || 'REFUSED')}`],
]);

export function formatActivityLine(event: KernelEvent | null | undefined): string {
  if (!event?.type) return 'unknown event';
  const time = String(event.at || '').slice(11, 16) || '--:--';
  if (event.type === 'heartbeat') return `${time} Heartbeat`;
  const builder = KNOWN.get(event.type);
  const text = builder ? builder(event) : event.type;
  return `${time} ${text}`.slice(0, 160);
}
