/**
 * V2 telemetry ledger (master brief sections 122-124).
 *
 * Per-day JSONL shards. Privacy by construction: only numeric/enum/small
 * string fields, never message contents, file contents, absolute paths, or
 * token-expensive payload blobs. Anything outside the allowed field set is
 * dropped silently by the serializer.
 */
import fs from 'node:fs';
import path from 'node:path';

const EVENT_SCHEMAS = {
  'goal.start':    ['goalId', 'objectiveLen', 'risk', 'compilerSource', 'at'],
  'goal.finish':   ['goalId', 'finalState', 'durationMs', 'tasks', 'done', 'failed', 'receipts', 'verifiedReceipts', 'acceptanceCount', 'at'],
  'task.result':   ['goalId', 'taskId', 'action', 'durationMs', 'result', 'errorCls', 'attempt', 'at'],
  'model.call':    ['provider', 'elapsedMs', 'usageInput', 'usageOutput', 'usageTotal', 'model', 'result', 'errorCls', 'at'],
  'preflight':     ['tier', 'mode', 'decision', 'durationMs', 'at'],
  'consent':       ['scope', 'decision', 'mode', 'at'],
  'verification':  ['goalId', 'acceptanceId', 'kind', 'verified', 'durationMs', 'at'],
};

export function telemetryRow(event,payload={}) {
  const allowed=EVENT_SCHEMAS[event];
  if(!allowed)throw new Error(`unknown telemetry event: ${event}`);
  const row={event};
  for(const key of allowed){
    if(payload[key]===undefined)continue;
    row[key]=typeof payload[key]==='string'?payload[key].slice(0,256):payload[key];
  }
  if(!row.at)row.at=new Date().toISOString();
  return row;
}

export class TelemetryLedger {
  constructor(dir) {
    if (!dir) throw new Error('ledger requires a directory');
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  todayFile() {
    const d = new Date().toISOString().slice(0, 10);
    return path.join(this.dir, `${d}.jsonl`);
  }

  /** append(event, payload) — only allowed fields survive */
  append(event, payload = {}) {
    const row=telemetryRow(event,payload);
    fs.appendFileSync(this.todayFile(), JSON.stringify(row) + '\n');
    return row;
  }
}

export const TELEMETRY_EVENTS = Object.freeze(Object.keys(EVENT_SCHEMAS));
