import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, toCents } from './genesis-expenses-fa1ba1768e.mjs';

test('empty rows return zero and empty map', () => {
  assert.deepEqual(summarize([]), { totalCents: 0, byCategory: {} });
});

test('simple totals per category', () => {
  const rows = [
    { category: 'food', amount: 12.5 },
    { category: 'food', amount: '7.25' },
    { category: 'travel', amount: 100 },
  ];
  assert.deepEqual(summarize(rows), {
    totalCents: 11975,
    byCategory: { food: 1975, travel: 10000 },
  });
});

test('avoids binary floating-point summation error (0.1 + 0.2)', () => {
  const rows = [
    { category: 'a', amount: 0.1 },
    { category: 'a', amount: 0.2 },
  ];
  assert.deepEqual(summarize(rows), { totalCents: 30, byCategory: { a: 30 } });
});

test('classic float drift case: many 0.01 additions', () => {
  const rows = Array.from({ length: 100 }, () => ({ category: 'x', amount: 0.01 }));
  assert.deepEqual(summarize(rows), { totalCents: 100, byCategory: { x: 100 } });
});

test('negative amounts and signs', () => {
  const rows = [
    { category: 'refund', amount: '-10.50' },
    { category: 'purchase', amount: 10.5 },
  ];
  assert.deepEqual(summarize(rows), {
    totalCents: 0,
    byCategory: { refund: -1050, purchase: 1050 },
  });
});

test('rejects missing category', () => {
  assert.throws(() => summarize([{ amount: 5 }]), TypeError);
  assert.throws(() => summarize([{ category: '', amount: 5 }]), TypeError);
  assert.throws(() => summarize([{ category: 42, amount: 5 }]), TypeError);
});

test('rejects invalid amounts', () => {
  for (const bad of ['abc', '1.234', '', '1,23', NaN, Infinity, -Infinity, null, undefined, {}]) {
    assert.throws(() => summarize([{ category: 'a', amount: bad }]), TypeError);
  }
});

test('rejects non-array and malformed rows', () => {
  assert.throws(() => summarize('nope'), TypeError);
  assert.throws(() => summarize([null]), TypeError);
  assert.throws(() => summarize([[1, 2]]), TypeError);
});

test('summary nests totals under byCategory, including for empty input', () => {
  const s = summarize([
    { category: 'food', amount: 0.3 },
    { category: 'travel', amount: -1.25 },
  ]);
  assert.deepEqual(s, { totalCents: -95, byCategory: { food: 30, travel: -125 } });
  assert.deepEqual(Object.keys(s), ['totalCents', 'byCategory']);
  assert.deepEqual(summarize([]), { totalCents: 0, byCategory: {} });
});

test('prototype-key categories (__proto__, constructor) are own keys', () => {
  const rows = [
    { category: '__proto__', amount: 1.01 },
    { category: 'constructor', amount: 2.99 },
    { category: '__proto__', amount: 0.5 },
  ];
  const s = summarize(rows);
  assert.equal(s.totalCents, 450);
  const expected = {};
  Object.defineProperty(expected, '__proto__', { value: 151, enumerable: true, writable: true, configurable: true });
  Object.defineProperty(expected, 'constructor', { value: 299, enumerable: true, writable: true, configurable: true });
  assert.deepEqual(s.byCategory, expected);
  assert.equal(Object.hasOwn(s.byCategory, '__proto__'), true);
  assert.equal(Object.hasOwn(s.byCategory, 'constructor'), true);
  assert.equal(s.byCategory.__proto__, 151);
  assert.equal(s.byCategory.constructor, 299);
  assert.deepEqual(Object.keys(s.byCategory).sort(), ['__proto__', 'constructor']);
});

test('toCents parses exact decimal strings', () => {
  assert.equal(toCents('12.34'), 1234);
  assert.equal(toCents('-0.05'), -5);
  assert.equal(toCents('+3'), 300);
  assert.equal(toCents('0.1'), 10);
  assert.equal(toCents('99.99'), 9999);
  assert.throws(() => toCents('1.234'), TypeError);
  assert.throws(() => toCents('.5'), TypeError);
});
