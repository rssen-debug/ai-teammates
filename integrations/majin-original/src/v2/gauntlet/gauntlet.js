/**
 * MAJIN GAUNTLET (master brief sections 41-43).
 *
 * Deterministic scenario engine: each scenario drives a real goal through the
 * DAG scheduler and the verifier registry, then an adjudicator checks the
 * OUTCOME (not the model's claims). Reports two headline numbers the product
 * is built on (brief 42): verified task success rate and false-success rate.
 * Zero new dependencies — this is why the kernel exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Goal } from '../runtime/goal.js';
import { runGraph } from '../runtime/scheduler.js';

export const GAUNTLET_SCHEMA = 'majin.v2.gauntlet-report/v1';

/**
 * runGauntlet({ scenarios, outDir? })
 * scenario: { id, title, kind:'pass_expected'|'block_expected', build(goal)->{graph,execute,cleanup?}, adjudicate({goal,summary})->{ok,reason} }
 */
export async function runGauntlet({ scenarios, outDir = null } = {}) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) throw new Error('runGauntlet requires scenarios');
  const started = Date.now();
  const results = [];

  for (const sc of scenarios) {
    const t0 = Date.now();
    const goal = new Goal({ objective: sc.title, acceptance: sc.acceptance || [], risk: 'low' });
    goal.transition('PLANNING'); goal.transition('READY'); goal.transition('RUNNING');
    let summary;
    let error = null;
    let cleanup = null;
    try {
      const built = await sc.build(goal);
      cleanup = built.cleanup || null;
      ({ summary } = await runGraph({ goal, graph: built.graph, execute: built.execute, concurrency: built.concurrency || 2 }));
      // honest completion policy: only pass_expected scenarios may attempt COMPLETED
      if (sc.kind === 'pass_expected') {
        goal.transition('VERIFYING');
        const verifyFn = built.verify || sc.verify;
        if (typeof verifyFn === 'function') await verifyFn(goal); // independent proofs -> receipts
        try { goal.complete(); } catch { /* missing evidence -> goal stays VERIFYING; report reads it */ }
      } else {
        goal.transition('FAILED', 'expected-blocking scenario');
      }
    } catch (err) {
      error = String(err.message || err);
      if (goal.state !== 'FAILED' && goal.state !== 'CANCELLED') {
        try { goal.transition('FAILED', `harness error: ${error}`); } catch { /* already terminated */ }
      }
    } finally {
      if (cleanup) await cleanup().catch(() => {});
    }
    const adjudication = sc.adjudicate({ goal, summary, error });
    results.push({
      id: sc.id,
      title: sc.title,
      durationMs: Date.now() - t0,
      goalState: goal.state,
      completed: goal.state === 'COMPLETED',
      receipts: goal.receipts.length,
      verifiedReceipts: goal.receipts.filter((r) => r.verified).length,
      graphSummary: summary || null,
      pass: adjudication.ok,
      reason: adjudication.reason,
    });
  }

  // Headline metrics (brief 42): verified success + false success.
  // False success = scenario reported pass while its goal did NOT reach COMPLETED with verified evidence...
  // ...which our kernel prevents by construction, so the number must be zero or the kernel is broken.
  const passed = results.filter((r) => r.pass).length;
  const falseSuccess = results.filter((r) => r.pass && !r.completed && r.goalState !== 'FAILED').length;
  const report = {
    schema: GAUNTLET_SCHEMA,
    at: new Date().toISOString(),
    durationMs: Date.now() - started,
    scenarios: results.length,
    passed,
    failed: results.length - passed,
    verifiedSuccessRate: results.length === 0 ? 0 : passed / results.length,
    falseSuccessCount: falseSuccess,
    results,
  };

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'gauntlet-report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(outDir, 'gauntlet-report.md'), renderMarkdown(report));
  }
  return report;
}

function renderMarkdown(report) {
  const lines = [
    '# MAJIN GAUNTLET — report',
    '',
    `- run: ${report.at}`,
    `- scenarios: ${report.scenarios} | passed: ${report.passed} | failed: ${report.failed}`,
    `- verified success rate: ${(report.verifiedSuccessRate * 100).toFixed(0)}%`,
    `- false successes: ${report.falseSuccessCount}`,
    '',
    '| scenario | verdict | goal state | receipts (verified) | time |',
    '|---|---|---|---|---|',
  ];
  for (const r of report.results) {
    lines.push(`| ${r.id} ${r.title} | ${r.pass ? 'PASS' : 'FAIL'} ${r.reason || ''} | ${r.goalState} | ${r.receipts} (${r.verifiedReceipts}) | ${r.durationMs}ms |`);
  }
  return lines.join('\n') + '\n';
}
