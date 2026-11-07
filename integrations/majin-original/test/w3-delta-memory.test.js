/**
 * WAVE 3 (§9) — delta memory protocol.
 * Rev-tracked mutations, append-only delta log, no-op write elimination,
 * bounded event stream via rev-stamped archives, and the session injection
 * ledger. All tests use isolated tmp dirs — real files, no mocks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Memory } from '../src/core/memory.js';

function tmpMemory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-w3-'));
  const cfg = { get: (k) => ({ 'memory.dir': dir }[k] ?? null) };
  return { mem: new Memory(cfg), dir };
}
const statSize = (f) => { try { return fs.statSync(f).size; } catch { return -1; } };

test('w3: add a fact bumps rev once and logs a delta entry with kind add', () => {
  const { mem, dir } = tmpMemory();
  assert.equal(mem.rev(), 0);
  const r = mem.remember('owner prefers dark interfaces');
  assert.equal(r.rev, 1);
  assert.equal(mem.rev(), 1);
  const deltas = mem.deltaSince(0);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].kind, 'add');
  assert.match(deltas[0].text, /dark interfaces/);
  assert.ok(statSize(path.join(dir, 'memory-state.json')) > 0, 'state persisted atomically');
});

test('w3: re-remembering the IDENTICAL fact is a provable no-op (no rewrite, no bump)', () => {
  const { mem } = tmpMemory();
  mem.remember('release party is on 2026-10-20');
  const before = statSize(mem.factsFile);
  const revBefore = mem.rev();
  const r2 = mem.remember('release party is on 2026-10-20');
  assert.equal(r2.unchanged, true, 'must be flagged as no-op');
  assert.equal(mem.rev(), revBefore, 'no revision bump for a zero-change write');
  assert.equal(statSize(mem.factsFile), before, 'no file rewrite for identical content');
  assert.equal(mem.deltaSince(revBefore).length, 0, 'no phantom delta entry');
  mem.remember('release party is on the 2026-10-20'); /* same token set as the original → true dedupe hit */
  assert.equal(mem.rev(), revBefore + 1, 'a REAL change still bumps');
  assert.equal(mem.deltaSince(revBefore)[0].kind, 'update');
});

test('w3: forget bumps only on actual removal; dead forgets cost nothing', () => {
  const { mem } = tmpMemory();
  mem.remember('temporary fact about zebra crossings');
  const revAfterAdd = mem.rev();
  const miss = mem.forget('completely unrelated quantum quibble');
  assert.equal(miss.removed, 0);
  assert.equal(mem.rev(), revAfterAdd, 'no-op forget = no bump, no rewrite');
  const hit = mem.forget('zebra crossings');
  assert.equal(hit.removed, 1);
  assert.equal(hit.rev, revAfterAdd + 1);
  const kinds = mem.deltaSince(0).map((d) => d.kind);
  assert.deepEqual(kinds, ['add', 'forget'], 'delta stream mirrors the truth');
});

test('w3: deltaSince is order-true and survives a torn log line', () => {
  const { mem } = tmpMemory();
  mem.remember('fact one about cats');
  mem.remember('fact two about dogs');
  mem.forget('dogs');
  fs.appendFileSync(mem.deltasFile, '{broken-json\n'); // torn write simulation
  const deltas = mem.deltaSince(0);
  assert.equal(deltas.length, 3, 'corrupt line skipped, not fatal');
  assert.deepEqual(deltas.map((d) => d.rev), [1, 2, 3], 'monotonic order preserved');
  assert.deepEqual(mem.deltaSince(2).map((d) => d.rev), [3]);
  assert.equal(mem.rev(), 3);
});

test('w3: compactEvents archives the full stream and bounds the active working set', () => {
  const { mem } = tmpMemory();
  for (let i = 0; i < 10; i++) mem.event('tick', { i });
  assert.equal(mem.recentEvents(100).length, 10);
  const res = mem.compactEvents(3);
  assert.equal(res.ok, true);
  assert.equal(res.kept, 3);
  assert.equal(res.total, 10, 'conservation: everything counted before trimming');
  assert.ok(fs.existsSync(res.archived), 'archive file written, nothing silently dropped');
  const archived = fs.readFileSync(res.archived, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(archived.length, 10, 'archive holds the full pre-rotation stream');
  assert.equal(mem.recentEvents(100).length, 3, 'active set now bounded');
  assert.deepEqual(mem.recentEvents(100).map((e) => e.i), [7, 8, 9], 'kept the NEWEST entries');
  const second = mem.compactEvents(3);
  assert.equal(second.archived, null, 'no archive when already within bounds');
});

test('w3: injection ledger persists across instances and exposes staleness', () => {
  const { mem, dir } = tmpMemory();
  mem.remember('ledger test fact');
  assert.equal(mem.staleness('chatA'), 1, 'never-injected session is fully stale');
  mem.noteInjected('chatA');
  assert.equal(mem.staleness('chatA'), 0);
  mem.remember('another ledger fact');
  assert.equal(mem.staleness('chatA'), 1, 'one mutation behind after new fact');
  /* restart simulation: a fresh Memory over the same dir reads the same ledger */
  const cfg2 = { get: (k) => ({ 'memory.dir': dir }[k] ?? null) };
  const mem2 = new Memory(cfg2);
  assert.equal(mem2.rev(), mem.rev(), 'rev survives restart');
  assert.equal(mem2.injectedRev('chatA'), mem.injectedRev('chatA'), 'ledger survives restart');
  assert.equal(mem2.staleness('chatA'), 1);
});
