/* WAVE 7 — radar closure: skill outcome telemetry in routing (#3) + honest
   prompt truncation (#5). ADOPT decisions, fixture-proven offline.
   R1: equal token scores → streak>=3 wins over no history (boost +2 vs 0)
   R2: fails>=1 demotes below no-history peers (boost -1 vs 0)
   R3: token dominance survives — a 2-token match with bad history still
       beats a 1-token match on a hot streak (reputation never overrides fit)
   R4: rank/boost are exposed on the result; same state → same order twice
   R5: prompt() emits skill.pruned (log channel, skill.outcome convention) with correct counts when skills exceed
       maxInPrompt, and says so in the prompt text
   R6: at/below max there is NO pruned event (no event spam on quiet state)
   R7: disabled skills are excluded from the pruned count's eligible set */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MAJIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-w7-'));

const { Skills } = await import('../src/core/memory.js');
const { bus } = await import('../src/core/log.js');

/* skill signals ride the 'log' channel (same convention as skill.outcome):
   a typed log event, msg = event name, payload in extra fields. */
const onPruned = (events) => bus.on('log', (ev) => { if (ev.msg === 'skill.pruned') events.push(ev); });

const mk = (overrides = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-w7s-'));
  const skills = new Skills({ get: (k) => (k === 'skills.dir' ? dir : k === 'skills.maxFails' ? 3 : overrides[k]) });
  return { dir, skills };
};
const save = (skills, name) => skills.save({ name, when: 'handling the demo task workflow', steps: 'do the thing\nthen verify' });
const bump = (skills, name, ok, n) => { const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-'); for (let i = 0; i < n; i++) skills.recordOutcome(slug, { ok }); };

test('R1: a proven skill (streak>=3) beats an equal-score peer with no history', () => {
  const { skills } = mk();
  save(skills, 'Alpha Demo Runner');
  save(skills, 'Beta Demo Runner');
  bump(skills, 'Alpha Demo Runner', true, 3);
  const m = skills.match('demo task workflow', 4);
  assert.equal(m.length, 2);
  assert.equal(m[0].name, 'Alpha Demo Runner');
  assert.equal(m[0].boost, 2);
  assert.equal(m[1].boost, 0);
});

test('R2: a failing skill (fails>=1) is demoted below equal-score no-history peers', () => {
  const { skills } = mk();
  save(skills, 'Gamma Demo Runner');
  save(skills, 'Delta Demo Runner');
  bump(skills, 'Delta Demo Runner', false, 1);
  const m = skills.match('demo task workflow', 4);
  assert.equal(m[0].name, 'Gamma Demo Runner');
  assert.equal(m[1].name, 'Delta Demo Runner');
  assert.equal(m[1].boost, -1);
});

test('R3: token dominance survives — better keyword match with failure beats hot streak', () => {
  const { skills } = mk();
  skills.save({ name: 'Epsilon Demo Task Workflow Expert', when: 'handling the demo task workflow', steps: 'x' });
  skills.save({ name: 'Zeta Demo', when: 'handling the demo task workflow', steps: 'x' });
  bump(skills, 'Epsilon Demo Task Workflow Expert', false, 1); /* 4 tokens matched, boost -1 → rank 39 */
  bump(skills, 'Zeta Demo', true, 3);                          /* 3 tokens matched, boost +2 → rank 32 */
  const m = skills.match('demo task workflow expert', 4);
  assert.ok(m[0].score > m[1].score);
  assert.equal(m[0].name, 'Epsilon Demo Task Workflow Expert', 'relevance wins over reputation');
  assert.equal(m[1].name, 'Zeta Demo');
});

test('R4: rank+boost exposed; identical state → identical order (deterministic)', () => {
  const { skills } = mk();
  save(skills, 'Eta Demo Runner');
  bump(skills, 'Eta Demo Runner', true, 4);
  const a = skills.match('demo task workflow', 4);
  const b = skills.match('demo task workflow', 4);
  assert.equal(typeof a[0].rank, 'number');
  assert.equal(a[0].rank, a[0].score * 10 + a[0].boost);
  assert.deepEqual(a.map((s) => s.name), b.map((s) => s.name));
});

test('R5: prompt() beyond maxInPrompt emits skill.pruned and says so in text', () => {
  const { dir, skills } = mk();
  const events = [];
  const off = onPruned(events);
  try {
    for (let i = 0; i < 14; i++) save(skills, `Skill ${String(i).padStart(2, '0')} Demo`);
    const text = skills.prompt();
    assert.equal(events.length, 1, JSON.stringify(events));
    assert.deepEqual({ shown: events[0].shown, eligible: events[0].eligible, max: events[0].max, hidden: events[0].hidden }, { shown: 12, eligible: 14, max: 12, hidden: 2 });
    assert.match(text, /2 more learned skills not shown/);
    assert.ok(fs.readdirSync(dir).length >= 14, 'no skill files were lost — only prompt-truncated');
  } finally { off?.(); }
});

test('R6: at/below max there is NO pruned event', () => {
  const { skills } = mk();
  const events = [];
  const off = onPruned(events);
  try {
    for (let i = 0; i < 5; i++) save(skills, `Quiet ${i} Demo`);
    skills.prompt();
    assert.equal(events.length, 0, JSON.stringify(events));
  } finally { off?.(); }
});

test('R7: disabled skills are excluded from the eligible set in skill.pruned', () => {
  const { skills } = mk();
  for (let i = 0; i < 13; i++) save(skills, `Pool ${String(i).padStart(2, '0')} Demo`);
  bump(skills, 'Pool 12 Demo', false, 3); /* 3 fails → disabled HONESTLY */
  const events = [];
  const off = onPruned(events);
  try {
    const text = skills.prompt();
    assert.equal(events.length, 0, `13 saved − 1 disabled = 12 eligible = max → no pruning: ${JSON.stringify(events)}`);
    assert.ok(!text.includes('Pool 12 Demo'), 'disabled skill never enters the prompt');
  } finally { off?.(); }
});
