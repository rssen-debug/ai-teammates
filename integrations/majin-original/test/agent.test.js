/* MAJIN — agent end-to-end med mock-leverantören: ingen nätverk, ingen nyckel.
   Bevisar: route → verktygsslinga → fil på disk → MOA → minne → usage,
   självkonfig utan modellanrop, godkännandeväg och avbrott. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-agent-'));
process.env.MAJIN_HOME = home;
process.env.MAJIN_CONFIG = path.join(home, 'config.json');

const { createRuntime } = await import('../src/core/runtime.js');
const { setScript } = await import('../src/core/provider/mock.js');

const rt = await createRuntime({ channels: false, scheduler: false });
rt.cfg.patch({
  workspace: path.join(home, 'workspace'),
  models: { provider: 'demo', routes: Object.fromEntries(['chat', 'tasks', 'tools', 'code', 're', 'analysis', 'final', 'plan', 'research', 'summarize', 'router', 'aggregator', 'vision'].map((j) => [j, 'demo/demo-fast'])) },
  moa: { policy: 'always', width: 2 },
  // en nyckel som inte anvands (rutterna pekar kvar pa demo) haller igang MOA:
  // utan en enda riktig nyckel hoppar agenten over MOA-motet med flit
  providers: { openai: { apiKey: 'test-key-not-used', kind: 'openai', baseUrl: 'http://127.0.0.1:1' } },
  guard: { mode: 'off' },
  agent: { maxSteps: 6 },
});
const WS = rt.cfg.get('workspace');

/* the mock is keyed on '<label>:<job>' — script every job so the turn is caught regardless of routing */
const JOBS = ['tasks', 'tools', 're', 'chat', 'code', 'research', 'analysis', 'summarize', 'plan', 'final'];
function scriptAll(steps) {
  for (const j of JOBS) setScript(`main:${j}`, steps.map((x) => ({ ...x })));
}

function collect() {
  const evs = [];
  return { evs, onEvent: (e) => evs.push(e), types: () => evs.map((e) => e.type) };
}

test('turn: the tool writes to disk, MOA answers, everything is logged', async () => {
  scriptAll([
    { text: 'Skriver filen.', toolCalls: [{ name: 'fs.write', args: { path: 'agent-prov.txt', content: 'linje ett\nlinje två\n' } }] },
    { text: 'Klart — filen är skriven med två rader.' },
  ]);
  const c = collect();
  const r = await rt.agent.turn({ input: 'skriv texten "linje ett / linje två" till agent-prov.txt', session: 't1', onEvent: c.onEvent });
  const file = path.join(WS, 'agent-prov.txt');
  assert.ok(fs.existsSync(file), 'the tool must actually have written the file');
  assert.equal(fs.readFileSync(file, 'utf8'), 'linje ett\nlinje två\n');
  assert.ok((r.text || '').length > 0, 'the answer must not be empty');
  const t = c.types();
  for (const want of ['route', 'step', 'delta', 'tool', 'tool_result', 'usage', 'moa:start', 'moa:ref', 'moa:done', 'answer']) {
    assert.ok(t.includes(want), `händelsen ${want} must exist (fick ${t.join(',')}）`.replace('）', ')'));
  }
  const tr = c.evs.find((e) => e.type === 'tool_result');
  assert.equal(tr.ok, true, 'the tool must report ok');
  assert.equal(tr.tool, 'fs.write');
  assert.match(String(r.job || ''), /tasks|tools|re|chat/, 'the job must be classified');
});

test('route: a binary attachment pulls toward the re job', async () => {
  const c = collect();
  const bin = path.join(WS, 'prov.exe');
  const head = Buffer.alloc(0x200, 0);
  head.write('MZ', 0, 'ascii');
  fs.writeFileSync(bin, head);
  await rt.agent.turn({ input: 'titta på den här filen', session: 't2', attachments: [{ name: 'prov.exe', path: bin, size: 0x200, kind: 'bin' }], onEvent: c.onEvent });
  const route = c.evs.find((e) => e.type === 'route');
  assert.ok(route, 'the route event is missing');
  assert.equal(typeof route.confidence, 'number');
  assert.ok(Array.isArray(route.reasons) && route.reasons.length, 'the classification must be justified');
});

test('plan: agent.plan writes the visible work list', async () => {
  const out = await rt.registry.exec('agent.plan', { items: [{ text: 'läs fil', status: 'done' }, { text: 'skriv rapport', status: 'doing' }], mode: 'replace', note: 'start' }, { session: 'tplan' });
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.equal(out.meta.plan.length, 2, 'meta.plan must be returned');
  assert.equal(out.meta.plan[0].status, 'done');
  assert.equal(out.meta.plan[0].id, 't1', 'ids must be generated');
  assert.match(out.result, /plan \(1\/2 done\)/, 'the result must show progress');
  assert.deepEqual(rt.agent.plans.get('tplan').map((x) => x.text), ['läs fil', 'skriv rapport'], 'the plan must land on the session (the UI reads it there)');
  const merged = await rt.registry.exec('agent.plan', { items: [{ text: 'verifiera', status: 'todo' }], mode: 'merge' }, { session: 'tplan' });
  assert.equal(merged.ok, true, JSON.stringify(merged.error));
  assert.equal(merged.meta.plan.length, 3, 'merge must append to the existing plan');
  assert.deepEqual(merged.meta.plan.map((p) => p.text), ['läs fil', 'skriv rapport', 'verifiera']);
  assert.deepEqual(merged.meta.plan.map((p) => p.id), ['t1', 't2', 't3'], 'auto ids must not collide on merge');
});

test('self-config: natural language patches with no model call', async () => {
  const before = rt.cfg.get('moa.width');
  const c = collect();
  const r = await rt.agent.turn({ input: 'kör med 3 referenser', session: 't3', onEvent: c.onEvent });
  assert.equal(rt.cfg.get('moa.width'), 3, 'the width must change');
  assert.notEqual(before, 3);
  assert.ok(!c.types().includes('step'), 'no tool loop for a pure config turn');
  assert.match(String(r.text || ''), /MOA|referens|3/, 'the answer must say what changed');
  assert.ok(r.fastPath || r.job === 'config', 'the fast path must be marked');
  // och en router-row
  const r2 = await rt.agent.turn({ input: 'använd demo/demo-fast för code alltid', session: 't3' });
  assert.equal(rt.cfg.get('models.routes.code'), 'demo/demo-fast', JSON.stringify(r2.text));
});

test('guard: a refused approval means the tool never runs', async () => {
  rt.cfg.patch({ guard: { mode: 'confirm' } });
  const victim = path.join(WS, 'offer.txt');
  fs.writeFileSync(victim, 'innehåll');
  scriptAll([
    { text: 'Tar bort filen.', toolCalls: [{ name: 'fs.delete', args: { path: 'offer.txt', permanent: true } }] },
    { text: 'Klar.' },
  ]);
  const c = collect();
  const p = rt.agent.turn({ input: 'ta bort offer.txt permanent', session: 't4', onEvent: c.onEvent });
  // vänta in köpost och neka
  let id = null;
  for (let i = 0; i < 200 && !id; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
    id = rt.approvals.list().find((a) => a.tool === 'fs.delete')?.id || null;
  }
  assert.ok(id, 'an approval request must enter the queue');
  rt.approvals.respond(id, false, 'testar');
  const r = await p;
  assert.ok(fs.existsSync(victim), 'a refused action must not delete the file');
  assert.ok(r, 'the turn must still finish');
  assert.equal(rt.approvals.list().length, 0, 'the queue must be empty after the decision');
  rt.cfg.patch({ guard: { mode: 'off' } });
});

test('memory and usage: the turn saves and counts', async () => {
  const before = rt.usage.summary();
  const c = collect();
  await rt.agent.turn({ input: 'kom ihåg att projektet ligger i workspacet', session: 't5', onEvent: c.onEvent });
  const after = rt.usage.summary();
  assert.ok((after.requests || 0) > (before.requests || 0), 'requests must be counted');
  assert.ok((after.tokens || 0) > 0, 'tokens must be recorded');
  const rec = rt.memory.recall('projekt');
  assert.ok(Array.isArray(rec), 'recall must return an array');
  const stats = rt.memory.stats();
  assert.ok(stats && typeof stats === 'object', 'memory stats must exist');
  const hist = fs.readdirSync(path.join(home, 'sessions'));
  assert.ok(hist.some((f) => f.includes('t5')), 'the session must be saved to disk');
});

test('abort: stop() unwinds without hanging', async () => {
  scriptAll(Array.from({ length: 6 }, () => ({ text: 'jobbar vidare …', toolCalls: [{ name: 'fs.list', args: { path: '.' } }] })));
  const c = collect();
  const p = rt.agent.turn({ input: 'lista mappen 20 gånger', session: 't6', onEvent: c.onEvent });
  await new Promise((r) => setTimeout(r, 40));
  rt.agent.stop('t6');
  const r = await p;
  assert.ok(r, 'the turn must resolve after stop');
  assert.ok(c.types().includes('step'), 'a few steps must have run');
  assert.ok(!c.types().includes('error') || c.evs.some((e) => e.type === 'error' && /abort|cancel|stop/i.test(String(e.message))), 'the error must be an abort, not a crash');
});

test('the last budgeted step is tool-free and delivers a final answer', async () => {
  rt.cfg.patch({ agent: { maxSteps: 2 } });
  scriptAll([
    { text: 'I will inspect the workspace.', toolCalls: [{ name: 'fs.list', args: { path: '.' } }] },
    { text: 'I inspected the workspace and verified the listing.' },
  ]);
  const c = collect();
  const result = await rt.agent.turn({ input: 'list the workspace files and tell me what you found', session: 'final-step', maxSteps: 2, onEvent: c.onEvent });
  assert.match(result.text, /fs\.list/, 'the fallback answer must expose the actual tool evidence');
  const steps = c.evs.filter((event) => event.type === 'step');
  assert.equal(steps.length, 2);
  assert.equal(steps[1].finalizing, true);
  assert.equal(steps[1].toolsSent, 0, 'the final budgeted call receives no tools');
  const toolResults = c.evs.filter((event) => event.type === 'tool_result');
  assert.equal(toolResults.length, 1, 'only the first-step inspection may execute');
  assert.equal(toolResults[0].step, 1);
  rt.cfg.patch({ agent: { maxSteps: 6 } });
});

test('registry + runtime: the promises kept', async () => {
  assert.equal(rt.registry.list().length, 149, '149 integrated tools, including browser/media/plugin capabilities');
  const names = rt.registry.list().map((t) => t.name);
  for (const must of ['fs.write', 'shell.run', 'web.fetch', 're.analyze', 'majin.configure', 'agent.delegate', 'agent.moa']) {
    assert.ok(names.includes(must), `${must} must exist`);
  }
  const groups = rt.registry.groups();
  assert.ok(Object.keys(groups).length >= 6, 'groups for the UI');
  assert.ok(groups.reverse.length >= 20, 'the RE group must be large');
  assert.equal(typeof rt.version, 'string');
  assert.equal(rt.state({ includeTools: false }).tools.count, 149, 'state must report the tool count');
  assert.equal(rt.state().tools.length, 149, 'full state lists every tool');
  const st = rt.state();
  for (const k of ['config', 'routes', 'moa', 'guard', 'usage', 'channels', 'providers', 'memory']) {
    assert.ok(k in st, `state.${k} is missing`);
  }
});

test('shutdown: closes cleanly', async () => {
  await rt.shutdown();
  assert.ok(true, 'no hanging loops');
});

after(() => {
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    /* tmp is cleaned by the OS */
  }
});
