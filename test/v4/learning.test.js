/**
 * Learned operational skills — the A–H acceptance, executed.
 *
 * The requirement: teach MAJIN by giving goals, never by writing a new master
 * prompt. That is only true if a verified execution becomes a reusable
 * procedure and an unverified one never does. Every test here drives the real
 * chain: a scripted OpenAI-compatible provider → the real V4 server → the real
 * registry, goal, verifier and skill store.
 *
 * The A–H flow from the brief:
 *   A  an unfamiliar safe task fails
 *   B  MAJIN diagnoses the failure and changes strategy
 *   C  a later attempt succeeds and is independently verified
 *   D  MAJIN saves the resulting skill
 *   E  the host restarts
 *   F  a related but changed task arrives
 *   G  the saved skill is retrieved and adapted
 *   H  the failed strategy is not blindly repeated
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startTestServer, postChat, readSse, tempHome } from './helpers.mjs';
import { startFakeProvider, lastToolMessage, offeredTools } from './fake-provider.mjs';
import {
  LEARNING_SCHEMA, SKILL_STATES, confidenceOf, diagnoseTrace, environmentFingerprint,
  extractCandidate, goalKeywords, promote, rankSkills, sanitizeInstruction, scenarioSignature, taskSignature,
} from '../../src/v4/learning.js';

const isChild = (body) => (body.messages || [])
  .some((m) => m.role === 'system' && /MAJIN subagent/.test(String(m.content)));

const env = (provider) => ({
  MAJIN_V4_PROVIDER: 'openai',
  MAJIN_V4_BASE_URL: provider.url,
  MAJIN_V4_API_KEY: 'test-key-not-a-secret',
  MAJIN_V4_MODEL: 'scripted-model',
  MAJIN_V4_MAX_VISIBLE_TOOLS: '40',
  MAJIN_V4_MAX_TOOL_CALLS: '12',
  MAJIN_V4_MAX_MODEL_ROUNDS: '8',
  MAJIN_V4_RATE_REQUESTS: '1000',
  MAJIN_V4_RATE_TURNS: '1000',
});

function grantLanes(home, lanes) {
  fs.mkdirSync(path.join(home, 'v4'), { recursive: true });
  fs.writeFileSync(path.join(home, 'v4', 'owner-mode.json'), JSON.stringify({
    schema: 'majin.v4.owner-mode/v1',
    version: 1,
    lanes,
    folders: [],
    grantedAt: new Date().toISOString(),
    revokedAt: null,
    history: [],
  }));
}

/* ---------------------------------------------------- unit: the guarantees -- */

test('learning: sanitising removes secrets, personal paths and brittle selectors', () => {
  const fakeGithubToken = 'ghp' + '_abcdefghijklmnopqrstuvwxyz0123';
  const dirty = 'Använd sk-abc123456789XYZ och ' + fakeGithubToken + ', '
    + 'Bearer abcdefghijklmnop123456, filen C:\\Users\\anders\\Documents\\cv.pdf, '
    + 'maila anders@example.com, klicka #submit .btn.primary > div:nth-child(2) '
    + 'eller form#login input[name="user"]';
  const { text, redactions } = sanitizeInstruction(dirty);
  assert.ok(!text.includes('sk-abc'), 'provider key survived');
  assert.ok(!text.includes('ghp_'), 'github token survived');
  assert.ok(!text.includes('Bearer abc'), 'bearer token survived');
  assert.ok(!text.includes('anders'), 'personal path or e-mail survived');
  assert.ok(!text.includes('cv.pdf'), 'personal file name survived');
  assert.ok(!text.includes('nth-child'), 'a brittle selector survived');
  assert.ok(!text.includes('#submit'), 'a brittle selector survived');
  assert.ok(redactions.includes('secret'));
  assert.ok(redactions.includes('personal-path'));
  assert.ok(redactions.includes('selector'));
});

test('learning: keywords, signatures and fingerprints are stable and useful', () => {
  assert.deepEqual(goalKeywords('Hitta mitt CV och läs det'), ['hitta', 'cv', 'läs']);
  // Identity is the procedure (tool path); the scenario is the topic.
  const a = taskSignature({ goalText: 'Hitta mitt CV och läs det', tools: ['fs_find', 'fs_read'] });
  const b = taskSignature({ goalText: 'hitta CV:t och läs igenom det', tools: ['fs_find', 'fs_read'] });
  const c = taskSignature({ goalText: 'Skriv en rapport', tools: ['workspace_write'] });
  assert.equal(a, b, 'the same procedure must share a signature');
  assert.notEqual(a, c, 'a different procedure must not share a signature');
  assert.equal(
    scenarioSignature('Hitta mitt CV och läs det'),
    scenarioSignature('hitta cv:t och läs igenom det'),
    'the same topic must share a scenario',
  );

  const fp1 = environmentFingerprint({ platform: 'win32', arch: 'x64', node: '22.1.0', lanes: ['files'], tools: ['fs_read'] });
  const fp2 = environmentFingerprint({ platform: 'win32', arch: 'x64', node: '22.9.0', lanes: ['files'], tools: ['fs_read'] });
  const fp3 = environmentFingerprint({ platform: 'linux', arch: 'x64', node: '22.1.0', lanes: ['files'], tools: ['fs_read'] });
  assert.equal(fp1, fp2, 'a patch Node upgrade is not a different environment');
  assert.notEqual(fp1, fp3, 'a different platform is a different environment');
});

test('learning: nothing is extracted from an unverified or failed turn', () => {
  const base = {
    id: 'goal_x',
    objective: 'Skriv en fil',
    state: 'COMPLETED',
    receipts: [],
  };
  const trace = [{ name: 'workspace_write', argsShape: 'content,fileName', ok: true, verified: true }];

  // No verified receipt: a model's claim is not evidence.
  const withoutReceipt = extractCandidate({ goal: base, trace });
  assert.equal(withoutReceipt.ok, false);
  assert.match(withoutReceipt.reason, /verified/i);

  // Not completed.
  const notDone = extractCandidate({
    goal: { ...base, state: 'FAILED', receipts: [{ id: 'r1', verified: true, result: 'success' }] },
    trace,
  });
  assert.equal(notDone.ok, false);
  assert.match(notDone.reason, /COMPLETED/);

  // No tools used: nothing to learn.
  const noTools = extractCandidate({
    goal: { ...base, receipts: [{ id: 'r1', verified: true, result: 'success' }] },
    trace: [],
  });
  assert.equal(noTools.ok, false);
});

test('learning: an extracted procedure stores argument names, never values', () => {
  const goal = {
    id: 'goal_y',
    objective: 'Hitta mitt CV i Documents och läs det',
    state: 'COMPLETED',
    receipts: [{
      id: 'r1', action: 'tool:fs_read', target: 'cv.pdf', result: 'success', verified: true,
      evidence: { verifier: 'v2.file', sha256: 'abc' },
    }],
  };
  // `workspace_read` fails and is never used again; the work moves to fs_find +
  // fs_read, which succeed. That is an abandoned strategy. (A tool that fails and
  // then succeeds later is NOT one — see the dedicated test below.)
  const trace = [
    { name: 'workspace_read', argsShape: 'fileName', ok: false, cls: 'DEPENDENCY_MISSING' },
    { name: 'fs_find', argsShape: 'name,path', ok: true },
    { name: 'fs_read', argsShape: 'path', ok: true, verified: true },
  ];
  const out = extractCandidate({
    goal, trace, grantedLanes: ['files'], fingerprint: 'fp1',
  });
  assert.equal(out.ok, true, out.reason);
  const skill = out.candidate;
  const serialised = JSON.stringify(skill);
  assert.ok(!serialised.includes('C:\\'), 'an absolute path leaked into the skill');
  assert.ok(!serialised.includes('cv.pdf'), 'a personal file name leaked into the skill');
  assert.match(skill.learned.procedure.join(' '), /fs_find with name,path/, 'the procedure must name the arguments');
  assert.equal(skill.learned.state, SKILL_STATES.EXPERIMENTAL);
  assert.ok(skill.learned.avoid.some((a) => a.action.startsWith('workspace_read')), 'the abandoned strategy was not recorded');
  assert.ok(skill.learned.evidence.length >= 1);
});

test('learning: promotion follows evidence, and confidence is smoothed', () => {
  assert.equal(promote({ state: SKILL_STATES.EXPERIMENTAL, successes: 1, failures: 0, scenarios: ['a'] }), SKILL_STATES.EXPERIMENTAL);
  assert.equal(promote({ state: SKILL_STATES.EXPERIMENTAL, successes: 2, failures: 0, scenarios: ['a'] }), SKILL_STATES.VERIFIED);
  assert.equal(promote({ state: SKILL_STATES.VERIFIED, successes: 3, failures: 0, scenarios: ['a'] }), SKILL_STATES.VERIFIED);
  assert.equal(promote({ state: SKILL_STATES.VERIFIED, successes: 3, failures: 0, scenarios: ['a', 'b'] }), SKILL_STATES.REUSABLE);
  assert.equal(promote({ state: SKILL_STATES.REUSABLE, successes: 3, failures: 5, scenarios: ['a', 'b'] }), SKILL_STATES.FAILED);

  const one = confidenceOf({ successes: 1, failures: 0, scenarios: ['a'] });
  const many = confidenceOf({ successes: 6, failures: 0, scenarios: ['a', 'b', 'c'] });
  assert.ok(one < 0.6, `one success must not look certain (${one})`);
  assert.ok(many > one, 'more verified scenarios must raise confidence');
});

test('learning: diagnosing a trace separates transient failures from abandoned strategy', () => {
  const trace = [
    { name: 'web_fetch', argsShape: 'url', ok: false, cls: 'TIMEOUT' },
    { name: 'fs_find', argsShape: 'name,path', ok: false, cls: 'PERMISSION_DENIED' },
    { name: 'fs_read', argsShape: 'path', ok: true },
  ];
  const d = diagnoseTrace(trace);
  assert.equal(d.failures.length, 2);
  assert.equal(d.transientFailures.length, 1, 'a timeout is transient');
  assert.ok(d.replaced.every((f) => f.cls !== 'TIMEOUT'), 'a timeout must not become a permanent "avoid"');
  assert.ok(d.replaced.some((f) => f.name === 'fs_find'));
});

test('learning: retrieval matches a related goal, not only an identical one', () => {
  const make = (name, keywords, state, confidence) => ({
    name,
    title: name,
    summary: '',
    body: '',
    learned: { keywords, categories: ['files'], state, confidence, avoid: [] },
  });
  const skills = [
    make('learn-files-aaa', ['cv', 'hitta', 'dokument'], SKILL_STATES.VERIFIED, 0.8),
    make('learn-web-bbb', ['web', 'sök', 'pris'], SKILL_STATES.VERIFIED, 0.8),
    make('learn-files-ccc', ['cv', 'hitta', 'dokument'], SKILL_STATES.FAILED, 0.2),
  ];
  const ranked = rankSkills(skills, { goalText: 'Hitta ett dokument som liknar mitt CV' });
  assert.equal(ranked[0].name, 'learn-files-aaa');
  assert.ok(!ranked.some((s) => s.name === 'learn-web-bbb'), 'an unrelated skill was retrieved');
  assert.ok(!ranked.some((s) => s.name === 'learn-files-ccc'), 'a FAILED skill was offered');
});

/* ------------------------------------------------- A–H, end to end -- */

test('learning A–H: fail, adapt, verify, store, restart, retrieve, avoid repeating', async () => {
  const home = tempHome();
  const documents = path.join(home, 'Documents');
  fs.mkdirSync(documents, { recursive: true });
  // The note lives OUTSIDE the workspace, in a folder the owner granted. That
  // is what makes the obvious first idea fail and a real search necessary.
  fs.writeFileSync(path.join(documents, 'anteckning.txt'), 'INNEHÅLL FRÅN FILEN');
  grantLanes(home, ['files']);
  const ownerFile = path.join(home, 'v4', 'owner-mode.json');
  const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
  owner.folders = [documents];
  fs.writeFileSync(ownerFile, JSON.stringify(owner));

  let parentRound = -1;
  const provider = await startFakeProvider((body) => {
    if (isChild(body)) return { text: 'delresultat' };
    parentRound += 1;
    const last = lastToolMessage(body);

    // A: the obvious idea — read it from the workspace by name. It fails,
    // because the file was never in the sandbox.
    if (parentRound === 0) {
      return { toolCalls: [{ name: 'workspace_read', args: { fileName: 'anteckning.txt' } }] };
    }
    // B: diagnose and change strategy — search the granted folder by name.
    if (parentRound === 1) {
      assert.equal(last?.ok, false, 'A: the first strategy was supposed to fail');
      return { toolCalls: [{ name: 'fs_find', args: { path: documents, name: 'anteckning' } }] };
    }
    // C: the changed strategy succeeds, then the file is read and verified.
    if (parentRound === 2) {
      assert.equal(last?.ok, true, `B: fs_find failed: ${JSON.stringify(last)}`);
      const hit = last?.data?.meta?.hits?.[0]?.path;
      assert.ok(hit, 'fs_find returned no hit');
      return { toolCalls: [{ name: 'fs_read', args: { path: hit } }] };
    }
    if (parentRound === 3) {
      assert.match(String(last?.data?.result || ''), /INNEHÅLL FRÅN FILEN/, 'C: the file was not read');
      return { text: 'KLART: jag hittade filen genom att söka i den godkända mappen och läste den.' };
    }
    return { text: 'ok' };
  });

  let s = null;
  let after = null;
  let learnedName = null;
  try {
    s = await startTestServer({ home, env: env(provider) });
    const { cookie } = await s.pair();
    const events = await readSse(await postChat(s.base, cookie, {
      text: 'Hitta anteckningen om projektet i min mapp och läs den.',
      requestId: 'learn-1',
    }));

    // A/B/C: the turn completed, with the failure and the adaptation visible.
    const done = events.find((e) => e.type === 'done')?.data;
    assert.equal(done?.status, 'completed', `turn failed: ${JSON.stringify(events.filter((e) => e.type === 'error'))}`);
    const results = events.filter((e) => e.type === 'tool_result').map((e) => e.data);
    assert.ok(results.some((r) => r.name === 'workspace_read' && r.ok === false), 'A: no failed first attempt recorded');
    assert.ok(results.some((r) => r.name === 'fs_find' && r.ok === true), 'B: the changed strategy did not run');
    assert.ok(results.some((r) => r.name === 'fs_read' && r.ok === true), 'C: the read did not succeed');

    // D: MAJIN saved the resulting skill.
    assert.ok(done.learned, 'D: the turn reported no learned skill');
    learnedName = done.learned.name;

    const dir = path.join(home, 'v4', 'learned-skills', learnedName);
    assert.ok(fs.existsSync(path.join(dir, 'skill.json')), 'D: no skill.json on disk');
    assert.ok(fs.existsSync(path.join(dir, 'SKILL.md')), 'D: no SKILL.md on disk');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'skill.json'), 'utf8'));
    assert.equal(manifest.learned.schema, LEARNING_SCHEMA);
    assert.equal(manifest.learned.state, SKILL_STATES.EXPERIMENTAL);
    assert.deepEqual(manifest.requires, ['files']);
    assert.ok(manifest.tools.includes('fs_find') && manifest.tools.includes('fs_read'));
    assert.ok(manifest.learned.avoid.some((a) => a.action.startsWith('workspace_read')),
      'D: the failed strategy was not stored as a thing to avoid');
    assert.ok(manifest.learned.evidence.length >= 1, 'D: no evidence references');
    assert.ok(manifest.learned.verification?.method, 'D: no verification method');
    const text = fs.readFileSync(path.join(dir, 'skill.json'), 'utf8');
    assert.ok(!text.includes('INNEHÅLL FRÅN FILEN'), 'a file value leaked into the skill');
    assert.ok(!text.includes(home), 'an absolute host path leaked into the skill');

    // E: the host restarts (same data dir, new process). `keep` is what makes
    // it a restart rather than a fresh install.
    await s.close({ keep: true });
    s = null;

    after = await startTestServer({ home, env: env(provider) });
    const session = after.existingSession();
    const listed = await (await fetch(`${after.base}/api/learning`, { headers: { session: undefined, cookie: session } })).json();
    assert.ok(listed.skills.some((x) => x.name === learnedName), 'E: the learned skill did not survive the restart');

    // F: a related but changed task.
    parentRound = -1;
    const promptBefore = provider.requests.length;
    const events2 = await readSse(await postChat(after.base, session, {
      text: 'Läs den anteckning som ligger i mappen också.',
      requestId: 'learn-2',
    }));

    // G: the saved skill was retrieved into the prompt.
    const systemText = provider.requests.slice(promptBefore)
      .map((r) => (r.messages || []).filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n'))
      .join('\n');
    assert.match(systemText, /Skills learned from verified work/, 'G: learned skills never reached the prompt');
    assert.ok(systemText.includes(learnedName), 'G: the specific learned skill was not offered');

    const done2 = events2.find((e) => e.type === 'done')?.data;
    assert.equal(done2?.status, 'completed', JSON.stringify(events2.filter((e) => e.type === 'error')));
    const results2 = events2.filter((e) => e.type === 'tool_result').map((e) => e.data);

    // H: the failed strategy was not executed again. A refused attempt is the
    // guard working, not a repeat; only a real execution would be a regression.
    const repeated = results2.filter((r) => r.name === 'workspace_read'
      && r.summary !== 'LEARNED_AVOID' && r.ok === true);
    assert.deepEqual(repeated, [], `H: the strategy that already failed was executed again: ${JSON.stringify(repeated)}`);
    const refusal = results2.find((r) => r.name === 'workspace_read' && r.summary === 'LEARNED_AVOID');
    const avoidedEvent = events2.find((e) => e.type === 'learning' && e.data?.event === 'avoided');
    assert.ok(refusal || avoidedEvent,
      `H: nothing showed that the failed strategy was recognised and avoided: ${JSON.stringify(results2.map((r) => [r.name, r.ok, r.summary]))}`);
    assert.ok(results2.some((r) => r.name === 'fs_find'), 'G: the learned procedure was not followed');
  } finally {
    if (s) await s.close();
    if (after) await after.close();
    await provider.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------ the guard --- */

test('learning: a recorded failed strategy is refused, not executed again', async () => {
  const home = tempHome();
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'data.txt'), 'x');
  // A granted folder is what activates the files lane; without one the skill
  // would (correctly) never be offered, and the guard could not be tested.
  const granted = path.join(home, 'Documents');
  fs.mkdirSync(granted, { recursive: true });
  grantLanes(home, ['files']);
  const ownerFile = path.join(home, 'v4', 'owner-mode.json');
  const ownerState = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
  ownerState.folders = [granted];
  fs.writeFileSync(ownerFile, JSON.stringify(ownerState));

  // Seed one learned skill whose `avoid` names the exact action.
  const learnedDir = path.join(home, 'v4', 'learned-skills', 'learn-files-seeded');
  fs.mkdirSync(learnedDir, { recursive: true });
  fs.writeFileSync(path.join(learnedDir, 'skill.json'), JSON.stringify({
    schema: 'majin.v4.skill/v1',
    name: 'learn-files-seeded',
    title: 'Hitta och läs en anteckning',
    summary: 'Sök i den godkända mappen och läs filen.',
    requires: ['files'],
    tools: ['fs_find', 'fs_read'],
    prefers: [],
    experimental: false,
    learned: {
      schema: LEARNING_SCHEMA,
      state: SKILL_STATES.VERIFIED,
      category: 'files',
      categories: ['files'],
      keywords: ['hitta', 'anteckning', 'läsa'],
      procedure: ['Call fs_find with name,path.', 'Call fs_read with path.'],
      avoid: [{ action: 'fs_grep(path,pattern)', failedWith: 'PERMISSION_DENIED', why: 'it failed in the verified run' }],
      verification: { method: 'V2 file verifier', evidence: [] },
      environment: { fingerprint: 'seeded' },
      confidence: 0.8,
      successes: 2,
      failures: 0,
      scenarios: ['a'],
      lastValidatedAt: new Date().toISOString(),
    },
  }, null, 2));
  fs.writeFileSync(path.join(learnedDir, 'SKILL.md'), '# procedure\ntext\n');

  let parentRound = -1;
  const provider = await startFakeProvider((body) => {
    if (isChild(body)) return { text: 'x' };
    parentRound += 1;
    const last = lastToolMessage(body);
    if (parentRound === 0) {
      return { toolCalls: [{ name: 'fs_grep', args: { path: workspace, pattern: 'x' } }] };
    }
    if (parentRound === 1) {
      assert.equal(last?.ok, false);
      assert.match(String(last?.error || ''), /not repeated/i, `the guard did not explain itself: ${JSON.stringify(last)}`);
      return { text: 'Jag undviker den metoden och väljer en annan.' };
    }
    return { text: 'ok' };
  });

  const s = await startTestServer({ home, env: env(provider) });
  try {
    const { cookie } = await s.pair();
    const events = await readSse(await postChat(s.base, cookie, {
      text: 'Hitta anteckningen och läs den.',
      requestId: 'guard-1',
    }));
    const guard = events.find((e) => e.type === 'learning');
    assert.ok(guard, 'no learning event was emitted for the refused action');
    assert.equal(guard.data.event, 'avoided');

    const result = events.find((e) => e.type === 'tool_result' && e.data?.name === 'fs_grep')?.data;
    assert.equal(result?.ok, false);
    assert.match(String(result?.error || ''), /not repeated/i);
    // It was refused locally: the tool never ran, so it cannot have produced output.
    assert.equal(result?.verified, false);
  } finally {
    await s.close();
    await provider.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/* ------------------------------------------------- lifecycle and staleness -- */

test('learning: a changed environment marks a skill STALE, not trusted', async () => {
  const home = tempHome();
  grantLanes(home, ['files']);
  const learnedDir = path.join(home, 'v4', 'learned-skills', 'learn-files-old');
  fs.mkdirSync(learnedDir, { recursive: true });
  fs.writeFileSync(path.join(learnedDir, 'skill.json'), JSON.stringify({
    schema: 'majin.v4.skill/v1',
    name: 'learn-files-old',
    title: 'Gammal miljö',
    summary: '',
    requires: [],
    tools: [],
    prefers: [],
    experimental: false,
    learned: {
      schema: LEARNING_SCHEMA,
      state: SKILL_STATES.VERIFIED,
      category: 'files',
      categories: ['files'],
      keywords: ['fil'],
      procedure: ['Call fs_read with path.'],
      avoid: [],
      environment: { fingerprint: 'a-very-old-fingerprint' },
      confidence: 0.9,
      successes: 4,
      failures: 0,
      scenarios: ['a', 'b'],
      lastValidatedAt: new Date().toISOString(),
    },
  }, null, 2));
  fs.writeFileSync(path.join(learnedDir, 'SKILL.md'), '# gammal\n');

  const provider = await startFakeProvider({ text: 'ok' });
  const s = await startTestServer({ home, env: env(provider) });
  try {
    const { cookie } = await s.pair();
    await (await fetch(`${s.base}/api/learning?revalidate=1`, { headers: { cookie } })).json();
    const body = await (await fetch(`${s.base}/api/learning`, { headers: { cookie } })).json();
    const skill = body.skills.find((x) => x.name === 'learn-files-old');
    assert.ok(skill, 'the skill disappeared instead of going stale');
    assert.equal(skill.state, SKILL_STATES.STALE);

    // Still readable, so a human sees what was learned — the prompt marks it STALE.
    const prompt = await import('../../src/v4/learning.js').then((m) => m.renderLearned([
      { ...JSON.parse(fs.readFileSync(path.join(learnedDir, 'skill.json'), 'utf8')), body: 'x', dir: learnedDir },
    ]));
    assert.match(prompt, /STALE/);
    assert.match(prompt, /[Rr]evalidate/);
  } finally {
    await s.close();
    await provider.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('learning: a learned skill cannot require a lane the owner never granted', async () => {
  const home = tempHome();
  // Only the workspace + files are granted; the skill's tools are workspace-only.
  const provider = await startFakeProvider((body) => {
    if (isChild(body)) return { text: 'x' };
    const last = lastToolMessage(body);
    if (!last) return { toolCalls: [{ name: 'workspace_write', args: { fileName: 'bevis.txt', content: 'x' } }] };
    return { text: 'klart' };
  });
  // No lane is granted at all: the workspace sandbox needs none. That is the
  // narrowest possible environment, and learning must not invent a lane.
  grantLanes(home, []);
  const s = await startTestServer({ home, env: env(provider) });
  try {
    const { cookie } = await s.pair();
    const events = await readSse(await postChat(s.base, cookie, { text: 'Skriv filen bevis.txt.', requestId: 'lane-1' }));
    const done = events.find((e) => e.type === 'done')?.data;
    assert.equal(done?.status, 'completed');
    assert.ok(done.learned, 'a verified workspace write should be learnable');
    if (done.learned) {
      const manifest = JSON.parse(fs.readFileSync(
        path.join(home, 'v4', 'learned-skills', done.learned.name, 'skill.json'), 'utf8',
      ));
      const ownerState = JSON.parse(fs.readFileSync(path.join(home, 'v4', 'owner-mode.json'), 'utf8'));
      const granted = new Set(ownerState.lanes || []);
      for (const lane of manifest.requires) {
        assert.ok(granted.has(lane) || lane === 'workspace', `learning claimed an ungranted lane: ${lane}`);
      }
      for (const tool of manifest.tools) {
        assert.ok(s.context.tools.registry.get(tool), `learning named a tool that is not registered: ${tool}`);
      }
    }
  } finally {
    await s.close();
    await provider.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('learning: a persisted chat message is not proof that the task succeeded', async () => {
  /**
   * The engine requires a COMPLETED goal with an independently verified receipt.
   * That was not enough: every completed turn verifies its own assistant message
   * with kind 'persistence', which proves the transcript landed on disk and
   * nothing about the work. A turn that used one harmless tool and then merely
   * said "done" passed the check and produced a skill.
   *
   * That is exactly what the brief forbids: "Do not treat an unverified
   * model-generated plan as an achieved skill."
   */
  const trace = [{ name: 'memory_search', argsShape: 'query', ok: true }];
  const onlyPersistence = {
    id: 'g', objective: 'Hitta och sammanställ allt om projektet', state: 'COMPLETED',
    receipts: [{ id: 'r1', action: 'chat.reply', target: 'msg_1', result: 'success', verified: true, evidence: { kind: 'persistence', bytes: 12 } }],
  };
  const refused = extractCandidate({ goal: onlyPersistence, trace, grantedLanes: [], laneFor: () => null, fingerprint: 'fp' });
  assert.equal(refused.ok, false, 'a skill was created from a turn that only proved its own message was saved');
  assert.match(refused.reason, /outcome|verif/i);

  // A real outcome verification still works, on the same trace.
  const withOutcome = {
    ...onlyPersistence,
    receipts: [
      ...onlyPersistence.receipts,
      { id: 'r2', action: 'tool:fs_read', target: 'a.txt', result: 'success', verified: true, evidence: { verifier: 'v2.file', bytes: 4, sha256: 'abc' } },
    ],
  };
  const accepted = extractCandidate({ goal: withOutcome, trace, grantedLanes: [], laneFor: () => null, fingerprint: 'fp' });
  assert.equal(accepted.ok, true, `a real verified outcome was rejected: ${accepted.reason}`);
  // The persistence receipt must not be used as evidence of the outcome.
  assert.ok(!accepted.candidate.learned.evidence.some((e) => e.action === 'chat.reply'),
    'the transcript receipt was recorded as outcome evidence');
});

/* ------------------------------------- self-improvement (research-derived) -- */

test('learning: a procedure becomes a template with bindable slots (AWM)', async () => {
  const { induceSlots, renderProcedure } = await import('../../src/v4/learning.js');
  const steps = [
    { tool: 'fs_find', args: 'name,path' },
    { tool: 'fs_read', args: 'path' },
  ];
  const slots = induceSlots(steps);
  assert.equal(slots.length, 3);
  assert.deepEqual(slots.map((s) => `${s.tool}.${s.argument}`), ['fs_find.name', 'fs_find.path', 'fs_read.path']);
  assert.ok(slots.every((s) => s.bind === 'from-goal'), 'a slot must be bound from the request, never stored');

  // The rendered procedure must tell the model what to supply, not what was used.
  const rendered = renderProcedure(['Call fs_find with name,path.'], slots);
  assert.match(rendered[0], /\$name1/);
  assert.match(rendered[0], /from this request/);

  // A stored candidate carries them, and no values leak.
  const goal = {
    id: 'g', objective: 'Hitta CV:t i mappen', state: 'COMPLETED',
    receipts: [{ id: 'r1', action: 'tool:fs_read', target: 'cv.pdf', result: 'success', verified: true, evidence: { verifier: 'v2.file' } }],
  };
  const trace = [
    { name: 'fs_find', argsShape: 'name,path', ok: true },
    { name: 'fs_read', argsShape: 'path', ok: true, verified: true },
  ];
  const out = extractCandidate({ goal, trace, grantedLanes: ['files'], fingerprint: 'fp' });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.candidate.learned.slots.length, 3);
  assert.ok(!JSON.stringify(out.candidate).includes('cv.pdf'), 'a value leaked through the slots');
  assert.ok(out.candidate.learned.integrity, 'no integrity hash');
});

test('learning: a failure is attributed to one step and marks the skill STALE', async () => {
  const { LearnedSkillStore, attributeFailure, SKILL_STATES: STATES } = await import('../../src/v4/learning.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-ls-'));
  try {
    const store = new LearnedSkillStore({ dir, fingerprint: 'fp' });
    const skillDir = path.join(dir, 'learn-files-abc');
    fs.mkdirSync(skillDir, { recursive: true });
    const base = {
      schema: 'majin.v4.skill/v1',
      name: 'learn-files-abc',
      title: 'Hitta och läs en anteckning',
      summary: '',
      requires: ['files'],
      tools: ['fs_find', 'fs_read'],
      prefers: [],
      experimental: false,
      learned: {
        schema: LEARNING_SCHEMA,
        state: STATES.VERIFIED,
        category: 'files',
        categories: ['files'],
        keywords: ['hitta'],
        procedure: ['Call fs_find with name,path.', 'Call fs_read with path.'],
        avoid: [],
        slots: [],
        stepFailures: {},
        revisions: [],
        verification: { method: 'v2.file' },
        environment: { fingerprint: 'fp' },
        confidence: 0.8,
        successes: 3,
        failures: 0,
        scenarios: ['a', 'b'],
        lastValidatedAt: new Date().toISOString(),
      },
    };
    fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify(base, null, 2));
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# proc\n');

    // Step 2 is where it breaks; step 1 is untouched.
    const attr = attributeFailure({
      skill: store.get('learn-files-abc'),
      trace: [{ name: 'fs_find', argsShape: 'name,path', ok: true }, { name: 'fs_read', argsShape: 'path', ok: false, cls: 'DEPENDENCY_MISSING' }],
    });
    assert.equal(attr.attributable, true);
    assert.equal(attr.stepIndex, 1);
    assert.equal(attr.transient, false);

    const first = store.observeFailure({ skills: [{ name: 'learn-files-abc' }], trace: [{ name: 'fs_read', argsShape: 'path', ok: false, cls: 'DEPENDENCY_MISSING' }] });
    assert.equal(first.length, 1);
    assert.equal(first[0].state, STATES.VERIFIED, 'one failure must not mark a proven skill stale');

    // A second failure on the same step is a pattern: STALE, with a revision note.
    const second = store.observeFailure({ skills: [{ name: 'learn-files-abc' }], trace: [{ name: 'fs_read', argsShape: 'path', ok: false, cls: 'DEPENDENCY_MISSING' }] });
    assert.equal(second[0].state, STATES.STALE);
    assert.equal(second[0].attribution.proposal.kind, 'revalidate-step');

    const written = JSON.parse(fs.readFileSync(path.join(skillDir, 'skill.json'), 'utf8'));
    assert.equal(written.learned.state, STATES.STALE);
    assert.equal(written.learned.stepFailures['1'], 2);
    assert.equal(written.learned.revisions.length, 2);
    // The newest revision is the escalation; the first one was only a note.
    assert.equal(written.learned.revisions[0].proposal.kind, 'note-step');
    assert.equal(written.learned.revisions.at(-1).proposal.kind, 'revalidate-step');
    assert.match(written.learned.revisions.at(-1).proposal.detail, /revalidate/i);
    // The steps themselves are preserved: a stale skill is still readable as evidence.
    assert.equal(written.learned.procedure.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('learning: a transient failure never becomes a permanent verdict', async () => {
  const { attributeFailure } = await import('../../src/v4/learning.js');
  const skill = { learned: { procedure: ['Call web_fetch with url.'], stepFailures: {} } };
  const attr = attributeFailure({ skill, trace: [{ name: 'web_fetch', argsShape: 'url', ok: false, cls: 'TIMEOUT' }] });
  assert.equal(attr.transient, true);
  assert.equal(attr.attributable, false, 'a timeout must not mark a step as broken');
});

test('learning: a context-dependent failure is not turned into a blanket avoid (ExpeL)', async () => {
  const { contrastiveInsight } = await import('../../src/v4/learning.js');
  const success = [{ name: 'fs_find', argsShape: 'name,path', ok: true }];
  const failure = [{ name: 'fs_find', argsShape: 'name,path', ok: false, cls: 'DEPENDENCY_MISSING' }];
  const insight = contrastiveInsight({ successTrace: success, failureTrace: failure });
  assert.ok(insight);
  assert.equal(insight.kind, 'context-dependent');
  assert.match(insight.detail, /input or the environment/);

  // A different action that never worked anywhere is not a contrast — the
  // ordinary `avoid` path already covers it.
  assert.equal(contrastiveInsight({
    successTrace: success,
    failureTrace: [{ name: 'fs_grep', argsShape: 'pattern,path', ok: false, cls: 'DEPENDENCY_MISSING' }],
  }), null);
});

test('learning: an out-of-band edit of a skill is visible in its integrity hash', async () => {
  const { skillIntegrity } = await import('../../src/v4/learning.js');
  const skill = {
    name: 'x',
    tools: ['fs_read'],
    learned: { procedure: ['Call fs_read with path.'], avoid: [], state: 'VERIFIED' },
  };
  const before = skillIntegrity(skill);
  assert.equal(before, skillIntegrity(skill), 'the hash must be stable');
  skill.learned.procedure.push('Call fs_delete with path.');
  assert.notEqual(before, skillIntegrity(skill), 'a changed procedure must change the hash');
});

test('learning: a broken environment turns a verified skill STALE after repeated step failure', async () => {
  const home = tempHome();
  const documents = path.join(home, 'Documents');
  fs.mkdirSync(documents, { recursive: true });
  const note = path.join(documents, 'anteckning.txt');
  fs.writeFileSync(note, 'X');
  grantLanes(home, ['files']);
  const ownerFile = path.join(home, 'v4', 'owner-mode.json');
  const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
  owner.folders = [documents];
  fs.writeFileSync(ownerFile, JSON.stringify(owner));

  // A procedure that used to work. Then the file disappears — the environment
  // changed, which is exactly what revalidation exists for.
  const learnedDir = path.join(home, 'v4', 'learned-skills', 'learn-files-seed');
  fs.mkdirSync(learnedDir, { recursive: true });
  fs.writeFileSync(path.join(learnedDir, 'skill.json'), JSON.stringify({
    schema: 'majin.v4.skill/v1',
    name: 'learn-files-seed',
    title: 'Hitta och läs en anteckning',
    summary: '',
    requires: ['files'],
    tools: ['fs_find', 'fs_read'],
    prefers: [],
    experimental: false,
    learned: {
      schema: LEARNING_SCHEMA,
      state: SKILL_STATES.VERIFIED,
      category: 'files',
      categories: ['files'],
      keywords: ['hitta', 'anteckningen', 'mappen', 'läs'],
      procedure: ['Call fs_find with name,path.', 'Call fs_read with path.'],
      avoid: [], slots: [], stepFailures: {}, revisions: [],
      verification: { method: 'v2.file' },
      environment: { fingerprint: 'seeded' },
      confidence: 0.8, successes: 3, failures: 0, scenarios: ['a', 'b'],
      lastValidatedAt: new Date().toISOString(),
    },
  }, null, 2));
  fs.writeFileSync(path.join(learnedDir, 'SKILL.md'), '# proc\n');
  fs.unlinkSync(note);

  const provider = await startFakeProvider((body) => {
    if (isChild(body)) return { text: 'x' };
    return lastToolMessage(body) ? { text: 'kunde inte läsa' } : { toolCalls: [{ name: 'fs_read', args: { path: note } }] };
  });
  const env2 = { ...env(provider), MAJIN_V4_MAX_MODEL_ROUNDS: '4' };

  let first = null;
  let second = null;
  try {
    first = await startTestServer({ home, env: env2 });
    const cookie = (await first.pair()).cookie;
    const turn1 = await readSse(await postChat(first.base, cookie, { text: 'Hitta anteckningen i mappen och läs den.', requestId: 'stale-1' }));
    const learned1 = turn1.find((e) => e.type === 'learning' && e.data?.event === 'failure-observed');
    assert.ok(learned1, 'a failed turn that used a skill produced no learning event');
    assert.equal(learned1.data.skills[0].attribution.stepIndex, 1, 'the wrong step was blamed');
    assert.equal(learned1.data.skills[0].state, SKILL_STATES.VERIFIED, 'one failure must not condemn a proven skill');
    await first.close({ keep: true });
    first = null;

    second = await startTestServer({ home, env: env2 });
    const session = second.existingSession();
    await readSse(await postChat(second.base, session, { text: 'Läs anteckningen i mappen igen.', requestId: 'stale-2' }));

    const written = JSON.parse(fs.readFileSync(path.join(learnedDir, 'skill.json'), 'utf8'));
    assert.equal(written.learned.state, SKILL_STATES.STALE, 'a repeated step failure did not mark the skill stale');
    assert.equal(written.learned.stepFailures['1'], 2);
    assert.ok(written.learned.revisions.length >= 2);
    assert.match(written.learned.revisions.at(-1).proposal.detail, /revalidate/i);
    // It is still offered — as STALE, which the prompt states — never silently deleted.
    const listed = await (await fetch(`${second.base}/api/learning`, { headers: { cookie: session } })).json();
    const shown = listed.skills.find((x) => x.name === 'learn-files-seed');
    assert.ok(shown, 'a stale skill disappeared instead of being marked stale');
    assert.equal(shown.state, SKILL_STATES.STALE);
    assert.ok(shown.revisions >= 2);
  } finally {
    if (first) await first.close();
    if (second) await second.close();
    await provider.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('learning: a tool that fails and then succeeds is never recorded as avoided', async () => {
  // The real Go run exposed this: fs_read failed on a wrong path, then succeeded
  // on the right one. Recording it as "do not repeat" told the next turn to skip
  // the correct step.
  const goal = {
    id: 'g',
    objective: 'Läs filen i mappen',
    state: 'COMPLETED',
    receipts: [{ id: 'r1', action: 'tool:fs_read', target: 'a.txt', result: 'success', verified: true, evidence: { verifier: 'v2.file' } }],
  };
  const trace = [
    { name: 'fs_read', argsShape: 'path', ok: false, cls: 'DEPENDENCY_MISSING' },
    { name: 'fs_find', argsShape: 'name,path', ok: true },
    { name: 'fs_read', argsShape: 'path', ok: true, verified: true },
  ];
  const out = extractCandidate({ goal, trace, grantedLanes: ['files'], fingerprint: 'fp' });
  assert.equal(out.ok, true, out.reason);
  assert.deepEqual(out.candidate.learned.avoid, [],
    'a tool that proved itself later in the same run must not be listed as avoided');
  // fs_find is still part of the procedure; nothing was dropped.
  assert.ok(out.candidate.tools.includes('fs_read') && out.candidate.tools.includes('fs_find'));
});

/* ----------------------------------------- prior experience (step 1, rest) -- */

test('learning: prior task experiences are recalled, not just learned skills', async () => {
  const { recallExperiences, renderExperiences } = await import('../../src/v4/learning.js');
  const goals = [
    {
      objective: 'Hitta CV:t i mappen och läs det',
      state: 'COMPLETED',
      receipts: [
        { action: 'tool:fs_read', result: 'failure', errorClass: 'DEPENDENCY_MISSING' },
        { action: 'tool:fs_find', result: 'success', verified: true },
        { action: 'tool:fs_read', result: 'success', verified: true },
      ],
    },
    { objective: 'Skicka ett mail till Anders', state: 'FAILED', receipts: [] },
    { objective: 'Starta om servern', state: 'COMPLETED', receipts: [] },
  ];
  const out = recallExperiences({ goals, goalText: 'Läs ett dokument i mappen' });
  assert.equal(out.length, 1, 'only the genuinely similar task may be recalled');
  assert.equal(out[0].outcome, 'COMPLETED');
  assert.equal(out[0].verified, 2);
  assert.deepEqual(out[0].worked, ['fs_find', 'fs_read']);
  assert.deepEqual(out[0].failed, ['fs_read (DEPENDENCY_MISSING)']);

  const rendered = renderExperiences(out);
  assert.match(rendered, /What happened last time/);
  assert.match(rendered, /fs_find/);
  // Nothing that is not an observed outcome may appear.
  assert.ok(!rendered.includes('mail'), 'an unrelated task leaked into the prompt');
});

test('learning: a recalled experience carries no personal data', async () => {
  const { recallExperiences } = await import('../../src/v4/learning.js');
  const goals = [{
    objective: 'Läs C:\\Users\\anders\\Documents\\cv.pdf och maila anders@example.com om mappen',
    state: 'COMPLETED',
    receipts: [{ action: 'tool:fs_read', result: 'success', verified: true }],
  }];
  const out = recallExperiences({ goals, goalText: 'Läs filen i mappen och maila om den' });
  assert.equal(out.length, 1);
  const text = JSON.stringify(out);
  assert.ok(!text.includes('anders'), 'a personal name or path survived sanitising');
  assert.ok(!text.includes('cv.pdf'), 'a personal file name survived sanitising');
  assert.ok(!text.includes('@'), 'an e-mail address survived sanitising');
});

test('learning: prior experiences reach the real system prompt', async () => {
  const home = tempHome();
  const { createAgent } = await import('../../src/v4/agent.js');
  const { ConversationStore, GoalStore } = await import('../../src/v4/store.js');
  const { Goal } = await import('../../src/v2/runtime/goal.js');
  const { STATE } = {};
  void STATE;
  const { z } = await import('zod');
  const { createToolRegistry } = await import('../../src/v4/tools.js');
  try {
    const workspace = path.join(home, 'workspace');
    const tools = createToolRegistry({ workspaceDir: workspace, memoryDir: path.join(home, 'mem') });
    tools.registry.define({
      name: 'noop',
      description: 'does nothing',
      tier: 'read',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => ({ ok: true }),
    });
    const goals = new GoalStore({ dir: path.join(home, 'goals') });

    // A past, completed task of the same kind, with a real receipt trail.
    const past = new Goal({
      objective: 'Hitta CV:t i mappen och läs det',
      acceptance: [],
      risk: 'low',
      permissions: [],
      budgets: {},
    });
    for (const state of ['PLANNING', 'READY', 'RUNNING', 'VERIFYING']) past.transition(state, 'test');
    const okReceipt = past.addReceipt({ action: 'tool:fs_read', target: 'cv', result: 'success', evidence: { bytes: 1 } });
    past.verifyReceipt(okReceipt.id, { kind: 'file', bytes: 1 });
    past.complete();
    goals.save(past);

    let seen = null;
    const model = {
      info: { demo: false, model: 'm', provider: 'p', label: 'p' },
      infoFor: () => ({ demo: false }),
      async chat({ messages }) {
        seen = messages.map((m) => String(m.content)).join('\n');
        return { text: 'ok', toolCalls: [] };
      },
    };
    const agent = createAgent({
      config: {
        version: 'test',
        paths: { home },
        workspaceDir: workspace,
        limits: { maxMessageChars: 4000, maxModelRounds: 1, maxToolCallsPerTurn: 2, toolTimeoutMs: 2000, maxContextTokens: 4000 },
        approvals: { policy: 'sandbox-auto' },
      },
      conversations: new ConversationStore({ dir: path.join(home, 'conv') }),
      goals,
      tools,
      model,
      learning: {
        retrieve: () => [],
        recall: (q) => recallExperiencesTest(q),
      },
    });
    const { recallExperiences } = await import('../../src/v4/learning.js');
    function recallExperiencesTest(q) {
      return recallExperiences({ goals: goals.list(), goalText: q, limit: 3 });
    }
    await agent.runTurn({ text: 'Läs ett dokument i mappen' });
    assert.ok(seen, 'the model was never called');
    assert.match(seen, /What happened last time you did something similar/,
      'prior experience never reached the system prompt');
    assert.match(seen, /fs_read/, 'the tools that worked were not shown');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('learning: the same job with different scaffolding stays ONE skill', async () => {
  const { LearnedSkillStore, taskSignature, sameProcedureFamily, SKILL_STATES: ST } = await import('../../src/v4/learning.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-fam-'));
  try {
    // Order no longer changes identity.
    assert.equal(taskSignature({ tools: ['fs_find', 'fs_read'] }), taskSignature({ tools: ['fs_read', 'fs_find'] }));
    // One extra exploratory read is the same job.
    assert.equal(sameProcedureFamily(['fs_find', 'fs_read'], ['fs_find', 'fs_list', 'fs_read']), true);
    // A different approach is not.
    assert.equal(sameProcedureFamily(['fs_find', 'fs_read'], ['shell_run', 'workspace_write']), false);

    const store = new LearnedSkillStore({ dir, fingerprint: 'fp' });
    const goal = (objective) => ({
      id: 'g', objective, state: 'COMPLETED',
      receipts: [{ id: 'r1', action: 'tool:fs_read', target: 'a.txt', result: 'success', verified: true, evidence: { verifier: 'v2.file' } }],
    });
    const laneFor = (name) => ({ fs_find: 'files', fs_read: 'files', fs_list: 'files' }[name] || null);

    const first = store.observe({
      goal: goal('Hitta CV:t i mappen och läs det'),
      trace: [{ name: 'fs_find', argsShape: 'name,path', ok: true }, { name: 'fs_read', argsShape: 'path', ok: true, verified: true }],
      grantedLanes: ['files'], laneFor,
    });
    assert.equal(first.action, 'created');

    // The second success took a slightly different path: an extra fs_list first.
    const second = store.observe({
      goal: goal('Hitta fakturan i mappen och läs den'),
      trace: [
        { name: 'fs_find', argsShape: 'name,path', ok: true },
        { name: 'fs_list', argsShape: 'path', ok: true },
        { name: 'fs_read', argsShape: 'path', ok: true, verified: true },
      ],
      grantedLanes: ['files'], laneFor,
    });
    assert.equal(second.action, 'updated', 'a slightly different path created a second skill');
    assert.equal(second.name, first.name, 'the two runs did not fold into one skill');

    const skills = store.list();
    assert.equal(skills.length, 1, `expected one skill, found ${skills.length}`);
    assert.equal(skills[0].learned.successes, 2);
    assert.equal(skills[0].learned.state, ST.VERIFIED);
    assert.ok(skills[0].tools.includes('fs_list'), 'the extra tool was not recorded');
    assert.deepEqual(skills[0].requires, ['files'], 'permission must not widen');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('learning: a skill learned on one device is visible on another, without a restart', async () => {
  // The brief says "persist learning across host restarts AND client sessions".
  // The restart is covered above; this covers two live devices on one host.
  const home = tempHome();
  const documents = path.join(home, 'Documents');
  fs.mkdirSync(documents, { recursive: true });
  fs.writeFileSync(path.join(documents, 'anteckning.txt'), 'X');
  grantLanes(home, ['files']);
  const ownerFile = path.join(home, 'v4', 'owner-mode.json');
  const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
  owner.folders = [documents];
  fs.writeFileSync(ownerFile, JSON.stringify(owner));

  const provider = await startFakeProvider((body) => {
    if (isChild(body)) return { text: 'x' };
    const last = lastToolMessage(body);
    if (!last) return { toolCalls: [{ name: 'fs_read', args: { path: path.join(documents, 'anteckning.txt') } }] };
    return { text: 'klart' };
  });

  const s = await startTestServer({ home, env: env(provider) });
  try {
    // Two independent devices: "phone" pairs, "desktop" is an existing session.
    const phone = (await s.pair()).cookie;
    const desktop = s.existingSession();
    assert.notEqual(phone, desktop, 'the two devices must be distinct sessions');

    // The desktop asks first: nothing learned yet.
    const before = await (await fetch(`${s.base}/api/learning`, { headers: { cookie: desktop } })).json();
    assert.equal(before.skills.length, 0);

    // The phone does the work that becomes a procedure.
    const turn = await readSse(await postChat(s.base, phone, { text: 'Läs anteckningen i mappen.', requestId: 'dev-1' }));
    const done = turn.find((e) => e.type === 'done')?.data;
    assert.equal(done?.status, 'completed');
    assert.ok(done.learned?.name, 'the phone turn produced no learned skill');

    // The desktop sees it immediately — no restart, no re-pair.
    const after = await (await fetch(`${s.base}/api/learning`, { headers: { cookie: desktop } })).json();
    assert.ok(after.skills.some((x) => x.name === done.learned.name),
      'the second device cannot see what the first one learned');
    assert.equal(after.skills.find((x) => x.name === done.learned.name).state, SKILL_STATES.EXPERIMENTAL);
  } finally {
    await s.close();
    await provider.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('learning: the engine cannot modify production code or security rules', async () => {
  /**
   * The brief is explicit: "Do not autonomously modify production code or
   * security rules without a separate tested and authorized deployment workflow."
   *
   * That is a property of the design — learned skills are prompt text in a data
   * directory — but a design property that is not asserted is a hope. This test
   * pins it: every file the store writes is inside its own directory, and nothing
   * it produces is executable.
   */
  const { LearnedSkillStore } = await import('../../src/v4/learning.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-safe-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-outside-'));
  try {
    // Snapshot a fake "installation" that must stay untouched.
    const installation = path.join(outside, 'src', 'v4');
    fs.mkdirSync(installation, { recursive: true });
    const securityFile = path.join(installation, 'security.js');
    fs.writeFileSync(securityFile, 'export const POLICY = "unchanged";\n');
    const before = fs.readFileSync(securityFile, 'utf8');

    const written = [];
    const realWrite = fs.writeFileSync;
    const realRename = fs.renameSync;
    fs.writeFileSync = (file, ...rest) => { written.push(String(file)); return realWrite(file, ...rest); };
    fs.renameSync = (from, to, ...rest) => { written.push(String(to)); return realRename(from, to, ...rest); };
    try {
      const store = new LearnedSkillStore({ dir, fingerprint: 'fp' });
      store.observe({
        goal: {
          id: 'g', objective: 'Skriv en fil', state: 'COMPLETED',
          receipts: [{ id: 'r1', action: 'tool:workspace_write', target: 'a.txt', result: 'success', verified: true, evidence: { verifier: 'v2.file' } }],
        },
        trace: [{ name: 'workspace_write', argsShape: 'content,fileName', ok: true, verified: true }],
        grantedLanes: [],
      });
      store.observeFailure({ skills: [{ name: 'learn-workspace-x' }], trace: [{ name: 'workspace_write', argsShape: 'content,fileName', ok: false, cls: 'DEPENDENCY_MISSING' }] });
    } finally {
      fs.writeFileSync = realWrite;
      fs.renameSync = realRename;
    }

    assert.ok(written.length > 0, 'the store wrote nothing, so this proves nothing');
    const root = fs.realpathSync(dir);
    for (const file of written) {
      const resolved = path.resolve(file);
      assert.ok(resolved.startsWith(root + path.sep),
        `the learning engine wrote outside its own directory: ${resolved}`);
    }
    // And the "installation" is byte-identical.
    assert.equal(fs.readFileSync(securityFile, 'utf8'), before,
      'the learning engine modified a production file');

    // Nothing it produces is executable: no script files, and the manifest is data.
    const produced = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else produced.push(e.name);
      }
    };
    walk(dir);
    assert.ok(produced.length > 0);
    assert.ok(produced.every((n) => n === 'skill.json' || n === 'SKILL.md'),
      `the engine produced an unexpected file type: ${produced.join(', ')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
