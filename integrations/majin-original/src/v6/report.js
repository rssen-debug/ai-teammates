/**
 * MAJIN V6 — local-first status report built only from persisted state.
 *
 * If the watermark file, worker heartbeat or event log does not exist, the
 * report says so. It never prints a model name, queue count or activity line
 * that was not actually recorded.
 */
import fs from 'node:fs';
import path from 'node:path';
import { WorkerHeartbeat } from './worker-state.js';
import { formatActivityLine } from './activity.js';

const STATUS_ORDER = [
  'RUNNING', 'QUEUED', 'FAILED_RETRYABLE', 'BLOCKED', 'UNCERTAIN',
  'COMPLETED', 'FAILED_FINAL', 'CANCELLED',
];

export function workerSnapshots(dir, { now = Date.now(), staleMs = 45000 } = {}) {
  if (!fs.existsSync(dir)) return [];
  const workers = [];
  for (const name of fs.readdirSync(dir).filter((file) => file.endsWith('.json')).sort()) {
    let snapshot = null;
    try { snapshot = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
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

export async function buildReport({
  queue = null, log = null, jobs = null, workersDir = null, home = null,
  clock = Date.now, gmailStatus = null, syncStatus = null, modelLabel = null,
} = {}) {
  const generatedAt = new Date(clock()).toISOString();
  const queueStats = queue ? await queue.stats() : { total: 0, byState: {}, effects: 0, updatedAt: null };
  const jobsStats = jobs ? await jobs.stats() : null;
  const summary = log ? log.summarize({ windowMs: 60 * 60 * 1000, clock }) : { counts: {}, lastAt: null, total: 0 };
  const activity = log ? log.read({ limit: 12 }).map(formatActivityLine) : [];
  const workers = workersDir ? workerSnapshots(workersDir, { now: clock() }) : [];
  const anyActive = workers.some((worker) => worker.state === 'ACTIVE');
  const anyStalled = workers.some((worker) => worker.state === 'STALLED');
  const engineState = anyActive ? 'RUNNING' : (workers.length ? (anyStalled ? 'STALLED' : 'IDLE') : 'NOT_RUNNING');

  const safeModel = typeof modelLabel === 'string' && modelLabel.trim()
    ? modelLabel.trim()
    : 'OpenCode-owned (not reported by MAJIN)';

  const workerHealth = workers.length
    ? workers.map((worker) => `${worker.workerId}: ${worker.state}${worker.currentTaskId ? ` (${worker.currentTaskId})` : ''}`)
    : ['No worker heartbeat recorded'];

  const report = {
    schema: 'majin.v6.report/v1',
    generatedAt,
    home,
    engine: {
      state: engineState,
      lastEventAt: summary.lastAt,
      eventsLastHour: summary.total,
      eventCounts: summary.counts,
    },
    model: safeModel,
    mcp: 'MAJIN MCP is the OpenCode-facing bridge; its health is not inferred from queue events.',
    queue: {
      total: queueStats.total,
      byState: queueStats.byState,
      effects: queueStats.effects || 0,
      updatedAt: queueStats.updatedAt || null,
      ordered: STATUS_ORDER.filter((state) => queueStats.byState?.[state]).map((state) => ({ state, count: queueStats.byState[state] })),
    },
    workers,
    health: {
      watchdog: anyStalled ? 'STALLED' : (anyActive ? 'HEALTHY' : 'IDLE'),
      workers: workerHealth,
    },
    jobs: jobsStats,
    activity,
    checks: {
      gmail: gmailStatus || { state: 'NOT_CHECKED' },
      sync: syncStatus || { state: 'NOT_CONFIGURED' },
    },
    limitations: [
      'Model identity and token usage belong to OpenCode and are not visible to MAJIN events.',
      'No tool is marked working merely because it is registered; execution evidence lives in the event log.',
      'Gmail and employer-portal actions are only reported when their adapters are configured and actually ran.',
      'This report is local. Private sync is optional and sanitized before upload.',
    ],
  };
  return report;
}

export function renderReport(report) {
  const lines = [];
  const q = report.queue.byState || {};
  lines.push('OPENCODE V6 — LIVE STATUS');
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
  if (report.jobs) {
    lines.push('');
    lines.push('JOB APPLICATIONS');
    const byState = report.jobs.byState || {};
    const entries = Object.entries(byState).sort(([a], [b]) => a.localeCompare(b));
    if (!entries.length) lines.push('  none recorded');
    for (const [state, count] of entries) lines.push(`  ${state.padEnd(26)} ${count}`);
  }
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

function describeCheck(check) {
  if (!check) return 'NOT_CHECKED';
  if (typeof check === 'string') return check;
  if (check.state) return check.reason ? `${check.state} (${check.reason})` : check.state;
  return JSON.stringify(check);
}
