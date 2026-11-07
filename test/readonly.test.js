/**
 * Read-only turns och re.spec. Read-only är svaret på det alla always-on-agenter
 * behöver: ett bakgrundsjobb som får leta men inte rör. re.spec är stelet mellan
 * "jag förstår filen" och "nu bygger jag om den" — med bevis för varje påstående.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-ro-'));
process.env.MAJIN_HOME = home;
process.env.MAJIN_CONFIG = path.join(home, 'config.json');

const { createRuntime } = await import('../src/core/runtime.js');
const { setScript } = await import('../src/core/provider/mock.js');
const { Scheduler } = await import('../src/core/schedule.js');

const rt = await createRuntime({ channels: false, scheduler: false });
rt.cfg.patch({
  workspace: path.join(home, 'workspace'),
  guard: { mode: 'off' },
  agent: { maxSteps: 4 },
  moa: { policy: 'off' },
  models: { provider: 'demo', routes: Object.fromEntries(['chat', 'tasks', 'tools', 'code', 're', 'analysis', 'final', 'plan', 'research', 'summarize', 'router', 'aggregator', 'vision'].map((j) => [j, 'demo/demo-fast'])) },
});
const WS = rt.cfg.get('workspace');
const JOBS = ['tasks', 'tools', 're', 'chat', 'code', 'research', 'analysis', 'summarize', 'plan', 'final'];
const scriptAll = (steps) => { for (const j of JOBS) setScript(`main:${j}`, steps.map((x) => ({ ...x }))); };

after(() => fs.rmSync(home, { recursive: true, force: true }));

test('registry: a read-only turn cannot touch state', async () => {
  const r1 = await rt.registry.exec('fs.write', { path: 'ro.txt', content: 'x' }, { session: 'test', readOnly: true });
  assert.equal(r1.ok, false, 'fs.write must be refused');
  assert.equal(r1.error.code, 'read_only');
  assert.match(r1.error.hint, /readOnly:false/, 'the error has to say how to allow it');
  assert.ok(!fs.existsSync(path.join(WS, 'ro.txt')), 'and nothing may reach the disk');

  fs.writeFileSync(path.join(WS, 'probe.txt'), 'read me\n', 'utf8');
  const r2 = await rt.registry.exec('fs.read', { path: 'probe.txt' }, { session: 'test', readOnly: true });
  assert.equal(r2.ok, true, 'reads still work');

  const r3 = await rt.registry.exec('fs.write', { path: 'ro.txt', content: 'x' }, { session: 'test' });
  assert.equal(r3.ok, true, 'the same call works when the turn is not read-only');
});

test('registry: a read-only turn is only offered read tools', () => {
  const all = rt.registry.schemas();
  const ro = rt.registry.schemas({ readOnly: true });
  assert.ok(ro.length > 0 && ro.length < all.length, `read-only must shrink the menu (${ro.length} of ${all.length})`);
  const risks = new Set(rt.registry.list({ readOnly: true }).map((t) => t.risk));
  assert.deepEqual([...risks], ['read'], 'no write/exec/shell tool may be listed');
  assert.ok(all.some((t) => t.name === 'shell.run') && !ro.some((t) => t.name === 'shell.run'));
});

test('agent: the read-only turn says so in the prompt and survives a refused tool', async () => {
  const sys = rt.agent.systemPrompt({ session: 'test', decision: { job: 'tasks', confidence: 1, reasons: [] }, turnPlan: { route: { ref: 'demo/demo-fast' }, moa: null }, attachments: [], readOnly: true });
  assert.match(sys, /THIS TURN IS READ-ONLY/);
  assert.doesNotMatch(sys, /TOOLS: all \d+ are always on/, 'a read-only prompt must not promise every tool');

  scriptAll([
    { text: 'I will write it.', toolCalls: [{ name: 'fs.write', args: { path: 'should-not-exist.txt', content: 'x' } }] },
    { text: 'Refused: this turn is read-only.' },
  ]);
  const r = await rt.agent.turn({ input: 'skriv ner det till en fil', session: 'ro1', readOnly: true });
  assert.match(r.text, /read-only|Refused/i, r.text);
  assert.ok(!fs.existsSync(path.join(WS, 'should-not-exist.txt')), 'the file must not exist');
  const log = Array.isArray(r.tools) ? r.tools : Array.isArray(r.steps) ? r.steps : [];
  const write = log.find((x) => x.tool === 'fs.write' || x.name === 'fs.write');
  assert.ok(write, `the refusal has to be visible in the tool log (got ${JSON.stringify(r).slice(0, 220)}})`);
  assert.match(String(JSON.stringify(write)), /read_only|read-only/);
  assert.ok(r.text && !r.error, 'a refused tool must not sink the whole turn');
});

test('schedule: readOnly follows the job, not a guess', async () => {
  let captured = null;
  const sch = new Scheduler(rt.cfg, { runTask: async (a) => { captured = a; return { text: 'klart' }; } });
  const open = sch.add({ name: 'look', when: 'every 30m', task: 'kolla vad som hänt', readOnly: true });
  const plain = sch.add({ name: 'write', when: 'every 1h', task: 'skriv rapporten' });
  assert.equal(open.readOnly, true, 'an explicit readOnly:true sticks');
  assert.equal(plain.readOnly, false, 'the default stays off — nothing changes for existing jobs');
  rt.cfg.patch({ schedule: { readOnlyDefault: true } });
  const after = sch.add({ name: 'later', when: 'every 2h', task: 'titta' });
  assert.equal(after.readOnly, true, 'the config default applies to new jobs');

  await sch.fire({ ...open, nextRun: Date.now() }, { manual: true });
  assert.equal(captured.readOnly, true, 'the runner must receive the flag');
  await sch.fire({ ...plain, nextRun: Date.now() }, { manual: true });
  assert.equal(captured.readOnly, false, 'and a normal job runs unrestricted');
  sch.stop();
  for (const id of [open.id, plain.id, after.id]) sch.remove(id);
});

test('agent: a job model override actually overrides', async () => {
  scriptAll([{ text: 'svar' }]);
  const evs = [];
  await rt.agent.turn({ input: 'hej', session: 'ovr1', onEvent: (e) => evs.push(e) });
  const plain = evs.find((e) => e.type === 'route');
  assert.equal(plain.model, 'demo/demo-fast');

  const evs2 = [];
  await rt.agent.turn({ input: 'hej', session: 'ovr2', model: 'demo/demo-pro', onEvent: (e) => evs2.push(e) });
  const withModel = evs2.find((e) => e.type === 'route');
  assert.equal(withModel.model, 'demo/demo-pro', 'the model field was decoration before this test existed');
});

test('re.spec: evidence in, SPEC.md out', async () => {
  const target = path.join(WS, 'sample-app.exe.js');
  fs.writeFileSync(target, 'export function exportNotes(notes){ const csv = notes.map(n=>`${n.id},${n.title}`).join("\\n"); fs.writeFileSync("notes.csv", csv); if(!notes.length) throw new Error("no notes to export"); return "Downloads/notes.csv"; }\nconst url = "https://example.invalid/api/export";\n');
  const res = await rt.registry.exec('re.spec', { path: 'sample-app.exe.js', feature: 'notes export' }, { session: 'test' });
  assert.equal(res.ok, true, JSON.stringify(res.error || res));
  const spec = res.meta.spec;
  assert.ok(fs.existsSync(spec), 'the SPEC file must be written');
  const text = fs.readFileSync(spec, 'utf8');
  assert.match(text, /^# SPEC — notes export/m);
  assert.match(text, /Re-implement what is described here\. Do not copy code/);
  assert.match(text, /## Observable behaviour/);
  assert.match(text, /## Uncertain — needs a runtime answer/);
  assert.match(text, /## Evidence index/);
  assert.match(text, /exportNotes/, 'the claim has to come from the file, not from the model');
  assert.ok(res.meta.uncertain >= 1, 'a static read must admit what it could not prove');
  const ro = await rt.registry.exec('re.spec', { path: 'sample-app.exe.js' }, { session: 'test', readOnly: true });
  assert.equal(ro.ok, false, 'writing a SPEC is a write');
  assert.equal(ro.error.code, 'read_only');
});
