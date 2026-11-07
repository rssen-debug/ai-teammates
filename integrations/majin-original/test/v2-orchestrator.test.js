/**
 * V2 orchestrator contracts: an objective cannot finish without real evidence.
 * The full stack runs in these tests: compile -> plan -> schedule -> build ->
 * bridge-verify (file AND live http server) -> receipt-gated completion, plus
 * the honest-failure lane (blender objective with render missing = FAILED).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runObjective } from '../src/v2/runtime/orchestrator.js';

test('objective -> website: runs the full stack, delivers files, verification real (incl. live http 200), completes', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-orch-site-'));
  const s = await runObjective('Build a portfolio website and show it to me', { workspaceDir: ws });
  assert.equal(s.goal.state, 'COMPLETED');
  assert.ok(fs.existsSync(path.join(ws, 'index.html')));
  assert.ok(s.produced.includes('styles.css'));
  const verified = s.verification.filter((v) => v.verified).length;
  assert.ok(verified >= 2, `expected file+http verified, got ${s.verification.length} items: ${JSON.stringify(s.verification)}`);
  assert.ok(s.goal.verifiedReceipts >= 2);
});

test('objective -> research report: generic template, still honestly acceptance-gated', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-orch-report-'));
  const s = await runObjective('research open source agent benchmarks and write a short report', { workspaceDir: ws });
  assert.equal(s.goal.state, 'COMPLETED');
  assert.ok(fs.existsSync(path.join(ws, 'report.md')));
});

test('objective -> blender: output.png never produced -> verification fails -> goal FAILED honestly (no fake success)', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-orch-blender-'));
  const s = await runObjective('create a blender animation and render it', { workspaceDir: ws });
  assert.equal(s.goal.state, 'FAILED');
  assert.ok(s.goal.uncovered.includes('render'));
  assert.ok(fs.existsSync(path.join(ws, 'scene.py')), 'partial artifacts reported as-is');
  assert.ok(!fs.existsSync(path.join(ws, 'output.png')));
});

test('orchestrator refuses without workspaceDir (no implicit destination)', async () => {
  await assert.rejects(() => runObjective('build a site', {}), /workspaceDir/);
});
