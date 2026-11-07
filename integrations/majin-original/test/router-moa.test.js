/**
 * Router + MOA: jobbklassning, rutter, enighet, degradring.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, Config, clone } from '../src/core/config.js';
import { classify, plan, routeFor, isBinaryMagic, llmClassify } from '../src/core/router.js';
import { agreement, normalize, jaccard, parseAnswers, run as moaRun } from '../src/core/moa.js';
import { setScript } from '../src/core/provider/mock.js';

function cfg(t, patch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-router-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const c = new Config(clone(DEFAULTS), path.join(dir, 'c.json'));
  c.save = () => true;
  c.patch({ providers: { deepseek: { apiKey: 'sk-test' }, demo: { apiKey: 'mock' } }, ...patch });
  return c;
}

test('classify: svenska fraser hamnar rätt', (t) => {
  const c = cfg(t);
  const cases = [
    ['analysera den här exe-filen och säg om den är malware', 're'],
    ['fixa buggen i src/core/router.js', 'code'],
    ['flytta alla pdf-filer i downloads till mappen archive', 'tasks'],
    ['please write the text "hello" to notes.txt', 'tasks'],
    ['vad är senaste nyheterna om quantum', 'research'],
    ['vad är Sveriges huvudstad?', 'research'],
    ['hej', 'chat'],
    ['tack, det var bra', 'chat'],
  ];
  for (const [text, job] of cases) {
    const d = classify(text, { cfg: c });
    assert.equal(d.job, job, `"${text}" → ${d.job} (förväntade ${job}), skills: ${d.reasons}`);
    assert.ok(d.confidence > 0 && d.confidence <= 1);
  }
});

test('classify: binärt och magi-vägning', (t) => {
  const c = cfg(t);
  const d = classify('kolla den här filen', { cfg: c, attachments: [{ name: 'prov.exe', kind: 'application/x-dosexec', size: 400000 }] });
  assert.equal(d.job, 're');
  const pe = Buffer.alloc(0x120);
  pe.write('MZ', 0, 'latin1');
  pe.writeUInt32LE(0x100, 0x3c);
  pe.write('PE\0\0', 0x100, 'latin1');
  pe.writeUInt16LE(0x8664, 0x104);
  assert.equal(isBinaryMagic(pe), 'pe');
  const elf = Buffer.alloc(64);
  elf[0] = 0x7f;
  elf.write('ELF', 1, 'latin1');
  assert.equal(isBinaryMagic(elf), 'elf');
  assert.ok(!isBinaryMagic(Buffer.from('hej världen')), 'text är ingen magi');
});

test('plan: always ⇒ MOA på alla jobb, hard ⇒ bara tunga', (t) => {
  const c = cfg(t);
  c.patch({ moa: { policy: 'always', width: 3, references: [{ model: 'demo/demo-fast', temperature: 0.1 }, { model: 'demo/demo-fast', temperature: 0.5 }], aggregator: 'demo/demo-pro' } });
  const p1 = plan(c, { job: 'chat', confidence: 0.9 });
  assert.equal(p1.moa.enabled, true);
  assert.ok(p1.moa.width >= 2, 'även chat ska ha referenser');
  const p2 = plan(c, { job: 're', confidence: 0.9 });
  assert.equal(p2.moa.enabled, true);
  c.patch({ moa: { policy: 'hard' } });
  const p3 = plan(c, { job: 'chat', confidence: 0.9 });
  assert.equal(p3.moa.enabled, false);
  const p4 = plan(c, { job: 're', confidence: 0.9 });
  assert.equal(p4.moa.enabled, true);
  c.patch({ moa: { policy: 'off', enabled: false } });
  assert.equal(plan(c, { job: 're' }).moa.enabled, false);
});

test('routeFor: resolve och fallback', (t) => {
  const c = cfg(t);
  const r = routeFor(c, 're');
  assert.ok(r && r.ref && r.baseUrl);
  c.patch({ providers: { deepseek: { apiKey: '' } } });
  const fb = routeFor(c, 're');
  assert.ok(fb, 'fallback till demo när deepseek tappar nyckel');
  assert.equal(fb.providerName, 'demo');
});

test('agreement: text- och sifferskillnad', () => {
  const a = 'Filen är en PE 64-bit med 12 importer och risk 80. Den är misstänkt.';
  const b = 'Filen är en PE 64-bit med 12 importer och risk 80. Den är misstänkt.';
  const c = 'Helt annat svar om något helt annat, utan belägg alls.';
  assert.equal(agreement([a, b]).score, 1);
  const mix = agreement([a, c]);
  assert.ok(mix.score < 0.5, `blandad borde vara låg, blev ${mix.score}`);
  assert.equal(agreement([]).score, 0, 'inga svar är ingen enighet');
  assert.equal(agreement(['samma']).score, 1);
  const num = agreement(['det är 3 filer, 12 MB, risk 80', 'det är 5 filer, 12 MB, risk 95']);
  assert.ok(num.numbers < 1, JSON.stringify(num));
  assert.ok(num.score < 0.75, `siffrorna skiljer — score ${num.score}`);
  assert.equal(normalize('  Aa  Bb '), 'aa bb');
  assert.ok(jaccard(new Set(['a', 'b']), new Set(['b', 'c'])) > 0.3);
});

test('parseAnswers: numrerade blok och fallheter', () => {
  const txt = 'SVAR 1 [deepseek/x]:\nFilen är en packad PE.\n\nSVAR 2 [demo/y]:\nJa, packad. Risk 80.\n\nAGGREGERADE SLUTSVAR:\nPackad PE med risk 80.';
  const parts = parseAnswers(txt);
  assert.ok(Array.isArray(parts));
  assert.equal(parts.length, 2);
  assert.equal(parts[0].n, 1);
  assert.match(parts[0].text, /packad PE/);
  assert.match(parts.map((p) => p.text).join(' '), /risk 80/);
  assert.equal(parseAnswers('inga svar alls'), null);
});

test('llmClassify: liten modell får rösta när regex tvekar', async (t) => {
  const c = cfg(t, { models: { routes: { router: 'demo/demo-fast' } } });
  const job = await llmClassify('kolla den', { cfg: c, candidates: ['code', 're', 'chat'] });
  assert.ok(['code', 're', 'tasks', 'research', 'analysis', 'chat'].includes(job), String(job));
  assert.equal(job, 'code', 'mocken svarar code på router-jobb');
});

test('llmClassify: tyst när routern är nyckellös', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-router2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const c = new Config(clone(DEFAULTS), path.join(dir, 'c.json'));
  c.save = () => true;
  const job = await llmClassify('kolla den', { cfg: c });
  assert.equal(job, null);
});

test('moa.run: referenser → aggregator, och degradering utan svar', async (t) => {
  const c = cfg(t);
  c.patch({ moa: { policy: 'always', references: [{ model: 'demo/demo-fast', temperature: 0.1 }, { model: 'demo/demo-fast', temperature: 0.5 }], aggregator: 'demo/demo-pro' }, models: { routes: { final: 'demo/demo-fast' } } });
  setScript('moa:final', []);
  const r = await moaRun({ cfg: c, question: 'Vad gör den här filen?', context: [], job: 'final' });
  assert.ok(r.answer, ' ska alltid komma ett svar');
  assert.ok(r.refs.length >= 2, JSON.stringify(r.refs));
  assert.ok(r.agreement.score >= 0 && r.agreement.score <= 1);
  assert.ok(typeof r.elapsedMs === 'number');
});

test('moa.run: enig referens skivar inte ensamt till aggregator', async (t) => {
  const c = cfg(t);
  c.patch({ moa: { policy: 'always', width: 2, references: [{ model: 'demo/demo-fast', temperature: 0.1 }, { model: 'demo/demo-fast', temperature: 0.2 }], aggregator: 'demo/demo-pro' }, models: { routes: { analysis: 'demo/demo-fast' } } });
  const r = await moaRun({ cfg: c, question: 'test', context: [], job: 'analysis', forceWidth: 2 });
  assert.equal(r.refs.filter((x) => !x.error).length, 2);
  assert.ok(r.answer.length > 0);
});
