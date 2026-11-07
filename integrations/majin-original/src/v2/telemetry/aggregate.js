/**
 * V2 telemetry aggregation (sections 123-124): read JSONL shards, aggregate
 * into operator-facing numbers. Locale-independent percentile math.
 */
import fs from 'node:fs';
import path from 'node:path';

function percentile(nums, p) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}

/** list shard files inside dir (optionally only the last N days) */
export function shardFiles(dir, { lastDays = 7 } = {}) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) : [];
  files.sort();
  return files.slice(-lastDays).map((f) => path.join(dir, f));
}

export function readShards(files) {
  const rows = [];
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* corrupt line is dropped, not fatal */ }
    }
  }
  return rows;
}

/**
 * aggregate(dir, {lastDays}) -> report {
 *   from, to, events,
 *   goals: {count, completed, completedRate, durationMsP50/p75/p95, verifiedReceiptsAvg},
 *   models: {callCount, tokenTotal, byProvider{}},
 *   failureClasses: { <cls>: n },
 *   verification: {count, successRate}
 * }
 */
export function aggregate(dir, { lastDays = 7 } = {}) {
  const files = shardFiles(dir, { lastDays });
  const rows = readShards(files);
  const goals = rows.filter((r) => r.event === 'goal.finish');
  const models = rows.filter((r) => r.event === 'model.call');
  const verifs = rows.filter((r) => r.event === 'verification');
  const tasks = rows.filter((r) => r.event === 'task.result');

  const durations = goals.map((g) => g.durationMs).filter((n) => typeof n === 'number');
  const taskErrs = tasks.filter((t) => t.errorCls);
  const failureClasses = {};
  for (const t of taskErrs) failureClasses[t.errorCls] = (failureClasses[t.errorCls] || 0) + 1;

  const byProvider = {};
  let tokens = 0;
  for (const m of models) {
    const p = m.provider || 'unknown';
    byProvider[p] = byProvider[p] || { calls: 0, tokens: 0 };
    byProvider[p].calls += 1;
    byProvider[p].tokens += m.usageTotal || 0;
    tokens += m.usageTotal || 0;
  }

  const completed = goals.filter((g) => g.finalState === 'COMPLETED').length;
  const verifiedReceipts = goals.map((g) => g.verifiedReceipts || 0);

  return {
    from: files.length ? path.basename(files[0]).replace('.jsonl', '') : null,
    to: files.length ? path.basename(files[files.length - 1]).replace('.jsonl', '') : null,
    events: rows.length,
    goals: {
      count: goals.length,
      completed,
      completedRate: goals.length ? completed / goals.length : 0,
      durationMsP50: percentile(durations, 50),
      durationMsP75: percentile(durations, 75),
      durationMsP95: percentile(durations, 95),
      verifiedReceiptsAvg: goals.length ? verifiedReceipts.reduce((a, b) => a + b, 0) / goals.length : 0,
    },
    models: { callCount: models.length, tokenTotal: tokens, byProvider },
    failureClasses,
    verification: {
      count: verifs.length,
      successRate: verifs.length ? verifs.filter((v) => v.verified).length / verifs.length : 0,
    },
  };
}

/** Markdown operator view; keeps the ledger's own format stable */
export function renderReport(report) {
  return [
    '# MAJIN V2 telemetry report', '',
    `- window: ${report.from}..${report.to} (${report.events} events)`, '',
    '| metric | value |',
    '|---|---|',
    `| goals | ${report.goals.count} |`,
    `| completed | ${report.goals.completed} (${(report.goals.completedRate * 100).toFixed(0)}%) |`,
    `| goal duration p50/p75/p95 ms | ${report.goals.durationMsP50}/${report.goals.durationMsP75}/${report.goals.durationMsP95} |`,
    `| verified receipts per goal (avg) | ${report.goals.verifiedReceiptsAvg.toFixed(1)} |`,
    `| model calls | ${report.models.callCount} (${report.models.tokenTotal} tokens) |`,
    `| verification success | ${(report.verification.successRate * 100).toFixed(0)}% (${report.verification.count} checks) |`,
    `| failure classes | ${Object.entries(report.failureClasses).map(([k, v]) => `${k}:${v}`).join(', ') || 'none'} |`,
  ].join('\n') + '\n';
}
