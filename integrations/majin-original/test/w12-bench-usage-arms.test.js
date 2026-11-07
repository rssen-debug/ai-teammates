/* WAVE 12 (§3) — bench usage arms: per-scenario requests/tokens/cost through
   the real Usage ledger, zero keys, mock arm.
   U1: every scenario row carries a usage object (visibility is mandatory)
   U2: ledger conservation — per-scenario deltas sum EXACTLY to the global
       summary (requests AND tokens); the bench verdict encodes it
   U3: free-by-design — every arm has costUsd === 0, total too
   U4: self-config's measured truth is documented (≤1 request — the intent
       parse) and must never silently grow past it (maxRequests: 1)
   U5: multi-step costs measurably more requests than a single-step turn —
       instrumentation can SEE the difference */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
let bench = null;
test('run bench once for all usage-arm assertions', { timeout: 120000 }, () => {
  const out = execFileSync(process.execPath, ['scripts/bench.mjs', '--json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  bench = JSON.parse(out.slice(out.indexOf('{')));
  assert.ok(bench.ok, `bench verdict: ${JSON.stringify(bench.totals)} ledger=${JSON.stringify(bench.usageLedger)}`);
});

test('U1: every scenario row carries a usage object with non-negative numbers', () => {
  assert.ok(bench.scenarios.length >= 7);
  for (const r of bench.scenarios) {
    assert.ok(r.usage && typeof r.usage === 'object', `${r.scenario} missing usage`);
    assert.ok(Number.isFinite(r.usage.requests) && r.usage.requests >= 0, `${r.scenario}: requests=${r.usage?.requests}`);
    assert.ok(Number.isFinite(r.usage.tokens) && r.usage.tokens >= 0);
    assert.ok(Number.isFinite(r.usage.costUsd));
  }
});

test('U2: ledger conservation — scenario deltas sum to the global summary', () => {
  assert.equal(bench.usageLedger.conservedRequests, true, JSON.stringify(bench.usageLedger));
  assert.equal(bench.usageLedger.conservedTokens, true);
  assert.equal(bench.usageLedger.requestsSum, bench.totals.requests);
  assert.equal(bench.usageLedger.tokensSum, bench.totals.tokens);
});

test('U3: free-by-design — every arm costs exactly 0 dollars', () => {
  assert.equal(bench.totals.costUsd, 0);
  for (const r of bench.scenarios) assert.equal(r.usage.costUsd, 0, `${r.scenario} spent money??`);
});

test('U4: self-config spends at most its measured intent-parse call (≤1) — and no more ever', () => {
  const sc = bench.scenarios.find((r) => r.scenario === 'self-config');
  assert.ok(sc, 'self-config scenario present');
  assert.ok(sc.usage.requests <= 1, `self-config regress its no-fast-path budget: ${sc.usage.requests} requests`);
  assert.ok(sc.usage.requests >= 0);
  assert.ok(sc.usage.costUsd === 0);
});

test('U5: a multi-step turn is visibly more expensive than a single-step one', () => {
  const multi = bench.scenarios.find((r) => r.scenario === 'multi-step');
  const single = bench.scenarios.find((r) => r.scenario === 'fs.write');
  assert.ok(multi.usage.requests > single.usage.requests, `${multi.usage.requests} !> ${single.usage.requests}`);
  assert.ok(multi.usage.tokens > single.usage.tokens);
});
