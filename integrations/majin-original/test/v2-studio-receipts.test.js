/**
 * Studio receipts surface — the panel reads ONLY the tamper-evident chain.
 * Seeded with the REAL receipt factory + verify + AuditBind; no fixtures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventBus } from '../src/v2/runtime/events.js';
import { TelemetryLedger } from '../src/v2/telemetry/ledger.js';
import { AuditChain } from '../src/v2/audit/chain.js';
import { AuditBind } from '../src/v2/audit/bind.js';
import { makeReceipt, verify as verifyReceipt } from '../src/v2/runtime/receipts.js';
import { createStudioServer } from '../src/v2/studio/server.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'majin-rcpt-')); }

async function boot({ corrupt = false } = {}) {
  const dir = tmp();
  const telemetryDir = path.join(dir, 'telemetry');
  const auditDir = path.join(dir, 'audit');
  const bus = new EventBus();
  new TelemetryLedger(telemetryDir);
  const chain = new AuditChain(auditDir);
  const bind = new AuditBind(chain);
  // real receipts: one verified success, one unverified failure, one other-goal
  const r1 = verifyReceipt(makeReceipt({ goalId: 'g1', taskId: 't1', action: 'file:write', result: 'success' }), { method: 'fs.stat' });
  const r2 = makeReceipt({ goalId: 'g1', taskId: 't2', action: 'tool:run', result: 'failure', errorClass: 'DEPENDENCY_MISSING' });
  const r3 = verifyReceipt(makeReceipt({ goalId: 'g2', taskId: 't9', action: 'exec:cmd', result: 'success' }), { method: 'exit-code' });
  bind.recordReceipt(r1);
  bind.recordReceipt(r2);
  bind.recordReceipt(r3);
  if (corrupt) {
    const lines = fs.readFileSync(chain.file, 'utf8').trim().split('\n');
    const mid = JSON.parse(lines[1]);
    mid.payload.action = 'forged:action';
    lines[1] = JSON.stringify(mid);
    fs.writeFileSync(chain.file, lines.join('\n') + '\n');
  }
  const studio = createStudioServer({ bus, telemetryDir, auditDir });
  const bound = await studio.listen({ port: 0 });
  return { studio, bound, dir, hashes: [r1.hash, r2.hash, r3.hash] };
}

test('1. /api/receipts returns the REAL receipts with correct verified flags and hashes', async () => {
  const { studio, bound, hashes } = await boot();
  const res = await fetch(bound.url + '/api/receipts');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.count, 3);
  const byAction = Object.fromEntries(body.receipts.map((r) => [r.action, r]));
  assert.equal(byAction['file:write'].verified, true);
  assert.equal(byAction['tool:run'].verified, false, 'unverified receipts are shown AS unverified (?)');
  assert.equal(byAction['exec:cmd'].verified, true);
  assert.equal(byAction['file:write'].hash, hashes[0]);
  assert.equal(byAction['tool:run'].goalId, 'g1');
  await studio.close();
});

test('2. goalId filter narrows honestly; unknown goal → ok:true count:0 (never fabricated)', async () => {
  const { studio, bound } = await boot();
  const g1 = await (await fetch(bound.url + '/api/receipts?goalId=g1')).json();
  assert.equal(g1.count, 2);
  assert.ok(g1.receipts.every((r) => r.goalId === 'g1'));
  const none = await (await fetch(bound.url + '/api/receipts?goalId=does-not-exist')).json();
  assert.equal(none.ok, true);
  assert.equal(none.count, 0);
  assert.deepEqual(none.receipts, []);
  await studio.close();
});

test('3. corrupted chain → receipts WITHHELD with reason, not served as stale fact', async () => {
  const { studio, bound } = await boot({ corrupt: true });
  const body = await (await fetch(bound.url + '/api/receipts')).json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'HASH_MISMATCH');
  assert.deepEqual(body.receipts, []);
  assert.match(body.note, /withheld/);
  const tail = await (await fetch(bound.url + '/api/chain/tail')).json();
  assert.equal(tail.ok, false);
  assert.deepEqual(tail.entries, []);
  await studio.close();
});

test('4. /api/chain/tail returns the newest entries in order, n capped', async () => {
  const { studio, bound } = await boot();
  const tail = await (await fetch(bound.url + '/api/chain/tail?n=2')).json();
  assert.equal(tail.ok, true);
  assert.equal(tail.count, 2);
  assert.deepEqual(tail.entries.map((e) => e.seq), [2, 3]);
  assert.equal(tail.entries[1].kind, 'receipt');
  const capped = await (await fetch(bound.url + '/api/chain/tail?n=99999')).json();
  assert.ok(capped.count <= 100, 'cap enforced');
  await studio.close();
});

test('5. page carries the receipts panel with the live-refresh hook and stays zero-external', async () => {
  const { studio, bound } = await boot();
  const html = await (await fetch(bound.url + '/')).text();
  assert.match(html, /id="receipts-body"/);
  assert.match(html, /\/api\/receipts\?limit=/);
  assert.match(html, /goal\.receipt_verified/);
  assert.match(html, /withheld, not presented as fact/);
  assert.equal(/(src|href)\s*=\s*"https?:/i.test(html), false);
  await studio.close();
});
