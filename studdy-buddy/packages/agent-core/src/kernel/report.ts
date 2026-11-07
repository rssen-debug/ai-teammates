/**
 * Unified kernel — local-first status report built only from persisted state.
 *
 * Ported from MAJIN V6 (`src/v6/report.js`). If the worker heartbeat or event
 * log does not exist, the report says so. It never prints a model name, queue
 * count or activity line that was not actually recorded.
 */
import fs from 'node:fs';
import path from 'node:path';
import { WorkerHeartbeat, type WorkerSnapshot } from './worker-state.js';
import { formatActivityLine } from './activity.js';
import type { EventLog } from './events.js';
import type { QueueStats, TaskQueue, TaskState } from './queue.js';
import type { Clock } from './util.js';

const STATUS_ORDER: readonly TaskState[] = [
  'RUNNING', 'QUEUED', 'FAILED_RETRYABLE', 'BLOCKED', 'UNCERTAIN',
  'COMPLETED', 'FAILED_FINAL', 'CANCELLED',
];

export interface WorkerReport {
  workerId: string;
  state: string;
  ageSeconds: number | null;
  pidAlive: boolean | null;
  currentTaskId: string | null;
  lastAction: string | null;
  lastActionAt: string | null;
  tasksCompleted: number;
  tasksFailed: number;
  tasksBlocked: number;
  toolCalls: number;
}

export function workerSnapshots(dir: string, { now = Date.now(), staleMs = 45_000 }: { now?: number; staleMs?: number } = {}): WorkerReport[] {
  if (!fs.existsSync(dir)) return [];
  const workers: WorkerReport[] = [];
  for (const name of fs.readdirSync(dir).filter((file) => file.endsWith('.json')).sort()) {
    let snapshot: WorkerSnapshot | null = null;
    try {
      snapshot = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as WorkerSnapshot;
    } catch {
      continue;
    }
    if (!snapshot?.workerId) continue;
    const health = WorkerHeartbeat.health(snapshot, { now, staleMs });
    workers.push({
      workerId: snapshot.workerId,
      state: health.state,
      ageSeconds: health.ageMs == null ? null : Math.round(health.ageMs / 1000),
      pidAlive: health.pidAlive,
      currentTaskId: snapshot.currentTaskId || null,
      lastAction: snapshot.lastAction || null,
      lastActionAt: snapshot.lastActionAt || null,
      tasksCompleted: snapshot.tasksCompleted || 0,
      tasksFailed: snapshot.tasksFailed || 0,
      tasksBlocked: snapshot.tasksBlocked || 0,
      toolCalls: snapshot.toolCalls || 0,
    });
  }
  return workers;
}

export interface CheckStatus {
  state: string;
  reason?: string;
  [key: string]: unknown;
}

export interface KernelReport {
  schema: string;
  generatedAt: string;
  home: string | null;
  engine: {
    state: string;
    lastEventAt: string | null;
    eventsLastHour: number;
    eventCounts: Record<string, number>;
  };
  model: string;
  queue: {
    total: number;
    byState: Record<string, number>;
    effects: number;
    updatedAt: string | null;
    ordered: { state: string; count: number }[];
  };
  workers: WorkerReport[];
  health: { watchdog: string; workers: string[] };
  activity: string[];
  checks: { gmail: CheckStatus; sync: CheckStatus; [key: string]: CheckStatus | unknown };
  limitations: string[];
}

export interface BuildReportOptions {
  queue?: TaskQueue | null;
  log?: EventLog | null;
  workersDir?: string | null;
  home?: string | null;
  clock?: Clock;
  gmailStatus?: CheckStatus | null;
  syncStatus?: CheckStatus | null;
  modelLabel?: string | null;
}

export async function buildReport({
  queue = null,
  log = null,
  workersDir = null,
  home = null,
  clock = Date.now,
  gmailStatus = null,
  syncStatus = null,
  modelLabel = null,
}: BuildReportOptions = {}): Promise<KernelReport> {
  const generatedAt = new Date(clock()).toISOString();
  const emptyStats: QueueStats = { total: 0, byState: {} as Record<TaskState, number>, byKind: {}, effects: 0, updatedAt: '' };
  const queueStats = queue ? await queue.stats() : emptyStats;
  const summary = log ? log.summarize({ windowMs: 60 * 60 * 1000, clock }) : { counts: {}, lastAt: null, total: 0 };
  const activity = log ? log.read({ limit: 12 }).map(formatActivityLine) : [];
  const workers = workersDir ? workerSnapshots(workersDir, { now: clock() }) : [];
  const anyActive = workers.some((worker) => worker.state === 'ACTIVE');
  const anyStalled = workers.some((worker) => worker.state === 'STALLED');
  const engineState = anyActive ? 'RUNNING' : (workers.length ? (anyStalled ? 'STALLED' : 'IDLE') : 'NOT_RUNNING');

  const safeModel = typeof modelLabel === 'string' && modelLabel.trim()
    ? modelLabel.trim()
    : 'not reported by the kernel (the CLI/provider owns model identity)';

  const workerHealth = workers.length
    ? workers.map((worker) => `${worker.workerId}: ${worker.state}${worker.currentTaskId ? ` (${worker.currentTaskId})` : ''}`)
    : ['No worker heartbeat recorded'];

  return {
    schema: 'studdy.kernel.report/v1',
    generatedAt,
    home,
    engine: {
      state: engineState,
      lastEventAt: summary.lastAt,
      eventsLastHour: summary.total,
      eventCounts: summary.counts,
    },
    model: safeModel,
    queue: {
      total: queueStats.total,
      byState: queueStats.byState,
      effects: queueStats.effects || 0,
      updatedAt: queueStats.updatedAt || null,
      ordered: STATUS_ORDER
        .filter((state) => queueStats.byState?.[state])
        .map((state) => ({ state, count: queueStats.byState[state] as number })),
    },
    workers,
    health: {
      watchdog: anyStalled ? 'STALLED' : (anyActive ? 'HEALTHY' : 'IDLE'),
      workers: workerHealth,
    },
    activity,
    checks: {
      gmail: gmailStatus || { state: 'NOT_CHECKED' },
      sync: syncStatus || { state: 'NOT_CONFIGURED' },
    },
    limitations: [
      'Model identity and token usage belong to the CLI/provider and are not visible to kernel events.',
      'No tool is marked working merely because it is registered; execution evidence lives in the event log.',
      'Gmail and employer-portal actions are only reported when their adapters are configured and actually ran.',
      'This report is local. Optional private sync is sanitized before upload and refused when it is not safe.',
    ],
  };
}

function describeCheck(check: unknown): string {
  if (!check) return 'NOT_CHECKED';
  if (typeof check === 'string') return check;
  const record = check as Record<string, unknown>;
  if (typeof record.state === 'string') {
    return record.reason ? `${record.state} (${String(record.reason)})` : record.state;
  }
  return JSON.stringify(check);
}

export function renderReport(report: KernelReport): string {
  const lines: string[] = [];
  const q = report.queue.byState || {};
  lines.push('STUDDY KERNEL — LIVE STATUS');
  lines.push('');
  lines.push(`Model: ${report.model}`);
  lines.push(`Engine: ${report.engine.state}   Last event: ${report.engine.lastEventAt || 'none recorded'}`);
  lines.push('');
  lines.push('QUEUE');
  lines.push(`  Running:        ${q.RUNNING || 0}`);
  lines.push(`  Waiting:        ${q.QUEUED || 0}`);
  lines.push(`  Retryable:      ${q.FAILED_RETRYABLE || 0}`);
  lines.push(`  Blocked:        ${q.BLOCKED || 0}`);
  lines.push(`  Uncertain:      ${q.UNCERTAIN || 0}`);
  lines.push(`  Completed:      ${q.COMPLETED || 0}`);
  lines.push(`  Failed final:   ${q.FAILED_FINAL || 0}`);
  lines.push('');
  lines.push('LATEST ACTIVITY');
  if (!report.activity.length) lines.push('  no persisted events');
  for (const line of report.activity) lines.push(`  ${line}`);
  lines.push('');
  lines.push('HEALTH');
  for (const line of report.health.workers) lines.push(`  ${line}`);
  lines.push(`  Watchdog: ${report.health.watchdog}`);
  lines.push('');
  lines.push('CHECKS');
  lines.push(`  Gmail: ${describeCheck(report.checks.gmail)}`);
  lines.push(`  Private sync: ${describeCheck(report.checks.sync)}`);
  lines.push('');
  lines.push('WHAT IS NOT KNOWN');
  for (const item of report.limitations) lines.push(`  - ${item}`);
  return lines.join('\n');
}
