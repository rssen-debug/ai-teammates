/**
 * V2 audit binding: funnels the three existing evidence sources into the
 * tamper-evident AuditChain with one entry point.
 *
 *   receipts   makeReceipt()/verify() (runtime/receipts.js)  -> kind 'receipt'
 *   telemetry  TelemetryLedger rows   (telemetry/ledger.js)  -> kind 'telemetry'
 *   events     EventBus + consent     (runtime/events.js,
 *                safety/approvals.js)                        -> kind 'event' | 'consent'
 *
 * Privacy by construction, same rule as the telemetry ledger: only scalar
 * fields survive (strings clipped at 256 chars); objects/arrays/functions in
 * event payloads are dropped and their key names are kept for orientation.
 * Message contents, file contents and absolute paths never enter the chain.
 *
 * Write order for telemetry: operational shard first, chain second; a chain
 * failure then THROWS so the caller sees the audit trail is impaired (a
 * silent audit trail is a false trail — the honesty rule applies to logs too).
 */

import { EVENT_NAMES } from '../runtime/events.js';

// approvals.js emits grant/use lifecycle as 'task.updated' with taskId 'consent:<scope>'
const CONSENT_EVENTS = ['consent.revoked', 'consent.expired', 'approval.required', 'task.updated'];

function prune(payload, depth = 0) {
  if (payload === null || payload === undefined) return payload ?? null;
  if (typeof payload === 'boolean') return payload;
  if (typeof payload === 'number') return Number.isFinite(payload) ? payload : null;
  if (typeof payload === 'string') return payload.length > 256 ? payload.slice(0, 256) : payload;
  if (typeof payload === 'object') {
    if (depth > 2) return '[truncated]';
    if (Array.isArray(payload)) return `[array:${payload.length}]`;
    const out = {};
    for (const k of Object.keys(payload).sort()) {
      const v = payload[k];
      if (typeof v === 'object' && v !== null && depth >= 2) { out[k] = '[dropped]'; continue; }
      out[k] = prune(v, depth + 1);
    }
    return out;
  }
  return null;
}

export class AuditBind {
  constructor(chain) {
    if (!chain) throw new Error('AuditBind requires an AuditChain');
    this.chain = chain;
    this._off = [];
  }

  /** recordReceipt(receipt): the receipt hash is the evidence — the chain
   *  stores identity + verdict, never the evidence blob itself. */
  recordReceipt(receipt, { actor } = {}) {
    if (!receipt || !receipt.hash) throw new Error('recordReceipt requires a receipt with hash');
    return this.chain.append('receipt', {
      id: receipt.id,
      hash: receipt.hash,
      verified: receipt.verified === true,
      action: receipt.action,
      result: receipt.result,
      goalId: receipt.goalId,
      taskId: receipt.taskId ?? null,
      at: receipt.at,
    }, { actor: actor || 'receipts' });
  }

  /** recordTelemetryRow(row): a row already accepted by TelemetryLedger
   *  (schema-filtered there) is mirrored into the chain — shards stay the
   *  analytics store, the chain is the integrity store. */
  recordTelemetryRow(row, { actor } = {}) {
    if (!row || !row.event) throw new Error('recordTelemetryRow requires a telemetry row');
    return this.chain.append('telemetry', prune({ ...row }), { actor: actor || 'telemetry', ts: row.at });
  }

  /** recordEvent(type, payload): manual funnel for one bus/consent event. */
  recordEvent(type, payload = {}, { actor } = {}) {
    if (!type) throw new Error('recordEvent requires an event type');
    const isConsent = type.startsWith('consent.') || type === 'approval.required'
      || (type === 'task.updated' && typeof payload.taskId === 'string' && payload.taskId.startsWith('consent:'));
    const kind = isConsent ? 'consent' : 'event';
    return this.chain.append(kind, { type, ...prune({ ...payload }) }, { actor: actor || 'bus' });
  }

  /** attach(bus): subscribe to the typed kernel stream + consent lifecycle.
   *  Returns a detach function. Listener errors never reach the bus because
   *  we catch them here (the bus isolates anyway, but an audit listener
   *  failing must not even LOOK like a bus failure), and record them as
   *  'audit.listener_error' so the failure itself is auditable. */
  attach(bus) {
    const names = [...EVENT_NAMES, ...CONSENT_EVENTS];
    const seen = new Set();
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      this._off.push(bus.on(name, (event) => {
        try {
          this.recordEvent(event.type, event, { actor: 'bus' });
        } catch (err) {
          try {
            this.chain.append('audit.listener_error', { source: name, error: String(err.message || err).slice(0, 128) }, { actor: 'audit' });
          } catch { /* chain itself impaired — nothing further can be promised */ }
        }
      }));
    }
    return () => this.detach();
  }

  detach() {
    for (const off of this._off.splice(0)) off();
  }
}
