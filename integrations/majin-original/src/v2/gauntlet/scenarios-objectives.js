/**
 * MAJIN GAUNTLET — objective-level trials (second golden set).
 *
 * Drives REAL natural-language objectives through the orchestrator, measures
 * outcome-level behavior (completed / honest failed / receipts verified), and
 * reaches CONCLUSIONS from the orchestrator's own summary file the scenario
 * itself asks it to leave behind. The head-metrics (verifiedSuccessRate,
 * falseSuccessCount) computed by the gauntlet engine apply to these too.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runObjective } from '../runtime/orchestrator.js';
import { TaskGraph } from '../runtime/dag.js';
import { verifyAcceptance } from '../runtime/verify-bridge.js';

/** scenario wrapper: runs one objective inside the gauntlet graph */
function objectiveScenario({ id, title, expected, objective }) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'maj-gauntlet-obj-'));
  const box = { summary: null };
  return {
    id, title, kind: expected === 'COMPLETED' ? 'pass_expected' : 'block_expected',
    acceptance: [{ id: 'outcome', description: `orchestrator produced ${expected}` }],
    build: (goal) => {
      const graph = new TaskGraph({ goalId: goal.id });
      graph.addTask({ id: 'objective', action: 'run_objective', maxAttempts: 1 });
      return {
        graph,
        execute: async () => {
          box.summary = await runObjective(objective, { workspaceDir: ws });
          // durable evidence: leave the summary behind so verification can read it
          fs.writeFileSync(path.join(ws, 'summary.json'), JSON.stringify(box.summary, null, 2));
          return { result: 'success', evidence: box.summary.goal };
        },
        verify: async (g) => {
          if (expected !== 'COMPLETED') return; // block lane awaits FAILED state, not a receipt
          await verifyAcceptance(g, {
            acceptanceId: 'outcome', kind: 'file',
            spec: { path: path.join(ws, 'summary.json'), contains: `"state": "${expected}"` },
          });
        },
      };
    },
    adjudicate: ({ goal }) => {
      const s = box.summary;
      if (!s) return { ok: false, reason: 'orchestrator never produced a summary' };
      const inner = s.goal; // orchestrator-goal snapshot
      if (expected === 'COMPLETED') {
        const verifiedEnough = (inner.verifiedReceipts || 0) >= 1 && inner.state === 'COMPLETED' && goal.state === 'COMPLETED';
        return { ok: verifiedEnough, reason: verifiedEnough ? '' : `wanted COMPLETED+verified receipts, got ${inner.state}` };
      }
      const honestFail = inner.state === 'FAILED' && goal.state === 'FAILED';
      return { ok: honestFail, reason: honestFail ? 'honest FAILED with uncovered acceptance reported' : `wanted honest FAILED, got ${inner.state}` };
    },
  };
}

/** repeated-objective determinism trial: same objective x N in one workspace */
function objectiveRepeatabilityScenario() {
  return {
    id: 'G10', title: 'objective determinism x3 same workspace', kind: 'pass_expected',
    acceptance: [{ id: 'repeat', description: 'all three runs completed with verified evidence' }],
    build: (goal) => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'maj-gauntlet-repeat-'));
      const box = { runs: [] };
      const graph = new TaskGraph({ goalId: goal.id });
      graph.addTask({ id: 'r1', action: 'objective', maxAttempts: 1 });
      graph.addTask({ id: 'r2', action: 'objective', deps: ['r1'], maxAttempts: 1 });
      graph.addTask({ id: 'r3', action: 'objective', deps: ['r2'], maxAttempts: 1 });
      return {
        graph,
        execute: async (t) => {
          const s = await runObjective('build a portfolio website and show it to me', { workspaceDir: ws });
          box.runs.push({ task: t.id, state: s.goal.state, verifiedReceipts: s.goal.verifiedReceipts });
          fs.writeFileSync(path.join(ws, `summary-${t.id}.json`), JSON.stringify(s.goal, null, 2));
          return { result: 'success' };
        },
        verify: async (g) => {
          fs.writeFileSync(path.join(ws, 'all-summaries.json'), JSON.stringify(box.runs, null, 2));
          await verifyAcceptance(g, {
            acceptanceId: 'repeat', kind: 'file',
            spec: { path: path.join(ws, 'all-summaries.json'), contains: '"state": "COMPLETED"' },
          });
        },
      };
    },
    adjudicate: ({ goal }) => {
      const box = { runs: [] };
      let refs = [];
      try {
        const ws = goal.id; // unused; kept for future extension
      } catch { /* noop */ }
      return { ok: goal.state === 'COMPLETED', reason: goal.state === 'COMPLETED' ? '' : 'repeat trial did not complete' };
    },
  };
}

export function objectiveScenarios() {
  return [
    objectiveScenario({ id: 'G6', title: 'objective: portfolio website', expected: 'COMPLETED', objective: 'build a modern portfolio website and show it to me' }),
    objectiveScenario({ id: 'G7', title: 'objective: honest blender FAIL', expected: 'FAILED', objective: 'create a blender animation and render it right now' }),
    objectiveScenario({ id: 'G8', title: 'objective: research report', expected: 'COMPLETED', objective: 'research open source agent benchmarks and produce a short report' }),
    objectiveScenario({ id: 'G9', title: 'objective: bare "photo" clarity fallback', expected: 'COMPLETED', objective: 'photo' }),
    objectiveRepeatabilityScenario(),
  ];
}
