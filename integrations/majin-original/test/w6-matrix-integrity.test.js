/**
 * WAVE 6 (§12) — acceptance-matrix integrity gate.
 * The matrix drifted TWICE (TOTAL row said 59 while rows earned 81; a PASS row
 * was never totaled). This test makes drift a CI failure forever: all five
 * representations of the earned total must agree, and PASS rows need evidence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { checkMatrixText, checkMatrixFile } from '../scripts/matrix-check.mjs';

const MATRIX = path.resolve(import.meta.dirname, '..', 'docs', 'COMPLETION_MATRIX.md');

test('w6: the real matrix is self-consistent (all five totals agree)', () => {
  const r = checkMatrixFile(MATRIX);
  assert.deepEqual(r.problems, [], `matrix problems: ${r.problems.join(' | ')}`);
  assert.equal(r.totals.header, r.totals.phaseSum);
  assert.equal(r.totals.header, r.totals.totalRow);
  assert.equal(r.totals.header, r.totals.delSum);
  assert.equal(r.totals.header, r.totals.rowSum);
  assert.equal(r.totals.maxHeader, 100);
  assert.ok(r.detailRows >= 50, 'detail rows actually parsed');
});

const GOOD = `# M
**Score so far: 3 / 4** (x).
| Phase | Max | Earned |
|---|---:|---:|
| 1. A | 4 | 3 |
| **TOTAL** | **4** | **3** |
## DEL 1 — A (3/4)
| ID | Pts | Required | Evidence + reproduction | Env | Commit | Status | Verified |
|---|---:|---|---|---|---|---|---|
| 1A | 2 | r | node --test x | mock | abc | PASS | 2026-10-20 |
| 1B | 1 | r | live evidence here | mock | abc | PASS | 2026-10-20 |
| 1C | 1 | r | — | — | — | UNVERIFIED | 2026-10-20 |
`;

test('w6: a consistent matrix passes', () => {
  const r = checkMatrixText(GOOD);
  assert.ok(r.ok, `expected ok: ${r.problems}`);
  assert.equal(r.totals.rowSum, 3);
});

test('w6: a stale TOTAL row is caught (the 2026-10-19/20 bug class)', () => {
  const bad = GOOD.replace('| **TOTAL** | **4** | **3** |', '| **TOTAL** | **4** | **1** |');
  const r = checkMatrixText(bad);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('earned-total drift')), `drift must be named: ${r.problems}`);
});

test('w6: a never-totaled PASS row is caught (rowSum outruns phases)', () => {
  const bad = GOOD.replace('| 1. A | 4 | 3 |', '| 1. A | 4 | 2 |');
  const r = checkMatrixText(bad);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /rowSum=3/);
});

test('w6: PASS rows without an evidence cell are caught; header drift named', () => {
  const noEvidence = GOOD.replace('live evidence here | mock | abc | PASS', '— | mock | abc | PASS');
  const r1 = checkMatrixText(noEvidence);
  assert.equal(r1.ok, false);
  assert.ok(r1.problems.some((p) => p.includes('without an evidence cell')));
  const headerDrift = GOOD.replace('**Score so far: 3 / 4**', '**Score so far: 4 / 4**');
  const r2 = checkMatrixText(headerDrift);
  assert.equal(r2.ok, false);
  assert.ok(r2.problems.some((p) => p.includes('header=4')), 'header inflation must be visible');
});

test('w6: max-total drift is caught separately from earned drift', () => {
  const bad = GOOD.replace('| **TOTAL** | **4** | **3** |', '| **TOTAL** | **7** | **3** |');
  const r = checkMatrixText(bad);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('max-total drift')));
});
