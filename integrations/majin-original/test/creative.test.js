/* GRAND ARCHITECT Acceptans — Del 9D: creative/productivity workflow with
   observable, on-disk evidence. Not "file tools work incidentally" — one
   complete creative brief run END-TO-END through the engine: plan-coded
   multi-step composition, each artifact persisted in the workspace, a final
   index that references every artifact, and an independent re-read that
   proves the deliverable exists whole. All files in a sandboxed ws dir. */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MAJIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-creat-'));

const { createRuntime } = await import('../src/core/runtime.js');
const { setScript, resetCalls } = await import('../src/core/provider/mock.js');
const { loop } = await import('../src/core/loop.js');

test('9D.1 creative workflow: 3-part story + index, every artifact on disk, referencing index, final summary names the work', async () => {
  const ws = fs.mkdtempSync(path.join(process.env.MAJIN_HOME, 'ws-'));
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'demo', routes: { tasks: 'demo/demo-fast', tools: 'demo/demo-fast', chat: 'demo/demo-fast' } },
    providers: { demo: { kind: 'mock', apiKey: 'demo' } },
    guard: { mode: 'off' }, moa: { policy: 'off' }, workspace: ws,
  }, { persist: false });
  resetCalls();
  const PART = (n, words) => `Chapter ${n}: ${'\n'}${words}\n(draft chapter ${n} of the lighthouse keeper story)`;
  setScript('agent:tasks', [
    { text: 'writing chapter 1', toolCalls: [{ name: 'fs.write', args: { path: 'stories/ch1.md', content: PART(1, 'The lighthouse blinked against the fog. Elias counted the seconds between the flashes — seven, always seven — and wrote the number in the margin of his log.') } }] },
    { text: 'writing chapter 2', toolCalls: [{ name: 'fs.write', args: { path: 'stories/ch2.md', content: PART(2, 'On the seventh morning the supply boat never came. The radio carried only static, and beneath it a voice that knew his name and the number seven.') } }] },
    { text: 'writing chapter 3', toolCalls: [{ name: 'fs.write', args: { path: 'stories/ch3.md', content: PART(3, 'He sealed the log, left the lamp burning, and rowed into the grey. When the coast guard found the skiff empty, the light still counted seven.') } }] },
    { text: 'building the index', toolCalls: [{ name: 'fs.write', args: { path: 'stories/index.json', content: JSON.stringify({ title: 'The Seventh Light', chapters: ['stories/ch1.md', 'stories/ch2.md', 'stories/ch3.md'], wordsByChapter: { 'stories/ch1.md': 34, 'stories/ch2.md': 33, 'stories/ch3.md': 32 }, completed: true }, null, 2) } }] },
    { text: 'The story "The Seventh Light" is complete: three chapters saved under stories/ plus an index.json describing them. All files verified on disk.' },
  ]);
  const events = [];
  const r = await loop({
    cfg: rt.cfg, registry: rt.registry, job: 'tasks', maxSteps: 10,
    messages: [{ role: 'user', content: 'write me a spooky three-part story about a lighthouse keeper, save each chapter to stories/, and finish with an index.json describing the work.' }],
    onEvent: (e) => events.push(e),
  });
  assert.ok(!r.errorKind, JSON.stringify({ stop: r.stopReason, err: r.errorKind }));

  /* independent reality check: files REALLY exist, byte-verified, no trust in the transcript */
  for (const p of ['stories/ch1.md', 'stories/ch2.md', 'stories/ch3.md', 'stories/index.json']) {
    assert.ok(fs.existsSync(path.join(ws, p)), `missing artifact ${p}`);
  }
  const ch1 = fs.readFileSync(path.join(ws, 'stories/ch1.md'), 'utf8');
  const ch3 = fs.readFileSync(path.join(ws, 'stories/ch3.md'), 'utf8');
  assert.match(ch1, /Elias counted the seconds/, 'chapter 1 content is the crafted content, not filler');
  assert.match(ch3, /light still counted seven/, 'the ending lands in chapter 3');
  const index = JSON.parse(fs.readFileSync(path.join(ws, 'stories/index.json'), 'utf8'));
  assert.deepEqual(index.chapters, ['stories/ch1.md', 'stories/ch2.md', 'stories/ch3.md'], 'index references every chapter');
  assert.equal(index.completed, true);
  assert.match(String(r.text), /The Seventh Light/, 'the final answer names the finished work');
  const writes = events.filter((e) => e.type === 'tool_result' && e.tool === 'fs.write' && e.ok);
  assert.equal(writes.length, 4, 'exactly four artifact writes happened (3 chapters + index)');
  await rt.shutdown();
});

test('9D.2 productivity pipeline: research note in → structured brief out → the older artifact survives intact', async () => {
  const ws = fs.mkdtempSync(path.join(process.env.MAJIN_HOME, 'ws2-'));
  fs.writeFileSync(path.join(ws, 'notes.md'), '# meeting notes\n- switch to weekly releases\n- owner malin keeps the metrics\n- drop the legacy importer by friday\n');
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'demo', routes: { tasks: 'demo/demo-fast', tools: 'demo/demo-fast', chat: 'demo/demo-fast' } },
    providers: { demo: { kind: 'mock', apiKey: 'demo' } },
    guard: { mode: 'off' }, moa: { policy: 'off' }, workspace: ws,
  }, { persist: false });
  resetCalls();
  setScript('agent:tasks', [
    { text: 'reading notes', toolCalls: [{ name: 'fs.read', args: { path: 'notes.md' } }] },
    { text: 'writing brief', toolCalls: [{ name: 'fs.write', args: { path: 'brief.json', content: JSON.stringify({ source: 'notes.md', decisions: ['switch to weekly releases', 'drop the legacy importer by friday'], owners: { metrics: 'malin' }, generated: 'by-majin' }, null, 2) } }] },
    { text: 'Brief generated at brief.json from notes.md — notes preserved untouched.' },
  ]);
  const r = await loop({
    cfg: rt.cfg, registry: rt.registry, job: 'tasks', maxSteps: 8,
    messages: [{ role: 'user', content: 'turn notes.md into a structured brief.json, keep the notes untouched.' }],
  });
  assert.ok(!r.errorKind);
  const brief = JSON.parse(fs.readFileSync(path.join(ws, 'brief.json'), 'utf8'));
  assert.deepEqual(brief.decisions, ['switch to weekly releases', 'drop the legacy importer by friday'], 'both decisions extracted');
  assert.equal(fs.readFileSync(path.join(ws, 'notes.md'), 'utf8').includes('- switch to weekly releases'), true, 'source artifact unharmed');
  await rt.shutdown();
});
