/**
 * Skills are procedures, not app functions.
 *
 * The point of the tests: a skill that needs a tool the owner did not grant must
 * be invisible to the model. A procedure naming tools the agent cannot call is a
 * trap that produces confident failure.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  SKILL_SCHEMA, discoverSkills, loadSkill, renderSkills, usableSkills, describeSkills, MAX_SKILL_CHARS,
} from '../../src/v4/skills.js';
import { tempHome } from './helpers.mjs';

const BUILTIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/v4/skills');

test('skills: the shipped skills load and are well formed', () => {
  const { skills, errors } = discoverSkills(BUILTIN);
  assert.deepEqual(errors, [], JSON.stringify(errors));
  const names = skills.map((s) => s.name);
  assert.ok(names.includes('job-search'));
  assert.ok(names.includes('job-application'));
  assert.ok(names.includes('fix-code'));
  const jobSearch = skills.find((s) => s.name === 'job-search');
  assert.match(jobSearch.body, /Använd en söktjänst åt gången/);
  assert.match(jobSearch.body, /Förbered bara på uttrycklig begäran/);
  assert.match(jobSearch.body, /sluta efter verifierad jämförelse/);
  for (const s of skills) {
    assert.ok(s.title.length > 3);
    assert.ok(s.body.length > 50, `${s.name} has no real procedure`);
    assert.ok(Array.isArray(s.requires));
  }
});

test('skills: job-search needs files and web, and is withheld without them', () => {
  const { skills } = discoverSkills(BUILTIN);
  const { usable, withheld } = usableSkills({ skills, grantedLanes: [] });
  assert.equal(usable.length, 0, 'nothing is usable with no grants');
  assert.ok(withheld.some((w) => w.name === 'job-search' && /needs/.test(w.reason)));

  const partial = usableSkills({ skills, grantedLanes: ['files'] });
  assert.equal(partial.usable.some((s) => s.name === 'job-search'), false, 'files alone is not enough');

  const full = usableSkills({ skills, grantedLanes: ['files', 'web'] });
  assert.ok(full.usable.some((s) => s.name === 'job-search'));
});

test('skills: job application uses the native form workflow and forbids submission', () => {
  const { skills } = discoverSkills(BUILTIN);
  const application = skills.find((s) => s.name === 'job-application');
  assert.ok(application, 'job-application skill is installed');
  assert.deepEqual(application.tools, ['browser_open', 'browser_form', 'browser_form_fill']);
  assert.match(application.body, /browser_form_fill/);
  assert.match(application.body, /anropa aldrig `browser_form_submit`/i);
  const ready = usableSkills({
    skills: [application],
    grantedLanes: ['web'],
    availableTools: ['browser_open', 'browser_form', 'browser_form_fill', 'browser_read', 'browser_verify'],
  });
  assert.equal(ready.usable.length, 1);
  assert.equal(ready.usable[0].missingPreferred.length, 0);
  const blocked = usableSkills({
    skills: [application],
    grantedLanes: ['web'],
    availableTools: ['browser_open'],
  });
  assert.equal(blocked.usable.length, 0);
  assert.match(blocked.withheld[0].reason, /browser_form/);
});

test('skills: a REQUIRED tool that is missing withholds the skill', () => {
  const { skills } = discoverSkills(BUILTIN);
  const job = skills.find((s) => s.name === 'job-search');
  const { usable, withheld } = usableSkills({
    skills: [job],
    grantedLanes: ['files', 'web'],
    availableTools: ['fs_search', 'fs_read'], // web_search and jobs_* missing
  });
  assert.equal(usable.length, 0);
  assert.match(withheld[0].reason, /web_search|jobs_/);
});

test('skills: a PREFERRED tool that is missing degrades the skill instead of hiding it', () => {
  const { skills } = discoverSkills(BUILTIN);
  const job = skills.find((s) => s.name === 'job-search');
  const { usable } = usableSkills({
    skills: [job],
    grantedLanes: ['files', 'web'],
    availableTools: ['fs_search', 'fs_read', 'document_read', 'web_search', 'jobs_search', 'jobs_match', 'jobs_prepare'],
  });
  assert.equal(usable.length, 1, 'the procedure is still followable without a browser');
  // compare a COPY: sorting in place would change what renderSkills sees
  assert.deepEqual([...usable[0].missingPreferred].sort(), ['browser_click', 'browser_fill', 'browser_open']);
  const text = renderSkills(usable);
  assert.match(text, /Unavailable on this host: browser_open/);
  assert.match(text, /say plainly what you could not do/);
});

test('skills: renderSkills produces a labelled, bounded prompt section', () => {
  const { skills } = discoverSkills(BUILTIN);
  const { usable } = usableSkills({ skills, grantedLanes: ['files', 'web', 'shell'] });
  const text = renderSkills(usable);
  assert.match(text, /## Skills you can follow/);
  assert.match(text, /never assume a tool that is not offered/);
  for (const s of usable) assert.ok(text.includes(s.body.trim().slice(0, 40)));
  assert.equal(renderSkills([]), '', 'no skills means no section at all');
});

test('skills: a malformed skill is skipped and named, never half-loaded', () => {
  const root = tempHome();
  const dir = path.join(root, 'broken');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'skill.json'), '{ inte json');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'text');
  const { skills, errors } = discoverSkills(root);
  assert.equal(skills.length, 0);
  assert.equal(errors[0].name, 'broken');
  assert.match(errors[0].error, /not valid JSON/i);
  fs.rmSync(root, { recursive: true, force: true });
});

test('skills: the directory name must equal the skill name', () => {
  const root = tempHome();
  const dir = path.join(root, 'fel-namn');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify({
    schema: SKILL_SCHEMA, name: 'annat', title: 'x', requires: [],
  }));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'text som är långt nog att räknas');
  const { errors } = discoverSkills(root);
  assert.match(errors[0].error, /does not match/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('skills: a hostile skill file cannot flood the context', () => {
  const root = tempHome();
  const dir = path.join(root, 'stor');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify({
    schema: SKILL_SCHEMA, name: 'stor', title: 'Stor', requires: [],
  }));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'x'.repeat(MAX_SKILL_CHARS * 3));
  const { skills } = discoverSkills(root);
  assert.equal(skills[0].truncated, true);
  assert.ok(skills[0].body.length <= MAX_SKILL_CHARS + 20, `body was ${skills[0].body.length}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('skills: experimental skills are not offered', () => {
  const root = tempHome();
  const dir = path.join(root, 'labb');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify({
    schema: SKILL_SCHEMA, name: 'labb', title: 'Labb', requires: [], experimental: true,
  }));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'en procedur som är tillräckligt lång för att räknas');
  const { skills } = discoverSkills(root);
  const { usable, withheld } = usableSkills({ skills, grantedLanes: [] });
  assert.equal(usable.length, 0);
  assert.equal(withheld[0].reason, 'experimental');
  fs.rmSync(root, { recursive: true, force: true });
});

test('skills: the phone view says what each skill needs and why it is not ready', () => {
  const { skills, errors } = discoverSkills(BUILTIN);
  const view = describeSkills({ skills, errors, grantedLanes: ['files'] });
  const job = view.installed.find((s) => s.name === 'job-search');
  assert.equal(job.ready, false);
  assert.match(job.blockedBy, /web/);
  const fix = view.installed.find((s) => s.name === 'fix-code');
  assert.equal(fix.blockedBy.includes('shell'), true);
  assert.deepEqual(view.ready, []);
});

test('skills: a skill can narrow its tool list but never widen access', () => {
  const root = tempHome();
  const dir = path.join(root, 'snabb');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify({
    schema: SKILL_SCHEMA, name: 'snabb', title: 'Snabb', requires: [], tools: ['fs_read'],
  }));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'läs en fil och sammanfatta den kort och tydligt');
  const { skills } = discoverSkills(root);
  // the skill names only fs_read; the runner still decides what may run
  const { usable } = usableSkills({ skills, grantedLanes: [], availableTools: ['fs_read'] });
  assert.equal(usable.length, 1, 'requires is empty, so no lane is needed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('skills: loadSkill rejects a manifest with no procedure body', () => {
  const root = tempHome();
  const dir = path.join(root, 'tom');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify({ schema: SKILL_SCHEMA, name: 'tom', title: 'Tom', requires: [] }));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '   ');
  const { error } = loadSkill(dir);
  assert.match(error, /empty/);
  fs.rmSync(root, { recursive: true, force: true });
});

/* ---------------------------------------------------- through the real host -- */

test('skills/api: the phone sees what is installed, what is ready, and why not', async () => {
  const { startTestServer } = await import('./helpers.mjs');
  const home = tempHome();
  const s = await startTestServer({ home });
  try {
    const { cookie } = await s.pair();
    const anon = await fetch(`${s.base}/api/skills`);
    assert.equal(anon.status, 401);

    const before = await (await fetch(`${s.base}/api/skills`, { headers: { cookie } })).json();
    assert.ok(before.installed.length >= 2, 'the shipped skills are listed');
    assert.deepEqual(before.usable, [], 'nothing is ready without grants');
    const job = before.installed.find((x) => x.name === 'job-search');
    assert.match(job.blockedBy, /web/);
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('skills/api: granting the lanes the skill needs makes it ready, and the model is told', async () => {
  const { startTestServer, postChat, readSse } = await import('./helpers.mjs');
  const home = tempHome();
  const s = await startTestServer({ home });
  try {
    const { cookie } = await s.pair();
    await fetch(`${s.base}/api/owner-mode`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
      body: JSON.stringify({ action: 'grant', lanes: ['web', 'jobs'], folders: [home] }),
    });

    const skills = await (await fetch(`${s.base}/api/skills`, { headers: { cookie } })).json();
    const job = skills.installed.find((x) => x.name === 'job-search');
    assert.equal(job.ready, true, `blocked by: ${job.blockedBy || 'nothing'}`);
    assert.ok(skills.usable.includes('job-search'));

    const seen = [];
    const realChat = s.context.model.chat.bind(s.context.model);
    s.context.model.chat = async (opts) => { seen.push(opts.messages); return realChat(opts); };
    await readSse(await postChat(s.base, cookie, { text: 'Hitta mitt CV och sök jobb', requestId: 'sk1' }));
    const system = seen[0].find((m) => m.role === 'system').content;
    assert.match(system, /## Skills you can follow/);
    assert.match(system, /Hitta och förbered jobbansökningar/);
    assert.match(system, /Säg aldrig att en ansökan är skickad/);
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('skills/api: revoking a lane removes the skill from the prompt again', async () => {
  const { startTestServer, postChat, readSse } = await import('./helpers.mjs');
  const home = tempHome();
  const s = await startTestServer({ home });
  try {
    const { cookie } = await s.pair();
    const grant = (body) => fetch(`${s.base}/api/owner-mode`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
      body: JSON.stringify(body),
    });
    await grant({ action: 'grant', lanes: ['web', 'jobs'], folders: [home] });
    await grant({ action: 'revoke' });

    const seen = [];
    const realChat = s.context.model.chat.bind(s.context.model);
    s.context.model.chat = async (opts) => { seen.push(opts.messages); return realChat(opts); };
    await readSse(await postChat(s.base, cookie, { text: 'Hej', requestId: 'sk2' }));
    const system = seen[0].find((m) => m.role === 'system').content;
    assert.ok(!/## Skills you can follow/.test(system), 'no skills section when nothing is usable');
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
