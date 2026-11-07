import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadMatrix, report, score, validateMatrix } from '../../scripts/v4/progress.mjs';

test('progress: the shipped matrix is structurally valid', () => {
  const matrix = loadMatrix();
  const r = report(matrix);
  assert.deepEqual(r.errors, [], r.errors.join('\n'));
  assert.equal(r.weight, 100);
  assert.ok(r.criteria >= 50);
});

test('progress: a matrix whose weights do not sum to 100 is rejected', () => {
  const bad = { categories: [{ id: 'X', title: 'x', criteria: [{ id: 'a', weight: 60, status: 'NOT_STARTED', title: 'a' }] }] };
  const { errors } = validateMatrix(bad);
  assert.ok(errors.some((e) => e.includes('must be exactly 100')));
});

test('progress: VERIFIED without evidence is refused', () => {
  const bad = {
    categories: [{ id: 'X', title: 'x', criteria: [{ id: 'a', weight: 100, status: 'VERIFIED', title: 'a' }] }],
  };
  const { errors } = validateMatrix(bad);
  assert.ok(errors.some((e) => e.includes('VERIFIED without evidence')));
});

test('progress: evidence must point at a real artifact kind', () => {
  const bad = {
    categories: [{
      id: 'X',
      title: 'x',
      criteria: [{ id: 'a', weight: 100, status: 'VERIFIED', title: 'a', evidence: 'trust me' }],
    }],
  };
  const { errors } = validateMatrix(bad);
  assert.ok(errors.some((e) => e.includes('must reference a real artifact')));
});

test('progress: BLOCKED criteria must state a blocker', () => {
  const bad = { categories: [{ id: 'X', title: 'x', criteria: [{ id: 'a', weight: 100, status: 'BLOCKED', title: 'a' }] }] };
  const { errors } = validateMatrix(bad);
  assert.ok(errors.some((e) => e.includes('BLOCKED without a stated blocker')));
});

test('progress: score counts VERIFIED fully and PARTIAL at half', () => {
  const matrix = {
    categories: [{
      id: 'X',
      title: 'x',
      criteria: [
        { id: 'a', weight: 40, status: 'VERIFIED', title: 'a', evidence: 'test/v4/security.test.js' },
        { id: 'b', weight: 40, status: 'PARTIAL', title: 'b' },
        { id: 'c', weight: 20, status: 'BLOCKED', title: 'c', blocker: 'no host' },
      ],
    }],
  };
  assert.equal(score(matrix).earned, 60);
});

test('progress: the reported score is derived, never stored', () => {
  const matrix = loadMatrix();
  const file = JSON.stringify(matrix);
  assert.ok(!/"percent"/.test(file), 'no hand-written percentage may live in the matrix');
  assert.ok(!/"earned"/.test(file), 'no hand-written total may live in the matrix');
});

test('progress: PROGRESS.md matches the computed score', () => {
  const matrix = loadMatrix();
  const r = report(matrix);
  const md = fs.readFileSync(new URL('../../docs/v4/PROGRESS.md', import.meta.url), 'utf8');
  assert.ok(md.includes(`${r.score.earned}/${r.score.possible}`), `PROGRESS.md must state ${r.score.earned}/${r.score.possible}`);
  assert.ok(md.includes(`${r.score.percent}%`), `PROGRESS.md must state ${r.score.percent}%`);
});

test('progress: matrix is machine readable and stable', () => {
  const matrix = loadMatrix();
  const tmp = path.join(os.tmpdir(), `majin-matrix-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(matrix));
  assert.deepEqual(loadMatrix(tmp).categories.length, matrix.categories.length);
  fs.unlinkSync(tmp);
});
