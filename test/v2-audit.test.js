/**
 * Audit lane tests — the chain and the binding are verified against REAL
 * files and REAL child processes; no simulation (PINK CURSOR rule).
 */
import test from 'node:test';
import { privateFilePermissions } from '../src/v4/file-permissions.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AuditChain, AuditChainError, GENESIS, canonicalize, hashEntry } from '../src/v2/audit/chain.js';
import { AuditBind } from '../src/v2/audit/bind.js';
import { EventBus } from '../src/v2/runtime/events.js';
import { Approvals } from '../src/v2/safety/approvals.js';
import { TelemetryLedger } from '../src/v2/telemetry/ledger.js';
import { makeReceipt, verify as verifyReceipt } from '../src/v2/runtime/receipts.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO, 'bin', 'majin-v2.mjs');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'majin-audit-')); }

test('1. append/verify round-trip: chain intact, anchor equals computed head', () => {
  const dir = tmp();
  const chain = new AuditChain(dir);
  const e1 = chain.append('telemetry', { event: 'goal.start', goalId: 'g1' });
  const e2 = chain.append('event', { type: 'task.started', taskId: 't1' });
  const e3 = chain.append('receipt', { id: 'rcpt_x', hash: 'abc' });

  assert.equal(e1.prev, GENESIS);
  assert.equal(e2.prev, e1.hash);
  assert.equal(e3.seq, 3);

  const verdict = new AuditChain(dir).verify();
  assert.equal(verdict.ok, true);
  assert.equal(verdict.entries, 3);
  assert.equal(verdict.head, e3.hash);

  const anchor = JSON.parse(fs.readFileSync(path.join(dir, 'head.json'), 'utf8'));
  assert.equal(anchor.seq, 3);
  assert.equal(anchor.hash, e3.hash);
  assert.equal(privateFilePermissions(chain.file), true, 'audit chain is private under POSIX modes or NTFS ACLs');
});

test('2. tamper detection: editing a middle line breaks at the NEXT line with classified reason', () => {
  const dir = tmp();
  const chain = new AuditChain(dir);
  chain.append('a', { n: 1 });
  chain.append('b', { n: 2 });
  chain.append('c', { n: 3 });

  const lines = fs.readFileSync(chain.file, 'utf8').trimEnd().split('\n');
  const mid = JSON.parse(lines[1]);
  mid.payload.n = 999; // silent edit — the forged line itself still "recomputes" nothing valid
  lines[1] = JSON.stringify(mid);
  fs.writeFileSync(chain.file, lines.join('\n') + '\n');

  const verdict = new AuditChain(dir).verify();
  assert.equal(verdict.ok, false);
  assert.equal(verdict.brokenAt, 2);
  assert.equal(verdict.reason, 'HASH_MISMATCH');
});

test('3. truncation: deleting the newest lines is caught by the head anchor', () => {
  const dir = tmp();
  const chain = new AuditChain(dir);
  for (let i = 0; i < 4; i++) chain.append('event', { i });

  const lines = fs.readFileSync(chain.file, 'utf8').trimEnd().split('\n');
  fs.writeFileSync(chain.file, lines.slice(0, 2).join('\n') + '\n'); // cut entries 3-4

  const verdict = new AuditChain(dir).verify({ anchor: true });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'TRUNCATED');
  assert.equal(verdict.brokenAt, 2); // everything up to the cut still verifies
});

test('4. tamper guard: forged tail is diagnosed by verify AND extension is refused', () => {
  const dir = tmp();
  const chain = new AuditChain(dir);
  chain.append('event', { i: 1 });
  chain.append('event', { i: 2 });
  // attacker rewrites the tail line but keeps the file well-formed
  const lines = fs.readFileSync(chain.file, 'utf8').trimEnd().split('\n');
  const forged = JSON.parse(lines[1]);
  forged.payload.i = 666; // keep entry.hash — now stale
  lines[1] = JSON.stringify(forged);
  fs.writeFileSync(chain.file, lines.join('\n') + '\n');
  const reopened = new AuditChain(dir); // constructing must stay possible (read mode)
  const verdict = reopened.verify({ anchor: false });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'HASH_MISMATCH');
  assert.equal(verdict.brokenAt, 2);
  assert.throws(() => reopened.append('event', { i: 3 }), (err) => err instanceof AuditChainError && err.cls === 'DAMAGED_LOG');
});

test('5. damaged log refuses extension (clipped final line)', () => {
  const dir = tmp();
  const chain = new AuditChain(dir);
  chain.append('event', { i: 1 });
  fs.appendFileSync(chain.file, '{"seq":2,"ts":"incompl'); // crash-style partial write
  const reopened = new AuditChain(dir);
  assert.throws(() => reopened.append('event', { i: 2 }), (err) => err.cls === 'DAMAGED_LOG');
});

test('6. restart continuity: a reopened chain continues the SAME chain, prev links hold', () => {
  const dir = tmp();
  const a = new AuditChain(dir);
  a.append('event', { phase: 'before-restart' });
  const prev = a.prev;
  const b = new AuditChain(dir); // new process would do exactly this
  const cont = b.append('event', { phase: 'after-restart' });
  assert.equal(cont.prev, prev);
  assert.equal(new AuditChain(dir).verify().ok, true);
  assert.equal(new AuditChain(dir).verify().entries, 2);
});

test('7. binding: receipts + telemetry rows + consent lifecycle all land in the chain', () => {
  const dir = tmp();
  const chain = new AuditChain(path.join(dir, 'audit'));
  const bind = new AuditBind(chain);
  const bus = new EventBus();
  bind.attach(bus);

  // consent lifecycle through the REAL approvals class
  const approvals = new Approvals(bus);
  approvals.grant('voice:external', { user: 'tester', mode: 'once' });
  bus.emit('consent.revoked', { scope: 'voice:external' }); // same emitter path approvals.revoke uses

  // receipt through the REAL receipt factory + independent verify flip
  const r0 = makeReceipt({ goalId: 'g1', taskId: 't1', action: 'tool:run', result: 'success' });
  const r1 = verifyReceipt(r0, { method: 'independent-check', digest: crypto.createHash('sha256').update('x').digest('hex') });
  bind.recordReceipt(r1);

  // telemetry through the REAL ledger schema (unknown events still rejected there)
  const ledger = new TelemetryLedger(path.join(dir, 'telemetry'));
  const row = ledger.append('consent', { scope: 'voice:external', decision: 'allow', mode: 'once' });
  bind.recordTelemetryRow(row);

  // path/message content never enters the chain
  bind.recordEvent('task.started', { taskId: 't1', note: 'open C:\\Users\\secret\\file.txt ' + 'y'.repeat(400) });

  const verdict = chain.verify();
  assert.equal(verdict.ok, true);
  const kinds = fs.readFileSync(chain.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(kinds.length, 5);
  assert.deepEqual(kinds.map((e) => e.kind), ['consent', 'consent', 'receipt', 'telemetry', 'event']);
  const grantEntry = kinds[0];
  assert.equal(grantEntry.payload.taskId, 'consent:voice:external');
  assert.equal(grantEntry.payload.to, 'granted');
  const revokeEntry = kinds.find((e) => e.kind === 'consent' && e.payload.scope);
  assert.equal(revokeEntry.payload.scope, 'voice:external');
  const leash = kinds.find((e) => e.kind === 'event' && e.payload.note);
  assert.ok(leash.payload.note.length <= 256);
  const receiptEntry = kinds.find((e) => e.kind === 'receipt');
  assert.equal(receiptEntry.payload.verified, true);
  assert.equal(receiptEntry.payload.hash, r1.hash);
  bind.detach();
});

test('8. CLI --audit-verify: real child processes, ok exit 0 / broken exit 1 / usage exit 2', async () => {
  const dir = tmp();
  const auditDir = path.join(dir, 'audit');
  const chain = new AuditChain(auditDir);
  chain.append('event', { i: 1 });
  chain.append('event', { i: 2 });

  const run = (args) => new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { cwd: dir }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });

  const ok = await run(['--audit-verify', auditDir]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /AUDIT ok ENTRIES=2 HEAD=/);

  // break it: forge entry 2 keeping well-formed file, anchor now disagrees
  const lines = fs.readFileSync(chain.file, 'utf8').trimEnd().split('\n');
  fs.writeFileSync(chain.file, lines[0] + '\n');
  const broken = await run(['--audit-verify', auditDir]);
  assert.equal(broken.code, 1);
  assert.match(broken.stderr, /AUDIT broken LINE=1 REASON=TRUNCATED/);

  const usage = await run(['--audit-verify']);
  assert.equal(usage.code, 2);
});

test('9. canonical form is deterministic across key order (hash basis is stable)', () => {
  const a = canonicalize({ b: 2, a: { d: [1, 2], c: 'x' } });
  const b = canonicalize({ a: { c: 'x', d: [1, 2] }, b: 2 });
  assert.equal(a, b);
  // and hashEntry must ignore any extra/hash fields by construction
  const e1 = hashEntry({ seq: 1, ts: 't', kind: 'k', actor: 'a', payload: { z: 1, y: 2 }, prev: GENESIS });
  const e2 = hashEntry({ seq: 1, ts: 't', kind: 'k', actor: 'a', payload: { y: 2, z: 1 }, prev: GENESIS, hash: 'forged', extra: true });
  assert.equal(e1, e2);
});
