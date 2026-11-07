/**
 * V2 telemetry contracts: shards exist per day, serializer drops anything
 * outside the allowed fields (privacy by construction), aggregation math is
 * right, and a real objective run leaves an auditable trail — all local.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelemetryLedger, TELEMETRY_EVENTS } from '../src/v2/telemetry/ledger.js';
import { aggregate, renderReport } from '../src/v2/telemetry/aggregate.js';
import { runObjective } from '../src/v2/runtime/orchestrator.js';

test('ledger: shards per day, allowed fields only, giant strings clamped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-tele-'));
  const led = new TelemetryLedger(dir);
  const row = led.append('model.call', {
    provider: 'x', elapsedMs: 5, usageTotal: 7, result: 'ok',
    secretPrompt: 'SHOULD NOT SURVIVE', apiKey: 'NOPE',
  });
  assert.ok(!('secretPrompt' in row));
  assert.ok(!('apiKey' in row));
  assert.throws(() => led.append('message.content', { raw: 'hi' }), /unknown telemetry/);
  const big = 'x'.repeat(5000);
  const r2 = led.append('model.call', { provider: big });
  assert.equal(r2.provider.length, 256);
  const files = fs.readdirSync(dir);
  assert.ok(files.every((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)));
});

test('aggregate: percentile + success mix math (no locale surprises)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-tele-'));
  const led = new TelemetryLedger(dir);
  const durs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  durs.forEach((dMs, i) => {
    led.append('goal.finish', {
      goalId: `g${i}`, finalState: i === 0 ? 'FAILED' : 'COMPLETED',
      durationMs: dMs, receipts: 3, verifiedReceipts: i % 3, acceptanceCount: 2,
    });
  });
  led.append('model.call', { provider: 'a', usageTotal: 10 });
  led.append('model.call', { provider: 'a', usageTotal: 5 });
  led.append('task.result', { goalId: 'g0', taskId: 't', action: 'a', result: 'failure', errorCls: 'TIMEOUT' });
  led.append('task.result', { goalId: 'g1', taskId: 't2', action: 'a', result: 'failure', errorCls: 'TIMEOUT' });
  led.append('verification', { goalId: 'g2', acceptanceId: 'x', kind: 'file', verified: true });
  const rep = aggregate(dir, { lastDays: 7 });
  assert.equal(rep.goals.count, 10);
  assert.equal(rep.goals.completed, 9);
  assert.equal(rep.goals.durationMsP50, 50);
  assert.equal(rep.goals.durationMsP95, 100);
  assert.equal(rep.models.tokenTotal, 15);
  assert.deepEqual(rep.failureClasses, { TIMEOUT: 2 });
  assert.equal(rep.verification.count, 1);
  assert.match(renderReport(rep), /goals.*10|10.*goals/);
});

test('real objective run leaves an auditable trail end-to-end', async () => {
  const teleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-tele-run-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-tele-ws-'));
  const led = new TelemetryLedger(teleDir);
  const s = await runObjective('build a modern portfolio website and show it to me', { workspaceDir: ws, telemetry: led });
  assert.equal(s.goal.state, 'COMPLETED');
  const rep = aggregate(teleDir, { lastDays: 1 });
  assert.equal(rep.goals.count, 1);
  assert.equal(rep.goals.completed, 1);
  assert.ok(rep.verification.count >= 2, `want >=2 verifications, got ${rep.verification.count}`);
  assert.equal(rep.verification.successRate, 1);
});

test('event vocabulary is closed and smoking-tested in docs-relevant names', () => {
  assert.ok(TELEMETRY_EVENTS.includes('goal.finish'));
  assert.ok(TELEMETRY_EVENTS.includes('verification'));
  assert.ok(!TELEMETRY_EVENTS.includes('message.content'));
});
