/**
 * WAVE 5 (§19) — perf lab A/B/C/D assertions.
 * Direction-asserted with WIDE margins (CI timers are noisy); structure and
 * honesty guarantees are asserted exactly. The lab script's own numbers are
 * written to docs/SWARM_PERFORMANCE.md + docs/evidence/ by the CLI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runBench } from '../scripts/perf-topology-bench.mjs';

test('w5: bench produces a full A/B/C/D report with honest shapes', async () => {
  const b = await runBench({ scale: 0.5, runs: 3 });
  assert.ok(b.scenarios.A && b.scenarios.B && b.scenarios.C && b.scenarios.D, 'all four labs present');
  for (const k of ['A', 'B']) {
    const s = b.scenarios[k];
    assert.ok(Number.isFinite(s.cpMedianMs) && s.cpMedianMs > 0, `${k} cp median measured`);
    assert.ok(Number.isFinite(s.legacyMedianMs) && s.legacyMedianMs > 0, `${k} legacy median measured`);
    assert.ok(s.ratio > 0, `${k} ratio computed from real medians`);
  }
  assert.ok(b.scenarios.C.adaptive.contractionEvents >= 1, 'C: contraction fired under 11x overrun');
  assert.match(b.scenarios.C.tradeNote, /never a speedup/, 'C is reported as a trade, honestly');
  assert.equal(b.scenarios.C.legacy.contractionEvents, 0, 'legacy never contracts');
  assert.ok(b.scenarios.D.rank2000Ms < 500, `ranker stays cheap on 2 000 nodes (${b.scenarios.D.rank2000Ms}ms)`);
  assert.equal(b.scenarios.D.ranksComputed, 2000);
});

test('w5: B — CP-first does not regress a deep-chain workload (direction, wide margin)', async () => {
  const b = await runBench({ scale: 0.6, runs: 3 });
  /* Shorts-first declaration order delays the critical chain; CP-first must be
     at least as good, with generous upward tolerance for CI noise (×1.15). */
  assert.ok(b.scenarios.B.ratio <= 1.15, `B ratio ${b.scenarios.B.ratio} — CP-first must not lose to declaration order`);
});

test('w5: A — heterogeneous fan-out within tolerance both ways (work-conserving family)', async () => {
  const b = await runBench({ scale: 0.5, runs: 3 });
  assert.ok(b.scenarios.A.ratio >= 0.75 && b.scenarios.A.ratio <= 1.35, `A ratio ${b.scenarios.A.ratio} sane`);
});

test('w5: C — contraction evidence is structural, not timing luck', async () => {
  const b = await runBench({ scale: 0.5, runs: 3 });
  assert.equal(b.scenarios.C.adaptive.capReduced, true, 'cap actually contracted below capBefore under sustained overrun');
  /* structural note: frozenCap = width at proof-time, so capNow is 1..2 here
     (siblings of the first finisher can still be in flight); reduced < before
     is the honest invariant, not an exact target width. */
});

test('w5: CLI writes evidence JSON and refreshes the scorecard section', { timeout: 60000 }, async (t) => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const out = execFileSync(process.execPath, ['scripts/perf-topology-bench.mjs', '--scale', '0.4', '--runs', '3'], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.match(out, /perf lab A\/B\/C\/D/, 'CLI printed the markdown section');
  assert.match(out, /evidence: .*perf-topology-\d{4}-\d{2}-\d{2}\.json/, 'CLI wrote an evidence file');
  const sc = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'docs', 'SWARM_PERFORMANCE.md'), 'utf8');
  assert.ok(sc.includes('<!-- PERFLAB:BEGIN -->'), 'scorecard section markers installed');
  assert.ok(/WAVE 5 \(§19\) perf lab/.test(sc), 'markdown landed in the scorecard');
});
