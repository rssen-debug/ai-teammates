import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { safeJoin } from '../src/core/paths.js';

// V1 regression: dot-prefixed names are valid children, not parent traversal.
test('safeJoin accepts dot-prefixed child directories', () => {
  const root = path.resolve('safejoin-fixture');
  assert.equal(safeJoin(root, '..backup/file.txt').outside, false);
  assert.equal(safeJoin(root, '..hidden').outside, false);
});

test('safeJoin rejects actual traversal outside root', () => {
  const root = path.resolve('safejoin-fixture');
  assert.equal(safeJoin(root, '../escape.txt').outside, true);
  assert.equal(safeJoin(root, '..').outside, true);
  assert.equal(safeJoin(root, '../../escape.txt').outside, true);
});

test('safeJoin accepts ordinary children and root itself', () => {
  const root = path.resolve('safejoin-fixture');
  assert.equal(safeJoin(root, 'docs/one.txt').outside, false);
  assert.equal(safeJoin(root, '.').outside, false);
});
