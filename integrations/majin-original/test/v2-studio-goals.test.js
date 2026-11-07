/**
 * Studio goal-runs lane — the heavy write surface, dogfooded through our own
 * consent gate. Real runObjective executions against a fixed workspace,
 * real consent consumption, real telemetry rows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventBus } from '../src/v2/runtime/events.js';
import { TelemetryLedger } from '../src/v2/telemetry/ledger.js';
import { AuditChain } from '../src/v2/audit/chain.js';
import { Approvals } from '../src/v2/safety/approvals.js';
import { createStudioServer } from '../src/v2/studio/server.js';
import { aggregate } from '../src/v2/telemetry/aggregate.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'majin-goals-')); }

async function boot({ enableGoals = true } = {}) {
  const dir = tmp();
  const telemetryDir = path.join(dir, 'telemetry');
  const auditDir = path.join(dir, 'audit');
  const workspaceDir = path.join(dir, 'ws');
  fs.mkdirSync(workspaceDir, { recursive: true });
  new TelemetryLedger(telemetryDir);
  new AuditChain(auditDir);
  const bus = new EventBus();
  const approvals = new Approvals(bus);
  const studio = createStudioServer({
    bus, telemetryDir, auditDir, approvals,
    enableWrites: true,
    enableGoals: enableGoals ? { workspaceDir } : null,
  });
  const bound = await studio.listen({ port: 0 });
  return { studio, bound, approvals, workspaceDir, telemetryDir, dir };
}

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('1. consent gate fires FIRST: no grant → 403 waiting with exact scope named', async () => {
  const { studio, bound } = await boot();
  const res = await post(bound.url + '/api/goals', { objective: 'build a portfolio website and show it' });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.decision, 'waiting');
  assert.equal(body.requiredScope, 'studio:run-goals');
  assert.match(body.hint, /Consent panel/);
  const active = await (await fetch(bound.url + '/api/goals/active')).json();
  assert.equal(active.busy, false, 'nothing ran');
  await studio.close();
});

test('2. full dogfood loop: POST /api/consent grant → run executes → grant CONSUMED (next run waits again)', async () => {
  const { studio, bound, approvals, workspaceDir, telemetryDir } = await boot();
  const grant = await post(bound.url + '/api/consent', { scope: 'studio:run-goals', user: 'operator-stina', mode: 'once' });
  assert.equal(grant.status, 201);

  const res = await post(bound.url + '/api/goals', { objective: 'build a portfolio website and show it' });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.state, 'COMPLETED');
  assert.ok(body.produced.length > 0, 'objective produced files');
  assert.equal(body.workspaceFixed, workspaceDir);

  // real writes happened in the FIXED workspace only
  assert.ok(fs.readdirSync(workspaceDir).length > 0);

  // consent consumption is real: the executor's own view agrees
  assert.equal(approvals.check('studio:run-goals').decision, 'waiting');
  const again = await post(bound.url + '/api/goals', { objective: 'build a portfolio website and show it' });
  assert.equal(again.status, 403, 'second run without a fresh grant is refused');

  // telemetry recorded the run through the real ledger
  const agg = aggregate(telemetryDir, { lastDays: 1 });
  assert.equal(agg.goals.count, 1);
  assert.equal(agg.goals.completed, 1);
  await studio.close();
});

test('3. limited-mode grant pays N runs exactly, 409 on overlap, workspace injection ignored by construction', async (t) => {
  const { studio, bound } = await boot();
  t.after(() => studio.close()); // teardown even if an assertion throws — an open server stalls the runner
  await post(bound.url + '/api/consent', { scope: 'studio:run-goals', user: 'op', mode: 'limited', maxUses: 2 });

  // two overlapping requests: exactly one may run, the other must see 409 honestly
  const [a, b] = await Promise.all([
    post(bound.url + '/api/goals', { objective: 'build a portfolio website and show it', workspace: '/etc/evil' }),
    post(bound.url + '/api/goals', { objective: 'build a portfolio website and show it' }),
  ]);
  const [ja, jb] = await Promise.all([a.json(), b.json()]);
  const codes = [a.status, b.status].sort((x, y) => x - y);
  assert.deepEqual(codes, [200, 409], `one runs, one is honestly refused: got ${codes}`);
  assert.match(a.status === 409 ? ja.error : jb.error, /already running/);

  // whoever sent the forged workspace was told it was ignored BY CONSTRUCTION
  const winnerBody = a.status === 200 ? ja : jb;
  const winnerWasA = a.status === 200;
  assert.equal(winnerBody.workspaceFixed.startsWith(os.tmpdir()), true, 'runs stay in the operator-fixed workspace');
  if (winnerWasA) assert.equal(ja.workspaceOverrideIgnored, true, 'client-supplied workspace reported as ignored');

  // one use remains of the limited grant
  const again = await post(bound.url + '/api/goals', { objective: 'build a portfolio website and show it' });
  assert.equal(again.status, 200);
  const third = await post(bound.url + '/api/goals', { objective: 'build a portfolio website and show it' });
  assert.equal(third.status, 403, '3 runs > 2 grants exhausted');
  await studio.close();
});

test('4. enableGoals without Approvals or without fixed workspace = constructor gate', () => {
  const dir = tmp();
  assert.throws(() => createStudioServer({ bus: new EventBus(), telemetryDir: dir, auditDir: dir, enableGoals: { workspaceDir: dir } }), /requires an Approvals instance/);
  assert.throws(() => createStudioServer({ bus: new EventBus(), telemetryDir: dir, auditDir: dir, approvals: new Approvals(new EventBus()), enableGoals: {} }), /FIXED workspaceDir/);
});

test('5. disabled goals surface → 403 with "disabled means NO runs"; failed objectives are DATA (200 with failed state)', async () => {
  const dir = tmp();
  const plain = createStudioServer({ bus: new EventBus(), telemetryDir: path.join(dir, 't'), auditDir: path.join(dir, 'a') });
  const b = await plain.listen({ port: 0 });
  const res = await post(b.url + '/api/goals', { objective: 'x' });
  assert.equal(res.status, 403);
  assert.match((await res.json()).detail, /disabled means NO runs/);
  await plain.close();

  const { studio, bound } = await boot();
  await post(bound.url + '/api/consent', { scope: 'studio:run-goals', user: 'op', mode: 'once' });
  const fail = await post(bound.url + '/api/goals', { objective: 'open blender and render a 3d scene' }); // deterministic fail path, proven in CLI tests
  const body = await fail.json();
  assert.equal(fail.status, 200, 'a failed goal is a 200 carrying the truth, not a hidden 500');
  assert.notEqual(body.state, 'COMPLETED');
  await studio.close();
});

test('6. page reflects goals gate: enabled → live form; disabled → hidden + honest line; zero external assets', async () => {
  const { studio, bound } = await boot();
  const html = await (await fetch(bound.url + '/')).text();
  assert.match(html, /var GOALS=true;/);
  assert.match(html, /id="g-run"/);
  assert.match(html, /every run consumes one studio:run-goals consent grant/);
  assert.match(html, /operator-fixed workspace only/);
  assert.equal(/(src|href)\s*=\s*"https?:/i.test(html), false);
  await studio.close();

  const dir = tmp();
  const plain = createStudioServer({ bus: new EventBus(), telemetryDir: dir, auditDir: dir });
  const b = await plain.listen({ port: 0 });
  const off = await (await fetch(b.url + '/')).text();
  assert.match(off, /var GOALS=false;/);
  assert.match(off, /disabled means NO runs/);
  await plain.close();
});

test('7. CLI: --enable-goals without --goal-workspace refuses exit 2 before binding any port', async () => {
  const { spawn } = await import('node:child_process');
  const bin = path.resolve(import.meta.dirname, '..', 'bin', 'majin-v2.mjs');
  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, '--studio', '--enable-goals'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, out }));
  });
  assert.equal(res.code, 2, res.out);
  assert.match(res.out, /goal-workspace/);
});
