/**
 * MAJIN GAUNTLET — deterministic local scenarios (first golden set).
 *
 * Every scenario is hardware-free and repeatable: the executor does real work
 * (writes files, serves HTTP, draws pixels), the verifier is INDEPENDENT
 * (bridge through verifierRegistry), and the adjudicator judges the outcome —
 * never the model's own "done".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PNG } from 'pngjs';
import { TaskGraph } from '../runtime/dag.js';
import { verifyAcceptance } from '../runtime/verify-bridge.js';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'maj-gauntlet-'));

/** G1 — create a file, prove it independently. */
export function scenarioFileCreate() {
  return {
    id: 'G1', title: 'create+verify file', kind: 'pass_expected',
    acceptance: [{ id: 'file', description: 'artifact exists with content' }],
    build: (goal) => {
      const dir = scratch();
      const target = path.join(dir, 'index.txt');
      const graph = new TaskGraph({ goalId: goal.id });
      graph.addTask({ id: 'write', action: 'write_file' });
      return {
        graph,
        execute: async () => { fs.writeFileSync(target, 'MAJIN Gauntlet G1'); return { result: 'success', target }; },
        verify: (g) => verifyAcceptance(g, { acceptanceId: 'file', kind: 'file', spec: { path: target, contains: 'Gauntlet' } }),
      };
    },
    adjudicate: ({ goal }) => ({ ok: goal.state === 'COMPLETED', reason: goal.state === 'COMPLETED' ? '' : 'goal not completed with verified evidence' }),
  };
}

/** G2 — serve HTTP inside the goal, prove the 200, shut down cleanly. */
export function scenarioHttpServe() {
  return {
    id: 'G2', title: 'serve+verify http', kind: 'pass_expected',
    acceptance: [{ id: 'http', description: 'preview responds 200' }],
    build: (goal) => {
      let server = null;
      let url = '';
      const graph = new TaskGraph({ goalId: goal.id });
      graph.addTask({ id: 'serve', action: 'start_preview' });
      return {
        graph,
        execute: async () => {
          server = http.createServer((req, res) => { res.writeHead(200); res.end('gauntlet'); });
          await new Promise((r, e) => { server.once('error', e); server.listen(0, '127.0.0.1', r); });
          url = `http://127.0.0.1:${server.address().port}/`;
          return { result: 'success', target: url };
        },
        verify: (g) => verifyAcceptance(g, { acceptanceId: 'http', kind: 'http', spec: { url, status: 200 } }),
        cleanup: () => new Promise((r) => (server ? server.close(r) : r())),
      };
    },
    adjudicate: ({ goal }) => ({ ok: goal.state === 'COMPLETED', reason: goal.state === 'COMPLETED' ? '' : 'preview goal not verified' }),
  };
}

/** G3 — draw pixels, prove pink exists in the region (W12 pattern). */
export function scenarioPixelEvidence() {
  return {
    id: 'G3', title: 'pixel evidence', kind: 'pass_expected',
    acceptance: [{ id: 'pixel', description: 'pink overlay pixels present' }],
    build: (goal) => {
      const dir = scratch();
      const shot = path.join(dir, 'screen.png');
      const graph = new TaskGraph({ goalId: goal.id });
      graph.addTask({ id: 'draw', action: 'draw_overlay' });
      return {
        graph,
        execute: async () => {
          const png = new PNG({ width: 16, height: 12 });
          for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 24; png.data[i + 1] = 24; png.data[i + 2] = 24; png.data[i + 3] = 255; }
          for (let y = 2; y < 6; y += 1) for (let x = 3; x < 11; x += 1) {
            const i = (png.width * y + x) * 4;
            png.data[i] = 255; png.data[i + 1] = 0; png.data[i + 2] = 128; png.data[i + 3] = 255;
          }
          fs.writeFileSync(shot, PNG.sync.write(png));
          return { result: 'success', target: shot };
        },
        verify: (g) => verifyAcceptance(g, {
          acceptanceId: 'pixel', kind: 'pixel',
          spec: { pngPath: shot, region: { x: 3, y: 2, w: 8, h: 4 }, rgba: [255, 0, 128], minHits: 30 },
        }),
      };
    },
    adjudicate: ({ goal }) => ({ ok: goal.state === 'COMPLETED', reason: goal.state === 'COMPLETED' ? '' : 'pixel proof not verified' }),
  };
}

/** G4 — injected transient failure; recovery is the product. */
export function scenarioTransientRecovery() {
  return {
    id: 'G4', title: 'transient failure recovery', kind: 'pass_expected',
    acceptance: [{ id: 'rec', description: 'task recovered and completed' }],
    build: (goal) => {
      const dir = scratch();
      const target = path.join(dir, 'after-retry.txt');
      let attempts = 0;
      const graph = new TaskGraph({ goalId: goal.id });
      graph.addTask({ id: 'flaky', action: 'unstable-write', maxAttempts: 2 });
      return {
        graph,
        execute: async () => {
          attempts += 1;
          if (attempts === 1) { const e = new Error('ECONNRESET: injected transient'); e.code = 'ECONNRESET'; throw e; }
          fs.writeFileSync(target, `won after attempt ${attempts}`);
          return { result: 'success', target, evidence: { attempts } };
        },
        verify: (g) => verifyAcceptance(g, { acceptanceId: 'rec', kind: 'file', spec: { path: target, contains: 'attempt 2' } }),
      };
    },
    adjudicate: ({ goal, summary }) => {
      const retryReceipts = summary && summary.done === 1;
      const ok = goal.state === 'COMPLETED' && retryReceipts;
      return { ok, reason: ok ? 'recovered via policy retry' : 'recovery or completion missing' };
    },
  };
}

/** G5 — permanent failure must propagate; the goal reports FAILED, never "done anyway". */
export function scenarioHonestBlock() {
  return {
    id: 'G5', title: 'honest blocking (no fake success)', kind: 'block_expected',
    acceptance: [{ id: 'deploy', description: 'deploy proposed-only' }],
    build: (goal) => {
      const graph = new TaskGraph({ goalId: goal.id });
      graph.addTask({ id: 'build', action: 'build', maxAttempts: 3 });
      graph.addTask({ id: 'deploy', action: 'deploy', deps: ['build'] });
      return {
        graph,
        execute: async (t) => {
          if (t.id === 'build') { const e = new Error('SyntaxError: deliberate'); e.cls = 'BUILD_FAILURE'; throw e; }
          return { result: 'success' };
        },
      };
    },
    adjudicate: ({ goal, summary }) => {
      const s = summary || {};
      const deployNeverRan = (s.blocked || 0) === 1 && (s.done || 0) === 0;
      const ok = goal.state === 'FAILED' && deployNeverRan;
      return { ok, reason: ok ? 'failure propagated, deploy never executed' : 'wanted FAILED-with-blocked outcome' };
    },
  };
}

export function defaultScenarios() {
  return [scenarioFileCreate(), scenarioHttpServe(), scenarioPixelEvidence(), scenarioTransientRecovery(), scenarioHonestBlock()];
}
