/* WAVE 10 — skill visit telemetry (user directive): a counter per skill
   "visit", honest and disk-backed; the agent sees the counter in the prompt.
   V1: hit() persists uses++ on disk + lastUsed ISO, atomic (no tmp litter)
   V2: prompt() counts exactly the shown skills once per call; pruned get 0
   V3: the prompt line carries the counter (visited ×N) and it increments;
       streak shows only when >= 1
   V4: majin.skill action=match counts deliberate lookups (2nd surface),
       zero-match lookups count nothing
   V5: edit preservation — bumping usage survives a content edit (K2-consistent)
   V6: disabled skills get NO visits via prompt (they are never presented)
   V7: list() surfaces the uses number for the UI/CLI */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MAJIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-w10-'));

const { Skills } = await import('../src/core/memory.js');
const { majinTools } = await import('../src/core/tools/majin.js');

const mk = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-w10s-'));
  const skills = new Skills({ get: (k) => (k === 'skills.dir' ? dir : k === 'skills.maxFails' ? 3 : undefined) });
  return { dir, skills };
};
const slugOf = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const rawMeta = (dir, slug) => {
  const raw = fs.readFileSync(path.join(dir, `${slug}.md`), 'utf8');
  return Object.fromEntries(raw.split('---')[1].trim().split('\n').map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
};
const save = (skills, name) => skills.save({ name, when: 'handling the demo task workflow', steps: 'do it\nthen check' });

test('V1: hit() persists uses++ and lastUsed on disk, no tmp litter', () => {
  const { dir, skills } = mk();
  save(skills, 'Visit Counter Alpha');
  const slug = slugOf('Visit Counter Alpha');
  const r = skills.hit([slug, slug]); /* Set-deduped: one visit, not two */
  assert.equal(r.ok, true);
  assert.equal(r.counted[0].uses, 1);
  const m = rawMeta(dir, slug);
  assert.equal(m.uses, '1');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(m.lastUsed), m.lastUsed);
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')).length, 0);
  skills.hit([slug]);
  assert.equal(rawMeta(dir, slug).uses, '2');
});

test('V2: prompt() counts exactly the shown skills once per call; pruned stay 0', () => {
  const { dir, skills } = mk();
  const names = [];
  for (let i = 0; i < 14; i++) { const n = `Prompt ${String(i).padStart(2, '0')} Demo`; names.push(n); save(skills, n); }
  skills.prompt();
  const slugs = names.map(slugOf);
  const usesAfter1 = slugs.map((s) => Number(rawMeta(dir, s).uses || 0));
  assert.equal(usesAfter1.filter((u) => u === 1).length, 12, `exactly 12 shown counted: ${usesAfter1}`);
  assert.equal(usesAfter1.filter((u) => u === 0).length, 2, '2 pruned skill(s) NOT counted');
  skills.prompt();
  const usesAfter2 = slugs.map((s) => Number(rawMeta(dir, s).uses || 0));
  assert.equal(usesAfter2.filter((u) => u === 2).length, 12, 'each shown skill increments per visit');
});

test('V3: the prompt line carries the counter and it increments; streak shown only when present', () => {
  const { skills } = mk();
  save(skills, 'Counter Display Beta');
  const p1 = skills.prompt();
  assert.match(p1, /Counter Display Beta .* \[visited ×1\]/, p1.split('\n')[1]);
  const p2 = skills.prompt();
  assert.match(p2, /\[visited ×2\]/);
  assert.ok(!p2.includes('streak'), 'no streak decoration without a streak');
  for (let i = 0; i < 3; i++) skills.recordOutcome(slugOf('Counter Display Beta'), { ok: true });
  assert.match(skills.prompt(), /\[visited ×\d+ · streak 3\]/);
});

test('V4: majin.skill match counts deliberate lookups; a zero-match lookup counts nothing', async () => {
  const { dir, skills } = mk();
  save(skills, 'Lookup Target Gamma');
  skills.save({ name: 'Unrelated Omega Peace', when: 'quiet evening reflections', steps: 'breathe\nstay calm' });
  const tool = majinTools.find((t) => t.name === 'majin.skill');
  const r = await tool.run({ action: 'match', query: 'demo task workflow' }, { skills });
  assert.equal(r.meta.hits, 1);
  assert.equal(Number(rawMeta(dir, slugOf('Lookup Target Gamma')).uses || 0), 1, 'deliberate lookup = a visit');
  assert.equal(Number(rawMeta(dir, slugOf('Unrelated Omega Peace')).uses || 0), 0, 'unmatched skill not visited');
  const r2 = await tool.run({ action: 'match', query: 'zzzz nothing matches this' }, { skills });
  assert.equal(r2.meta.hits, 0);
  assert.equal(Number(rawMeta(dir, slugOf('Lookup Target Gamma')).uses || 0), 1, 'a miss increments nothing');
});

test('V5: the usage ledger survives a content edit (K2-consistent)', () => {
  const { dir, skills } = mk();
  save(skills, 'Editable Delta');
  const slug = slugOf('Editable Delta');
  skills.hit([slug]); skills.hit([slug]); skills.hit([slug]);
  assert.equal(rawMeta(dir, slug).uses, '3');
  const r = skills.save({ name: 'Editable Delta', when: 'handling the demo task workflow', steps: 'do it BETTER\nthen check twice' });
  assert.equal(r.version, 2);
  assert.equal(rawMeta(dir, slug).uses, '3', 'edit must never erase visits');
  assert.ok(rawMeta(dir, slug).lastUsed, 'lastUsed carried over');
});

test('V6: disabled skills receive no prompt visits', () => {
  const { dir, skills } = mk();
  save(skills, 'Disabled Epsilon');
  const slug = slugOf('Disabled Epsilon');
  for (let i = 0; i < 3; i++) skills.recordOutcome(slug, { ok: false });
  skills.prompt();
  assert.equal(Number(rawMeta(dir, slug).uses || 0), 0, 'disabled = never presented = never counted');
});

test('V7: list() surfaces the uses number', () => {
  const { skills } = mk();
  save(skills, 'Surfaced Zeta');
  skills.hit([slugOf('Surfaced Zeta')]);
  const row = skills.list().find((x) => x.name === 'Surfaced Zeta');
  assert.equal(row.uses, 1);
});
