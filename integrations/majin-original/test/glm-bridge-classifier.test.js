import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../scripts/verify-glm-bridge.mjs';

test('GLM-probe classifier: 200 → live lane OPEN', () => {
  assert.deepEqual(classify({ httpCode: 200 }).open, true);
});

test('GLM-probe classifier: 401 is an AUTH answer — never masked as network', () => {
  const r = classify({ httpCode: 401, body: '{"error":{"code":"401","message":"令牌已过期或验证不正确"}}' });
  assert.equal(r.open, false);
  assert.match(r.verdict, /expired|invalid/i);
  assert.match(r.verdict, /never a network/i);
});

test('GLM-probe classifier: 0 (curl transport failure) is UNREACHABLE, distinct from auth', () => {
  const r = classify({ httpCode: 0 });
  assert.equal(r.open, false);
  assert.match(r.verdict, /UNREACHABLE/);
  assert.ok(!/AUTH/i.test(r.verdict), 'transport and auth answers must stay separable');
});

test('GLM-probe classifier: unknown codes surface for human inspection, never force a verdict', () => {
  const r = classify({ httpCode: 418 });
  assert.equal(r.open, false);
  assert.match(r.verdict, /UNKNOWN/);
});
