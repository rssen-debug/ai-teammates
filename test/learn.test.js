import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LessonStore, renderStats, VERSION } from '../src/core/learn.js';

const mk = () => new LessonStore(fs.mkdtempSync(path.join(os.tmpdir(), 'majin-learn')));

test('W10 new failure records UNVERIFIED — never born verified', () => {
  const s = mk();
  const r = s.record({ trigger: 'window.S was undefined in classic script globals', lesson: 'alias explicitly', fix: 'window.S = S' });
  assert.equal(r.ok, true);
  assert.equal(r.occasion, 'new');
  assert.equal(r.record.status, 'unverified');
  assert.match(r.record.id, /^les-[0-9a-f]{12}$/);
});

test('W10 verify REFUSES bald claims and ACCEPTS measured proof', () => {
  const s = mk();
  const { record } = s.record({ trigger: 'stream content leaked across chat switch' });
  const bad = s.verify({ id: record.id, proof: 'fixed' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'proof_required');
  const good = s.verify({ id: record.id, proof: 'ui-repair gate P0.6a: 30/30 green incl. cross-leak measurement' });
  assert.equal(good.ok, true);
  assert.equal(good.record.status, 'verified');
  assert.equal(good.record.proofs.length, 1);
});

test('W10 a VERIFIED lesson that re-occurs is DEMOTED with its proof history intact', () => {
  const s = mk();
  const trig = 'P0.5 gate flickered on restart coherence';
  const { record } = s.record({ trigger: trig });
  s.verify({ id: record.id, proof: 'node --test restart-coherence: s1 and s2 persisted_solve PASS' });
  const re = s.record({ trigger: trig, fix: 'tighter hook text' });
  assert.equal(re.occasion, 'regression');
  assert.equal(re.record.status, 'regressed');
  assert.equal(re.record.demotions, 1);
  assert.equal(re.record.count, 2);
  assert.equal(re.record.proofs.length, 1, 'old proof is archived, never erased — the record stays honest');
});

test('W10 same-trigger re-occurrence BEFORE verify keeps status + counts up', () => {
  const s = mk();
  const { record } = s.record({ trigger: 'overlapping discovery from two dirs skips nothing' });
  const re = s.record({ trigger: 'OVERLAPPING   discovery from two dirs skips nothing' });
  assert.equal(re.occasion, 'reoccurrence');
  assert.equal(re.record.status, 'unverified');
  assert.equal(re.record.count, 2);
  assert.equal(re.record.id, record.id, 'normalized trigger dedupes to ONE lesson');
});

test('W10 stats put OPEN work first and count demotions as an honesty metric', () => {
  const s = mk();
  const a = s.record({ trigger: 'failure class alpha — repeated three times' }).record;
  s.verify({ id: a.id, proof: 'measured with gate A: 12/12 PASS across two runs' });
  s.record({ trigger: 'failure class alpha — repeated three times' }); // demotes
  s.record({ trigger: 'failure class beta — open and untouched' });
  const stats = s.stats();
  assert.equal(stats.total, 2);
  assert.equal(stats.openness, 2);
  assert.equal(stats.demotionsTotal, 1);
  const t = renderStats(stats, VERSION);
  assert.match(t, /OPEN \(unverified \+ regressed\): 2/);
  assert.match(t, /proofs that did NOT hold/);
  /* listing sorts demoted-first so the worst is visible, not buried */
  assert.equal(s.list()[0].id, a.id);
});

test('W10 store survives restart (durable JSONL) and skips torn lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-learn-d'));
  const s = new LessonStore(dir);
  const rec = s.record({ trigger: 'durable lesson about restart survivability' }).record;
  fs.appendFileSync(s.file, '{broken json without id\n');
  const s2 = new LessonStore(dir);
  assert.equal(s2.list().length, 1);
  assert.equal(s2.list()[0].id, rec.id);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('W10 trigger must be concrete — "it broke" is not a lesson', () => {
  const s = mk();
  assert.equal(s.record({ trigger: 'bad' }).ok, false);
  assert.match(s.record({ trigger: '  ' }).error.message, /concretely/);
});
