/**
 * Dataset capture: the contract is "nothing is recorded unless asked, what is recorded is
 * redacted, and nothing is uploaded because no upload path exists".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-ds-'));
process.env.MAJIN_HOME = home;
const { load } = await import('../src/core/config.js');
const { Dataset, redact } = await import('../src/core/dataset.js');
const { parseIntent } = await import('../src/core/routes.js');

function fresh() {
  const dir = fs.mkdtempSync(path.join(home, 'case-'));
  // MAJIN_HOME ensam räcker inte: dirs.* är låsta vid import, så config-filen måste pekas ut
  // explicit för att varje fall ska få sin egen data-dir.
  process.env.MAJIN_HOME = dir;
  process.env.MAJIN_CONFIG = path.join(dir, 'config.json');
  const cfg = load();
  return { cfg, ds: new Dataset(cfg) };
}

test('capture is off by default and writes nothing', () => {
  const { ds } = fresh();
  const r = ds.capture('do a thing', { text: 'done' });
  assert.deepEqual(r, { skipped: 'off' });
  assert.equal(fs.existsSync(ds.file()), false, 'no file may exist while capture is off');
});

test('redaction catches keys, tokens, jwt, bearer, card and the personal home', () => {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const out = redact(
    [
      'key sk-ABCDEFGHIJKLMNOP1234 for openai',
      'Authorization: Bearer sk-ZZZZZZZZZZZZZZZZZZZZ',
      'x-api-key: AIzaSyDEADBEEFDEADBEEFDEADBEEFDEADBEEF',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijklmnopqrstuvwxyz',
      `read ${homeDir}/Documents/passport.txt`,
      'card 4111 1111 1111 1111',
      'mail me at someone@gmail.com',
    ].join('\n'),
    null,
  );
  assert.match(out, /<API_KEY>/);
  assert.match(out, /Authorization: <REDACTED>/);
  assert.doesNotMatch(out, /Bearer sk-/, 'the scheme word must be consumed with the credential');
  assert.match(out, /<JWT>/);
  assert.match(out, /<CARD>/);
  assert.match(out, /<EMAIL>/);
  assert.doesNotMatch(out, /sk-ZZZZ|sk-ABCDE|eyJhbGci|4111 1111|someone@gmail/, `läckage: ${out}`);
  if (homeDir) assert.doesNotMatch(out, new RegExp(homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'home path must not survive');
});

test('a record holds the trajectory, not the world', () => {
  const { cfg, ds } = fresh();
  cfg.patch({ dataset: { capture: true } }, { source: 'test' });
  const r = ds.capture('analyse C:\\work\\app.exe with sk-LEAKLEAKLEAK1234 and tell me', {
    session: 'desktop',
    plan: [{ text: 'read headers', status: 'done' }],
    job: 're',
    model: 'demo/demo-fast',
    tools: [{ name: 're.analyze', args: { path: 'C:\\work\\app.exe', key: 'sk-LEAKLEAKLEAK1234' }, ok: true, ms: 12, result: 'x'.repeat(5000) }],
    text: 'it is packed',
    usage: { input: 10, output: 3 },
    costUsd: 0.001,
  });
  assert.equal(r.ok, true);
  const rec = r.record;
  assert.equal(rec.v, 1);
  assert.equal(rec.rating, null, 'unrated must stay null, not default to good');
  assert.equal(rec.job, 're');
  assert.equal(rec.steps[0].name, 're.analyze');
  assert.equal(rec.steps[0].chars, 5000, 'result size only — never the result body');
  assert.match(rec.steps[0].args, /<API_KEY>/, 'tool args are redacted too');
  assert.doesNotMatch(JSON.stringify(rec), /sk-LEAKLEAKLEAK1234/, 'no raw key anywhere in the record');
  const line = fs.readFileSync(ds.file(), 'utf8').trim().split('\n');
  assert.equal(line.length, 1, 'one json per line (JSONL)');
  assert.deepEqual(JSON.parse(line[0]).usage, { input: 10, output: 3 });
});

test('an explicit opt-out in the message is honoured', () => {
  const { cfg, ds } = fresh();
  cfg.patch({ dataset: { capture: true } }, { source: 'test' });
  assert.deepEqual(ds.capture("do not store this, it's private", { text: 'ok' }), { skipped: 'opt-out' });
  assert.deepEqual(ds.capture('hemliga grejer jag inte vill spara', { text: 'ok' }), { skipped: 'opt-out' });
  assert.equal(fs.existsSync(ds.file()), false, 'an opt-out turn must not touch disk');
  const ok = ds.capture('normal question about the repo', { text: 'fine' });
  assert.equal(ok.ok, true, 'ordinary turns still capture');
});

test('rating labels the newest turn; export and purge round-trip', () => {
  const { cfg, ds } = fresh();
  cfg.patch({ dataset: { capture: true } }, { source: 'test' });
  ds.capture('first task', { text: 'a' });
  ds.capture('second task about chrome', { text: 'b' });
  assert.deepEqual(ds.rate('', 1), { ok: true, id: ds.read()[1].id, rating: 1 }, 'empty query rates the newest');
  const hit = ds.rate('first task', -1);
  assert.equal(hit.ok, true);
  assert.equal(hit.id, ds.read()[0].id, 'a query rates the matching turn, not the newest');
  const st = ds.stats();
  assert.equal(st.records, 2);
  assert.equal(st.rated, 2);
  assert.equal(st.avgRating, 0, 'one +1 and one -1 average to 0');
  const full = ds.export({});
  assert.equal(full.ok, true);
  assert.match(fs.readFileSync(full.file, 'utf8').trim().split('\n').length + '', /^2$/, 'export keeps both records');
  const clean = ds.export({ out: 'clean.jsonl', clean: true });
  const first = JSON.parse(fs.readFileSync(clean.file, 'utf8').trim().split('\n')[0]);
  assert.equal(first.instruction, undefined, 'clean export strips the question');
  assert.equal(first.answer, undefined, 'and the answer');
  assert.deepEqual(Object.keys(first).sort(), ['at', 'id', 'job', 'model', 'rating', 'steps', 'usage'].sort());
  assert.deepEqual(ds.purge({}), { ok: false, error: 'id, before or all is required' }, 'no silent delete-everything');
  assert.deepEqual(ds.purge({ all: true }), { ok: true, removed: 2, left: 0 });
  assert.equal(ds.stats().records, 0);
});

test('there is no upload path to turn on by accident', () => {
  const { cfg, ds } = fresh();
  const r = cfg.patch({ dataset: { capture: true, upload: { enabled: true, url: 'https://example.com' } } }, { source: 'test' });
  assert.equal(r.ok, false, 'the config itself rejects an upload key');
  assert.ok((r.errors || []).some((e) => e.path.includes('upload')), 'and names the offending path');
  assert.equal(ds.on, false, 'so capture stays off after a rejected patch');
  for (const forbidden of ['upload', 'share', 'push', 'send', 'post', 'fetch']) {
    assert.equal(typeof ds[forbidden], 'undefined', `Dataset must not expose a ${forbidden}() method`);
  }
});

test('include switches what is stored', () => {
  const { cfg, ds } = fresh();
  cfg.patch({ dataset: { capture: true, include: { answer: false, toolArgs: false, plan: false } } }, { source: 'test' });
  const r = ds.capture('do the thing', { plan: [{ text: 'step one', status: 'todo' }], tools: [{ name: 'fs.read', args: { path: 'x' }, ok: true }], text: 'the answer' });
  assert.equal(r.ok, true);
  assert.equal(r.record.answer, null);
  assert.deepEqual(r.record.plan, []);
  assert.equal(r.record.steps[0].args, undefined, 'tool names stay, args do not');
  assert.equal(r.record.steps[0].name, 'fs.read', 'the tool sequence is still there for a training run');
});

test('keepDays trims the file, because a year of daily use should not grow forever', () => {
  const { cfg, ds } = fresh();
  cfg.patch({ dataset: { capture: true, keepDays: 7 } }, { source: 'test' });
  ds.ensure();
  const old = { id: 'old', v: 1, at: new Date(Date.now() - 40 * 864e5).toISOString(), day: '2000-01-01', instruction: 'ancient', answer: 'x', steps: [] };
  fs.writeFileSync(ds.file(), JSON.stringify(old) + '\n');
  ds.capture('recent turn', { text: 'now' });
  assert.equal(ds.read().length, 2, 'before trim both are there');
  assert.equal(ds.trim().removed, 1);
  assert.equal(ds.read().length, 1);
});

test('natural language toggles it, both directions', () => {
  const { cfg } = fresh();
  assert.deepEqual(parseIntent('learn from my runs', cfg).patch, { dataset: { capture: true } });
  assert.deepEqual(parseIntent('record my turns as training data', cfg).patch, { dataset: { capture: true } });
  assert.deepEqual(parseIntent('stop recording my runs', cfg).patch, { dataset: { capture: false } });
  assert.deepEqual(parseIntent('do not capture my sessions', cfg).patch, { dataset: { capture: false } });
  assert.equal(parseIntent('what is the weather', cfg).matched, false, 'unrelated turns must not touch it');
});

test('the agent captures at the end of a real turn and skips on opt-out', async () => {
  const { cfg, ds } = fresh();
  cfg.patch({ dataset: { capture: true } }, { source: 'test' });
  const { createRuntime } = await import('../src/core/runtime.js');
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'demo', routes: Object.fromEntries(['chat', 'tasks', 'tools', 'code', 're', 'analysis', 'final', 'plan', 'research', 'summarize', 'router', 'aggregator', 'vision'].map((j) => [j, 'demo/demo-fast'])) },
    guard: { mode: 'off' },
    agent: { maxSteps: 4 },
    moa: { policy: 'off' },
  });
  rt.ctx.dataset = ds;
  rt.agent.shared = rt.ctx;
  const { setScript } = await import('../src/core/provider/mock.js');
  for (const j of ['tasks', 'tools', 're', 'chat', 'code', 'research', 'analysis', 'summarize', 'plan', 'final']) {
    setScript(`main:${j}`, [{ text: 'looking', toolCalls: [{ name: 'fs.list', args: { path: '.' } }] }, { text: 'done: nothing special here' }]);
  }
  const res = await rt.agent.turn({ input: 'list the workspace files', session: 'ds-test' });
  assert.ok(res && res.text, 'the turn answered');
  const rows = ds.read();
  assert.equal(rows.length, 1, 'exactly one trajectory per turn');
  assert.equal(rows[0].steps[0].name, 'fs.list');
  assert.equal(rows[0].session, 'ds-test');
  const before = ds.stats().records;
  await rt.agent.turn({ input: 'do not store this private thing', session: 'ds-test' });
  assert.equal(ds.stats().records, before, 'opt-out turn added nothing');
  await rt.shutdown();
});
