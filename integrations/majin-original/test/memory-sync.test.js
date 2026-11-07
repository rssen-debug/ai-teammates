import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Memory } from '../src/core/memory.js';
import { syncPair, spawnId, exportBundle, applyBundle, VERSION } from '../src/core/memory-sync.js';

function mkTemp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'majin-ms')); }
const cfgFor = (dir) => ({ get: (k) => (k === 'memory.dir' ? dir : undefined) });
function memIn(dir) { return new Memory(cfgFor(dir)); }

test('W9 paginated export never acknowledges revisions beyond its actual 500-delta page',()=>{
  const A=mkTemp(),B=mkTemp();
  const cfg=dir=>({get:k=>k==='memory.dir'?dir:k==='memory.maxNotes'?1000:undefined});
  const a=new Memory(cfg(A)),b=new Memory(cfg(B));
  try{
    for(let i=0;i<501;i++)a.remember(crypto.randomUUID());
    assert.equal(a.rev(),501);
    const first=exportBundle(a);assert.equal(first.deltas.length,500);assert.equal(first.toRev,500);
    applyBundle(b,first);assert.equal(b.facts().length,500);
    const second=exportBundle(a,{fromRev:first.toRev});assert.equal(second.deltas.length,1);assert.equal(second.toRev,501);
    applyBundle(b,second);assert.equal(b.facts().length,501);
  }finally{fs.rmSync(A,{recursive:true,force:true});fs.rmSync(B,{recursive:true,force:true});}
});

test('W9 two stores converge after EXACTLY one sync', () => {
  const A = mkTemp(), B = mkTemp();
  const a = memIn(A), b = memIn(B);
  a.remember('user likes espresso');
  b.remember('meeting is at 9am');
  const r = syncPair(a, b);
  assert.equal(r.ok, true);
  assert.ok(a.facts().some((f) => f.includes('meeting is at 9am')));
  assert.ok(b.facts().some((f) => f.includes('user likes espresso')));
  fs.rmSync(A, { recursive: true, force: true }); fs.rmSync(B, { recursive: true, force: true });
});

test('W9 sync is idempotent — second run transfers nothing', () => {
  const A = mkTemp(), B = mkTemp();
  const a = memIn(A), b = memIn(B);
  a.remember('fact one');
  b.remember('fact two');
  syncPair(a, b);
  const r2 = syncPair(a, b);
  assert.equal(r2.aReceived.applied, 0, 'second sync must have ZERO new work: ' + JSON.stringify(r2));
  assert.equal(r2.bReceived.applied, 0);
  fs.rmSync(A, { recursive: true, force: true }); fs.rmSync(B, { recursive: true, force: true });
});

test('W9 dryRun measures without writing a byte to either store', () => {
  const A = mkTemp(), B = mkTemp();
  const a = memIn(A), b = memIn(B);
  a.remember('do not copy me in plan mode');
  const before = { fa: a.facts().length, fb: b.facts().length, revA: a.rev(), revB: b.rev() };
  const r = syncPair(a, b, { dryRun: true });
  assert.equal(r.dryRun, true);
  assert.ok(r.bReceived.applied >= 1, 'dry-run still COUNTS what would transfer');
  assert.equal(a.rev(), before.revA);
  assert.equal(b.rev(), before.revB);
  assert.equal(b.facts().length, before.fb);
  assert.ok(!fs.existsSync(path.join(B, 'memory-sync-ledger.json')), 'no ledger write in dry-run');
  fs.rmSync(A, { recursive: true, force: true }); fs.rmSync(B, { recursive: true, force: true });
});

test('W9 tombstone replay: forget on one store removes the fact from the peer', () => {
  const A = mkTemp(), B = mkTemp();
  const a = memIn(A), b = memIn(B);
  a.remember('temporary fact to be purged');
  syncPair(a, b);
  assert.ok(b.facts().some((f) => /temporary fact/.test(f)));
  a.forget('temporary fact');
  const r2 = syncPair(a, b);
  assert.ok(!b.facts().some((f) => /temporary fact/.test(f)), 'tombstone must propagate');
  assert.ok(!a.facts().some((f) => /temporary fact/.test(f)), 'resurrected echo must NOT re-add my own deletion');
  assert.ok(r2.aReceived.skippedResurrected >= 1, 'the echo must be COUNTED, not swallowed silently: ' + JSON.stringify(r2.aReceived));
  fs.rmSync(A, { recursive: true, force: true }); fs.rmSync(B, { recursive: true, force: true });
});

test('W9 same-store attempt is refused honestly (cloned dir protection)', () => {
  const A = mkTemp(), B = mkTemp();
  const a = memIn(A);
  const r = syncPair(a, a);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'same_store');
  fs.rmSync(A, { recursive: true, force: true }); fs.rmSync(B, { recursive: true, force: true });
});

test('W9 bundle carries its provenance and stays in contract', () => {
  const A = mkTemp();
  const a = memIn(A);
  a.remember('provenance fact');
  const b = exportBundle(a, {});
  assert.equal(b.version, VERSION);
  assert.ok(b.origin.startsWith('mem-'));
  assert.equal(b.rev, undefined);
  assert.ok(b.toRev >= 1);
  assert.equal(applyBundle(a, b).skippedSelf, true, 'never apply my own bundle to myself');
  fs.rmSync(A, { recursive: true, force: true });
});
