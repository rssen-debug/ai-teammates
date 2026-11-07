/**
 * V2 orchestrator (master brief sections 15-24): the single entry point that
 * runs a natural-language objective through the whole stack — compile ->
 * plan -> schedule -> build -> verify -> receipted completion (or honest
 * failure) — with no layer allowed to skip the next one's evidence gate.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Goal, newGoalId } from './goal.js';
import { runGraph } from './scheduler.js';
import { verifyAcceptance } from './verify-bridge.js';
import { compileGoal } from '../compiler/router.js';
import { plan } from '../supervisor/supervisor.js';
import { planWithModel } from '../supervisor/plan-with-model.js';

/** deterministic deliverable templates; honest content placeholders for now */
const TEMPLATES = [
  {
    match: /website|portfolio|landing|webbplats/,
    files: {
      'index.html': '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Portfolio</title><link rel="stylesheet" href="styles.css"></head><body><header><h1>Portfolio</h1></header><main><section id="intro">Built by MAJIN V2 orchestrator.</section></main><script src="script.js"></script></body></html>',
      'styles.css': ':root{color-scheme:light dark}body{font-family:system-ui;margin:0}header{padding:2rem;background:#111;color:#fff}main{padding:2rem}',
      'script.js': '// generated placeholder; interactive features arrive with the studio lane\nconsole.log("majin v2 site alive");\n',
    },
  },
  { match: /research|report/, files: { 'report.md': '# Research Report\n\n## Findings\nPending the research lane.\n\n## Sources\n(to be filled during research execution)\n' } },
  { match: /blender|scatter|3d/, files: { 'scene.py': 'import bpy\n"""MAJIN V2 scene builder placeholder; actual scene ops land with the blender lane."""\n' } },
  { match: /application|cv|job/, files: { 'application-draft.md': '# Application Draft\n\n(Tailoring pending the research lane context.)\n' } },
  { match: null, files: { 'PLAN.md': '# Plan\n\n## acceptance\nUnspecified objective — acceptance must be clarified in a planning pass.\n' } },
];

function templateFor(deliverable) {
  for (const t of TEMPLATES) if (t.match && t.match.test(deliverable)) return t;
  return TEMPLATES[TEMPLATES.length - 1];
}

/** tiny static server for http acceptance on a random local port */
function startPreviewServer(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      try {
        const p = path.join(root, decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\//, '') || 'index.html');
        const f = p.endsWith(path.sep) || !path.extname(p) ? path.join(p, 'index.html') : p;
        if (!f.replace(/\\/g, '/').startsWith(root.replace(/\\/g, '/'))) { res.writeHead(403).end(); return; }
        const buf = fs.readFileSync(f);
        const ext = path.extname(f);
        res.writeHead(200, { 'content-type': ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : 'text/html; charset=utf-8' });
        res.end(buf);
      } catch { res.writeHead(404).end('not found'); }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/**
 * runObjective(text, {workspaceDir, events}) -> summary
 * Retargets acceptance spec paths into the workspaceDir, and if any acceptance
 * needs http, starts a local preview and substitutes '<port>' in its url spec.
 */
export async function runObjective(objectiveText, { workspaceDir, events = null, compiled = null, provider = null, allowModel = true, telemetry = null, plannerWithModel = false } = {}) {
  if (!workspaceDir) throw new Error('runObjective requires workspaceDir');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const goal = new Goal({ id: newGoalId(), objective: objectiveText, events });
  const orchStart = Date.now();
  goal.transition('PLANNING', 'compiled');
  let compileMeta = { source: 'deterministic' };
  let goalObj = compiled;
  if (!goalObj) {
    ({ goal: goalObj, meta: compileMeta } = await compileGoal(objectiveText, { provider, allowModel }));
  }
  telemetry?.append('goal.start', { goalId: goal.id, objectiveLen: objectiveText.length, risk: null, compilerSource: compileMeta.source });
  goal.acceptance.push(...goalObj.acceptance.map((a) => ({ id: a.id, description: a.description })));
  goalObj.acceptance = goalObj.acceptance.map((a) => ({
    ...a,
    verify: { ...a.verify, spec: { ...a.verify.spec, path: a.verify.spec.path ? path.resolve(workspaceDir, a.verify.spec.path) : undefined } },
  }));

  let server = null;
  const needsHttp = goalObj.acceptance.some((a) => a.verify.kind === 'http');
  if (needsHttp) {
    server = await startPreviewServer(workspaceDir);
    const port = server.address().port;
    goalObj.acceptance = goalObj.acceptance.map((a) => a.verify.kind === 'http'
      ? { ...a, verify: { ...a.verify, spec: { ...a.verify.spec, url: a.verify.spec.url.replace('<port>', String(port)) } } }
      : a);
  }

  let plannerMeta = { source: 'template' };
  const summary = { goal: null, compiler: compileMeta, planner: plannerMeta, acceptance: goalObj.acceptance.length, produced: [], verification: [] };
  try {
    const planned = plannerWithModel && provider
      ? await planWithModel(goalObj, provider, { goalId: goal.id })
      : plan(goalObj, { goalId: goal.id });
    const { graph } = planned;
    plannerMeta = planned.meta || plannerMeta;
    summary.planner = plannerMeta;
    goal.transition('READY', 'plan compiled'); goal.transition('RUNNING', 'execution');

    const deliverableFiles = new Map();
    const verdict = await runGraph({
      goal, graph,
      execute: async (task) => {
        if (task.action === 'plan') return { result: 'success', evidence: { strategy: 'template', risk: goalObj.risk } };
        if (task.action.startsWith('build_')) {
          // Deliverable content comes from the COMPILED GOAL by index when
          // possible (planner-model actions like "fetch html skeleton"
          // describe work, they do not retype what an acceptance demands).
          const idx = Number((task.id.match(/^build:(\d+)$/) || [])[1]);
          const actionTail = task.action.replace(/^build_\d*:/, '').replace(/^build_/, '');
          const deliverable = (Number.isFinite(idx) && goalObj.deliverables[idx]) ? goalObj.deliverables[idx] : actionTail;
          const t = templateFor(deliverable);
          const written = deliverableFiles.get(task.id) || [];
          for (const [rel, content] of Object.entries(t.files)) {
            fs.writeFileSync(path.join(workspaceDir, rel), content);
            written.push(rel);
            summary.produced.push(rel);
          }
          deliverableFiles.set(task.id, written);
          return { result: 'success', target: written.join(',') };
        }
        if (task.action.startsWith('verify_')) {
          const accId = task.action.replace(/^verify_/, '').replace(/^verify:/, '');
          const acc = goalObj.acceptance.find((a) => a.id === accId) || goalObj.acceptance[0];
          const vt0 = Date.now();
          const v = await verifyAcceptance(goal, { acceptanceId: acc.id, kind: acc.verify.kind, spec: acc.verify.spec, taskId: task.id });
          telemetry?.append('verification', { goalId: goal.id, acceptanceId: acc.id, kind: acc.verify.kind, verified: v.verified, durationMs: Date.now() - vt0 });
          summary.verification.push({ acceptance: acc.id, verified: v.verified });
          return v.verified ? { result: 'success' } : { result: 'failure', error: { cls: 'VERIFICATION_FAILURE', message: JSON.stringify(v.error || {}) } };
        }
        return { result: 'failure', error: { cls: 'UNKNOWN', message: `unroutable task action: ${task.action}` } };
      },
    });

    if (verdict.summary.failed > 0) {
      goal.transition('FAILED', `verification failed for ${verdict.summary.failed} task(s)`);
      summary.goal = { state: goal.state, uncovered: goal.acceptance.map((a) => a.id) };
      telemetry?.append('goal.finish', { goalId: goal.id, finalState: goal.state, durationMs: Date.now() - orchStart, tasks: verdict.summary.total, done: verdict.summary.done, failed: verdict.summary.failed, receipts: goal.receipts.length, verifiedReceipts: goal.receipts.filter((r) => r.verified).length, acceptanceCount: goal.acceptance.length });
      return summary;
    }
    goal.transition('VERIFYING', 'graph done');
    goal.complete();
    summary.goal = { state: goal.state, receipts: goal.receipts.length, verifiedReceipts: goal.receipts.filter((r) => r.verified).length };
    telemetry?.append('goal.finish', { goalId: goal.id, finalState: goal.state, durationMs: Date.now() - orchStart, tasks: verdict.summary.total, done: verdict.summary.done, failed: verdict.summary.failed, receipts: goal.receipts.length, verifiedReceipts: summary.goal.verifiedReceipts, acceptanceCount: goal.acceptance.length });
    return summary;
  } finally {
    if (server) await new Promise((res) => server.close(res));
  }
}
