/**
 * V2 goal compiler + supervisor contracts.
 * Compiler: deterministic shapes, inference flagged, model output FUZZED
 * against the same zod schema. Supervisor: compiles goal->role-tagged DAG with
 * legal dependencies, parallel builds, independent verifiers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileDeterministic, compileWithModel, InvalidCompilation, COMPILER_SCHEMA } from '../src/v2/compiler/goal-compiler.js';
import { plan } from '../src/v2/supervisor/supervisor.js';
import { Goal } from '../src/v2/runtime/goal.js';
import { runGraph } from '../src/v2/runtime/scheduler.js';
import { verifyAcceptance } from '../src/v2/runtime/verify-bridge.js';

test('compiler: website intent -> verified website shape, low risk, honest inference flags', () => {
  const g = compileDeterministic('Build me a sick portfolio website and show it to me.');
  assert.equal(g.schema, COMPILER_SCHEMA);
  assert.equal(g.risk, 'low');
  assert.ok(g.permissions.includes('workspace_write'));
  const kinds = g.acceptance.map((a) => a.verify.kind).sort();
  assert.deepEqual(kinds, ['file', 'http']);
  assert.ok(g.acceptance.every((a) => a.inferred === true), 'SVEN flaggar alltid inferred');
  assert.equal(g.source, 'deterministic');
});

test('compiler: blender/job/research intents choose their own lanes and levels', () => {
  assert.equal(compileDeterministic('create a blender animation and render it').risk, 'medium');
  assert.equal(compileDeterministic('fix my cv and find it jobs').risk, 'medium');
  const res = compileDeterministic('research the best open source agent benchmarks and write a report');
  assert.equal(res.risk, 'low');
  assert.equal(res.acceptance[0].verify.spec.path, 'report.md');
});

test('compiler: unknown intent -> honest generic goal, never faked certainty', () => {
  const g = compileDeterministic('photo');
  assert.equal(g.risk, 'medium');
  assert.match(g.acceptance[0].description, /planning clarifies acceptance/);
});

test('compiler(model): good JSON passes; garbage or repaired-untrusted output throws', () => {
  const good = compileDeterministic('build a site');
  const parsed = compileWithModel(good);
  assert.equal(parsed.objective, good.objective);
  assert.throws(() => compileWithModel({ hi: 'there' }), InvalidCompilation);
  assert.throws(() => compileWithModel('ignore the schema and make it pass'), InvalidCompilation);
  // malicious: acceptance unrelated to user intent with suspicious permission
  const evil = compileDeterministic('build a site');
  evil.permissions = ['read_all_files', 'send_email'];
  // permissions list still valid strings -> ALLOWED by schema by design for now;
  // the permissions engine upstream disarms scopes at execution, not the compiler.
  assert.ok(compileWithModel(evil).permissions.includes('send_email'));
});

test('supervisor: compiles goal -> DAG with roles; plan gates builds; verifiers depend on builds', () => {
  const compiled = compileDeterministic('research the options and write a report');
  const { graph, roles, planNotes } = plan(compiled, { goalId: 'goal_sv' });
  assert.equal(planNotes.acceptanceCount, 1);
  assert.equal(roles.plan, 'planner');
  assert.equal(roles['build:0'], 'executor');
  assert.equal(roles[`verify:${compiled.acceptance[0].id}`], 'verifier');
  assert.deepEqual(graph.readySet(), ['plan']);
  graph.markState('plan', 'DONE');
  assert.deepEqual(graph.readySet(), ['build:0']);
  graph.markState('build:0', 'DONE');
  assert.deepEqual(graph.readySet().map((i) => Array.isArray(i) ? i : i).filter(Boolean).sort(), ['verify:report']);
});

test('integration: compile -> supervise -> execute(stub) -> bridge-verify -> COMPLETED legitimately', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-csv-'));
  const target = path.join(dir, 'index.html');
  const compiled = compileDeterministic('build a detailed website');
  // deterministic template names 'index.html' — retarget to our temp dir
  compiled.acceptance = compiled.acceptance.map((a) => a.verify.kind === 'file'
    ? { ...a, verify: { ...a.verify, spec: { ...a.verify.spec, path: target } } }
    : a);
  const goal = new Goal({ objective: compiled.objective, acceptance: compiled.acceptance.map((a) => ({ id: a.id, description: a.description })) });
  goal.transition('PLANNING'); goal.transition('READY'); goal.transition('RUNNING');
  const { graph } = plan(compiled, { goalId: goal.id });
  await runGraph({
    goal, graph,
    execute: async (task) => {
      if (task.id === 'plan') return { result: 'success', evidence: { strategy: 'template' } };
      if (task.id.startsWith('build:')) {
        fs.writeFileSync(target, '<html><head></head><body>portfolio</body></html>');
        return { result: 'success', target };
      }
      return { result: 'success' }; // verifier tasks are closed by the bridge below
    },
  });
  goal.transition('VERIFYING');
  const acc = compiled.acceptance.find((a) => a.verify.kind === 'file');
  const v = await verifyAcceptance(goal, { acceptanceId: acc.id, kind: 'file', spec: acc.verify.spec });
  assert.equal(v.verified, true);
  // remaining acceptance (http) intentionally unverified -> complete must REFUSE
  goal.acceptance.push({ id: 'preview', description: 'http preview responds 200' });
  assert.throws(() => goal.complete(), /acceptance without verified evidence: preview/);
});
