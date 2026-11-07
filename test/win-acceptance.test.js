import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { validateAcceptance, verdict, RULES } from '../scripts/verify-win-acceptance.mjs';

const good = () => ({
  suite: 'win-acceptance/1', machine: 'DESKTOP-X', os: 'Microsoft Windows NT 10.0.26100.0',
  at: '2026-10-21T10:00:00.000Z', interactive: true,
  steps: [
    { step: 'A1', title: 'pink cursor', status: 'PASS', evidence: 'canvas scan found #ff3ca5', artifact: 'shots/A1.png' },
    { step: 'A5', title: 'computer.use smoke', status: 'PASS', evidence: 'exit=0 of the smoke probe', artifact: null },
  ],
});

test('W12 a conformant report validates + ACCEPTED verdict', () => {
  assert.deepEqual(validateAcceptance(good()), []);
  assert.equal(verdict(good()), 'ACCEPTED');
});

test('W12 PASS without any artifact or evidence violates the DoD', () => {
  const d = good();
  d.steps[0] = { step: 'A1', title: 'pink cursor', status: 'PASS', evidence: '', artifact: null };
  const p = validateAcceptance(d);
  assert.ok(p.some((x) => /A1.*PASS without artifact/.test(x)), JSON.stringify(p));
});

test('W12 NOT TESTED blocks the verdict honestly (never silently passes)', () => {
  const d = good();
  d.steps.push({ step: 'A6', title: 'interactive desktop', status: 'NOT TESTED', evidence: 'service session', artifact: null });
  assert.equal(verdict(d), 'BLOCKED (NOT TESTED 1)');
  assert.deepEqual(validateAcceptance(d), [], 'NOT TESTED is a legal, honest status');
  assert.ok(validateAcceptance(d, { requireAllPass: false }).length === 0);
});

test('W12 DoD-required steps must exist — their absence is a contract violation', () => {
  const d = good();
  d.steps = d.steps.filter((s) => s.step !== 'A5');
  assert.ok(validateAcceptance(d).some((x) => /A5.*missing/.test(x)));
});

test('W12 interactive must be an explicit boolean — "probably" is rejected', () => {
  const d = good(); d.interactive = 'yes, I think so';
  assert.ok(validateAcceptance(d).some((x) => /interactive must be a boolean/.test(x)));
});

test('W12 the runner ps1 stays Windows PowerShell 5.1-safe (CI lesson: ternary dies there)', () => {
  const ps = fs.readFileSync(new URL('../qa/win-acceptance/run-all.ps1', import.meta.url), 'utf8');
  assert.equal(/\?\s*'[^']*'\s*:/.test(ps), false, 'PS7-only ternary detected — windows-latest service shell is powershell 5.1');
  assert.equal(/&&|\|\|/.test(ps.split('\n').filter((l) => !/also|http/i.test(l) || /status =/.test(l)).join('\n')), false, 'PS7-only && or || in runner ps1');
});

test('W12 release gate: required steps that are NOT PASS block --gate mode', () => {
  const d = good();
  d.steps[1].status = 'FAIL';
  d.steps[1].evidence = 'smoke exited 1';
  const p = validateAcceptance(d, { requireAllPass: true });
  assert.ok(p.some((x) => /A5 is FAIL/.test(x)));
  assert.equal(verdict(d), 'BLOCKED (FAIL 1)');
});
