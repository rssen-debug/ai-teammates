/* MAJIN — GENESIS OMEGA fas 1: typade capability-kontrakt + dynamisk
   hämtning av relevanta verktyg (zero-LLM, deterministiskt).
   Fail-first: search()/capabilities()/tools.search finns inte än — dessa
   test ska vara röda först, gröna efter implementationen. */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MAJIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-caps-'));

const { createRuntime } = await import('../src/core/runtime.js');

const rt = await createRuntime({ channels: false, scheduler: false });
const reg = rt.registry;

test.after(() => rt.shutdown());

const SIDE = { read: 'none', write: 'local', exec: 'process', destructive: 'destructive' };

test('varje verktyg bär ett capability-kontrakt (cap/1)', () => {
  const caps = reg.capabilities();
  assert.equal(caps.length, reg.list().length, 'kontrakt för varje synligt verktyg');
  for (const c of caps) {
    assert.ok(c.contract === 'cap/1', `${c.id}: contract-märkning`);
    assert.ok(typeof c.id === 'string' && c.id.includes('.'), `${c.id}: id`);
    assert.ok(Array.isArray(c.tags) && c.tags.length >= 2, `${c.id}: minst grupp + namn-segment som taggar`);
    const risk = reg.byName.get(c.id).risk;
    assert.equal(c.sideEffects, SIDE[risk], `${c.id}: sideEffects följer risk (${risk})`);
    assert.deepEqual(c.inputs, reg.byName.get(c.id).parameters, `${c.id}: inputs = JSON-schemat, inget extra`);
    assert.ok(typeof c.desc === 'string' && c.desc.length > 4, `${c.id}: beskrivning`);
  }
});

test('readOnly-ytan exponerar bara sidoeffekts-fria capabilities', () => {
  for (const c of reg.capabilities({ readOnly: true })) assert.equal(c.sideEffects, 'none', `${c.id} slickade in i readOnly`);
});

test('search hittar rätt verktyg utan en enda modell', () => {
  const hit1 = reg.search('research a github repository for license safety', { limit: 3 });
  assert.equal(hit1[0].id, 'github.research', `github.research ska vara toppträff: fick [${hit1.map((h) => h.id)}]`);
  // W2: research.run (new tool) now competes on the same query terms; make sure github.verify still resides within top-4
  const hit1b = reg.search('research a github repository for license safety', { limit: 4 });
  assert.ok(hit1b.some((h) => h.id === 'github.verify'), 'github.verify must remain within top-4 (research.run (W2) occupied a top-3 slot): got ' + hit1b.map((h) => h.id));

  const hit2 = reg.search('write a file to disk', { limit: 3 });
  assert.ok(hit2.some((h) => h.id === 'fs.write'), `fs.write inom topp-3: fick [${hit2.map((h) => h.id)}]`);

  const hit3 = reg.search('fill a form in the browser', { limit: 2 });
  // v4/main added browser.form_fill, which covers all three query terms and is
  // the more specific answer to "fill a form". The intent of this assertion is
  // that the search finds the tool that fills forms, not that one exact name
  // wins after a better tool exists.
  assert.ok(['browser.fill', 'browser.form_fill'].includes(hit3[0].id),
    `en formfyllare ska vara topp: fick [${hit3.map((h) => h.id)}]`);

  const hit4 = reg.search('ads analytics report', { limit: 5 });
  assert.ok(hit4.some((h) => h.id === 'marketing.analyze'), 'marketing.analyze i topp: ' + hit4.map((h) => h.id));
  assert.notEqual(hit4[0].id, 'fs.write', 'irrelevant filskrivare får inte vinna annonsfrågan');
});

test('search respekterar limit och okända ord ger en tom, ärlig lista', () => {
  assert.ok(reg.search('file', { limit: 2 }).length <= 2, 'limit biter');
  assert.deepEqual(reg.search('xylophone quantifier nobody-uses-these-words', { limit: 5 }), [], 'noll träffar = tom lista, ingen fantasi');
});

test('search är deterministisk träff för träff', () => {
  const a = reg.search('edit text inside a zip archive and rename files', { limit: 8 });
  const b = reg.search('edit text inside a zip archive and rename files', { limit: 8 });
  assert.deepEqual(a.map((h) => h.id), b.map((h) => h.id));
});

test('tools.search ligger som verktyg och fungerar i readOnly-läge', async () => {
  const r = await reg.exec('tools.search', { q: 'rename a bunch of files', limit: 4 }, { session: 'caps', readOnly: true });
  assert.equal(r.ok, true, JSON.stringify(r.error || r).slice(0, 200));
  const out = JSON.parse(r.result); // verktygens returvärden kör alltid JSON-kuvert
  assert.ok(out.count >= 1 && out.count <= 4, `count inom limit: fick ${out.count}`);
  assert.ok(out.matches.every((m) => m.name && m.sideEffects), 'minimalt manifest per träff');
  assert.ok(out.matches.some((m) => /^fs\.|^shell\./.test(m.name)), 'fil-relaterade träffar anat: ' + out.matches.map((m) => m.name));

  const none = await reg.exec('tools.search', { q: 'quantum-entangle my spoon drawer' }, { session: 'caps' });
  assert.equal(none.ok, true);
  const noneOut = JSON.parse(none.result);
  assert.equal(noneOut.count, 0);
  assert.ok(noneOut.hint, 'ok arrangerar tomt ärlighet med tips');
});

test('registrerat: schemas och list ändras inte av capability-lagret', () => {
  assert.ok(reg.has('tools.search'), 'tools.search ska vara ett riktigt verktyg');
  assert.ok(reg.list().length > 100, `listan växte till 104+: fick ${reg.list().length}`);
  const names = reg.list().map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'inga dubbletter');
});
