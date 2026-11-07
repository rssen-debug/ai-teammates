/* MAJIN — P5 (V5 §3 + handover P5 second half): skills with versioning,
   rollback and surviving accountability.
   K1: content change bumps version and archives the previous full file
   K2: an edit NEVER launders accountability — fails/streak/disabled carry over
   K3: rollback restores the archived steps AND archives the current state
       (symmetric — rollback itself destroys no information)
   K4: rollback without an archive answers honestly instead of inventing one
   K5: saves are atomic — no temp-file litter, content intact after re-read
   K6: the archive is capped (newest 10) — no unbounded growth */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MAJIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-p5-'));

const { Skills } = await import('../src/core/memory.js');

const mk = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-skills-'));
  const skills = new Skills({ get: (k) => (k === 'skills.dir' ? dir : k === 'skills.maxFails' ? 3 : undefined) });
  return { dir, skills };
};

test('K1: a content change bumps version and archives the previous full file', () => {
  const { dir, skills } = mk();
  const r1 = skills.save({ name: 'Deploy Routine', when: 'deploying the app', steps: 'step one\nstep two' });
  assert.equal(r1.ok, true);
  assert.equal(r1.version, 1, 'first save is version 1');
  const r2 = skills.save({ name: 'Deploy Routine', when: 'deploying the app', steps: 'step one (revised)\nstep two\nstep three' });
  assert.equal(r2.version, 2, 'second save bumps the version');
  assert.ok(r2.archived && fs.existsSync(r2.archived), 'previous version archived before overwrite');
  const vs = skills.versions('deploy-routine');
  assert.equal(vs.length, 1);
  assert.equal(vs[0].version, 1);
  const archivedRaw = fs.readFileSync(vs[0].file, 'utf8');
  assert.match(archivedRaw, /step two/, 'archive holds the full previous content');
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length, 1, '.versions archive never pollutes the skill list');
  assert.equal(skills.list()[0].meta.version, '2', 'live file carries the bumped version');
});

test('K2: an edit never launders accountability — fails/streak/disabled carry over', () => {
  const { skills } = mk();
  skills.save({ name: 'Flaky Import', when: 'importing vendor data', steps: 'do the import' });
  skills.recordOutcome('flaky-import', { ok: false, why: 'column drift detected' });
  skills.recordOutcome('flaky-import', { ok: false, why: 'column drift detected again' });
  let meta = skills.list().find((s) => s.name === 'flaky import' || s.file === 'flaky-import.md').meta;
  assert.equal(meta.fails, '2', 'two failures recorded on disk');
  // now the content is revised — the track record must survive the edit
  const r = skills.save({ name: 'Flaky Import', when: 'importing vendor data', steps: 'do the import WITH header validation first' });
  assert.equal(r.version, 2);
  meta = skills.list().find((s) => s.file === 'flaky-import.md').meta;
  assert.equal(meta.fails, '2', 'fails still 2 after the edit — an edit is not an acquittal');
  assert.equal(meta.lastFailWhy, 'column drift detected again', 'the why survives too');
  // one more failure trips the honest disable; editing must not hide that either
  skills.recordOutcome('flaky-import', { ok: false, why: 'third strike' });
  skills.save({ name: 'Flaky Import', when: 'x', steps: 'yet another revision' });
  meta = skills.list().find((s) => s.file === 'flaky-import.md').meta;
  assert.ok(meta.disabled && /third strike/.test(meta.disabled), 'disabled state carried through the edit');
  assert.equal(skills.match('import vendor data').length, 0, 'disabled skill never resurfaces silently');
});

test('K3: rollback restores archived steps and archives the live state (symmetric)', () => {
  const { skills } = mk();
  skills.save({ name: 'Release Checklist', when: 'shipping', steps: 'version one work' });
  const r2 = skills.save({ name: 'Release Checklist', when: 'shipping', steps: 'version two work — regression suspected' });
  assert.equal(r2.version, 2);
  const rb = skills.rollback('release-checklist');
  assert.equal(rb.ok, true, `rollback succeeded (${JSON.stringify(rb)})`);
  assert.equal(rb.from, 2);
  assert.equal(rb.to, 1);
  const live = skills.list().find((s) => s.file === 'release-checklist.md');
  assert.match(live.steps, /version one work/, 'live file restored to the archived content');
  const vs = skills.versions('release-checklist');
  assert.ok(vs.some((v) => v.version === 2), 'the rolled-away v2 is itself archived — nothing is lost either way');
  // and rolling back again returns v2
  const rb2 = skills.rollback('release-checklist', 2);
  assert.equal(rb2.ok, true);
  assert.match(skills.list().find((s) => s.file === 'release-checklist.md').steps, /version two work/, 'explicit version restore works');
});

test('K4: rollback without an archive answers honestly', () => {
  const { skills } = mk();
  skills.save({ name: 'Fresh Skill', when: 'new', steps: 'only version' });
  const rb = skills.rollback('fresh-skill');
  assert.equal(rb.ok, false, 'no archive → honest refusal, no synthetic restore');
  assert.match(rb.why, /no archived version/);
  const rbMissing = skills.rollback('no-such-skill');
  assert.equal(rbMissing.ok, false);
  const rbVersion = skills.rollback('fresh-skill', 42);
  assert.equal(rbVersion.ok, false);
  assert.match(rbVersion.why, /v42/);
});

test('K5: saves are atomic — no temp litter, intact after re-read', () => {
  const { dir, skills } = mk();
  const longSteps = Array.from({ length: 200 }, (_, i) => `step line ${i}: ${'x'.repeat(200)}`).join('\n');
  const r = skills.save({ name: 'Big Skill', when: 'bulk test', steps: longSteps });
  assert.equal(r.ok, true);
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.tmp')).length, 0, 'no temp files left behind');
  const raw = fs.readFileSync(r.file, 'utf8');
  assert.ok(raw.endsWith('x'.repeat(200) + '\n'), 'full body written, not torn');
  assert.equal(skills.list()[0].steps.length, longSteps.length, 're-read matches exactly');
});

test('K6: the archive is capped at the newest 10 versions', () => {
  const { skills } = mk();
  for (let i = 1; i <= 13; i += 1) {
    const r = skills.save({ name: 'Churny Skill', when: 'churn', steps: `revision ${i}` });
    assert.equal(r.version, i);
  }
  const vs = skills.versions('churny-skill');
  assert.ok(vs.length <= 10, `archive keeps at most 10 (got ${vs.length})`);
  assert.equal(vs[vs.length - 1].version, 12, 'newest archive is the version just before live (13)');
});
