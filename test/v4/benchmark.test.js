import assert from 'node:assert/strict';
import test from 'node:test';
import { runBenchmark } from '../../scripts/v4/benchmark.mjs';

// One run for all assertions: a benchmark is a measurement, not a fixture.
let shared = null;
const once = () => (shared ||= runBenchmark());

test('benchmark: every scenario passes and every receipt has evidence', async () => {
  const report = await once();
  assert.equal(report.failed, 0, JSON.stringify(report.results.filter((r) => !r.pass), null, 2));
  assert.equal(report.passRate, 100);
  assert.ok(report.scenarios >= 7);
  assert.equal(report.receipts, report.verifiedReceipts, 'no receipt is left unverified');
  assert.equal(report.toolCalls, report.verifiedToolCalls, 'no tool call is left unverified');
  assert.ok(report.latencyMs.p95 > 0);
  assert.equal(report.schema, 'majin.v4.benchmark/v1');
});

test('benchmark: the duplicate-request scenario really replays instead of re-running', async () => {
  const report = await once();
  const dup = report.results.find((r) => r.id === 'duplicate-request');
  assert.equal(dup.repeatStatus, 'replayed');
  assert.equal(dup.tools, 1, 'the tool ran once, not twice');
});

test('benchmark: a refused request is FAILED, not a silent completion', async () => {
  const report = await once();
  const bad = report.results.find((r) => r.id === 'bad-filename');
  assert.equal(bad.status, 'failed');
  assert.equal(bad.artifactOk, true, 'nothing escaped the workspace');
});
