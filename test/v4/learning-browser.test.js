/**
 * Learning from browser and form work.
 *
 * The brief lists "Browser interaction strategies" and "Form handling" among the
 * things self-improvement must cover, and the whole point is that MAJIN learns
 * from ANY tool rather than having a special case per task type. Nothing tested
 * that: the only browser-related assertion was that the sanitiser strips a
 * selector out of arbitrary text.
 *
 * This exercises the learning engine with a realistic browser/form trace and
 * asserts the properties that make it safe and useful:
 *   - a form procedure is extracted like any other procedure
 *   - no CSS selector, field value or personal data survives into the skill
 *   - a stale selector that failed is recorded as something to avoid
 *   - the same procedure against a redesigned page becomes STALE
 *
 * It does NOT prove real browser automation — there is no browser binary in this
 * environment. It proves the engine treats browser work as ordinary work, which
 * is exactly what "no hardcoded special cases" means.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  LEARNING_SCHEMA, SKILL_STATES, LearnedSkillStore, extractCandidate,
  originFingerprint, revalidateExternal, sanitizeInstruction, renderLearned,
} from '../../src/v4/learning.js';

globalThis.__learning = { renderLearned };

/** A realistic browser/form trace: open, inspect, fail on a stale path, retry. */
const FORM_TRACE = [
  { name: 'browser_open', argsShape: 'url', ok: true },
  { name: 'browser_read', argsShape: 'url', ok: true },
  // The first attempt targets a control that no longer exists.
  { name: 'browser_click', argsShape: 'selector', ok: false, cls: 'ELEMENT_NOT_FOUND' },
  { name: 'browser_elements', argsShape: 'url', ok: true },
  { name: 'browser_click', argsShape: 'selector', ok: true },
  { name: 'browser_form_fill', argsShape: 'fields,selector', ok: true },
  { name: 'browser_form', argsShape: 'selector', ok: true, verified: true },
];

function formGoal(origin) {
  return {
    id: 'goal_form',
    objective: `Fyll i formuläret på ${origin}/ansokan med Anders och skicka det`,
    state: 'COMPLETED',
    receipts: [{
      id: 'r_form',
      action: 'tool:browser_form',
      target: 'application',
      result: 'success',
      verified: true,
      evidence: { verifier: 'v2.dom', kind: 'dom', sha256: 'abc123' },
    }],
  };
}

const laneFor = (name) => (name.startsWith('browser_') ? 'web' : null);

test('browser learning: a form procedure is extracted like any other', () => {
  const out = extractCandidate({
    goal: formGoal('https://example.com'),
    trace: FORM_TRACE,
    grantedLanes: ['web', 'browser'],
    laneFor,
    fingerprint: 'fp',
  });
  assert.equal(out.ok, true, out.reason);
  const skill = out.candidate;

  // Every browser tool that actually worked is part of the procedure.
  for (const tool of ['browser_open', 'browser_read', 'browser_elements', 'browser_click', 'browser_form_fill', 'browser_form']) {
    assert.ok(skill.tools.includes(tool), `${tool} is missing from the learned procedure`);
  }
  // The procedure describes arguments, never values.
  assert.ok(skill.learned.procedure.some((s) => /browser_form_fill with fields,selector/.test(s)));
  // It requires a lane the owner granted, and nothing more.
  assert.ok(skill.requires.every((l) => ['web', 'browser'].includes(l)), `unexpected requirement: ${skill.requires}`);
});

test('browser learning: nothing the model reads carries a selector, a value or the owner\'s sentence', () => {
  const out = extractCandidate({
    goal: formGoal('https://example.com'),
    trace: FORM_TRACE,
    grantedLanes: ['web', 'browser'],
    laneFor,
    fingerprint: 'fp',
  });
  assert.equal(out.ok, true);
  const skill = out.candidate;

  /**
   * What the MODEL is told is exactly these fields, so these are the ones that
   * must be clean. The raw goal sentence used to be stored in title, summary and
   * example.goal — a test with a form goal showed that meant a named person and a
   * page path became a permanent, prompt-injected record. Titles are now derived
   * from structure, and a URL in text becomes [url].
   */
  const readByModel = {
    title: skill.title,
    summary: skill.summary,
    exampleGoal: skill.learned.example.goal,
    body: skill.body,
    procedure: skill.learned.procedure.join(' '),
    preconditions: skill.learned.preconditions.join(' '),
    avoid: JSON.stringify(skill.learned.avoid),
    slots: JSON.stringify(skill.learned.slots),
  };
  const forbidden = ['#login', '.btn-primary', 'nth-child', 'input[name=', 'Anders', 'ansokan', 'example.com'];
  for (const [field, text] of Object.entries(readByModel)) {
    for (const needle of forbidden) {
      assert.ok(!String(text).includes(needle), `${field} carries "${needle}": ${String(text).slice(0, 120)}`);
    }
  }
  // The argument NAMES are kept, because without them the procedure is unusable.
  assert.ok(skill.learned.procedure.join(' ').includes('fields,selector'));

  /**
   * The retrieval index does keep the goal's topic words — that is what lets a
   * later, related request find this procedure — but it is never rendered. The
   * boundary is: no owner prose in anything the model reads.
   */
  assert.ok(Array.isArray(skill.learned.keywords) && skill.learned.keywords.length > 0);
  const { renderLearned } = globalThis.__learning;
  const rendered = renderLearned([{ ...skill, body: skill.body }]);
  assert.ok(!rendered.includes('Anders'), 'the retrieval index leaked into the prompt');
  assert.ok(!rendered.includes('ansokan'), 'the retrieval index leaked into the prompt');
});

test('browser learning: a selector that failed becomes something to avoid', () => {
  const out = extractCandidate({
    goal: formGoal('https://example.com'),
    trace: [
      // A click on a control that no longer exists, then a different route that
      // worked and was never revisited through the old selector.
      { name: 'browser_click', argsShape: 'selector', ok: false, cls: 'ELEMENT_NOT_FOUND' },
      { name: 'browser_form_fill', argsShape: 'fields,selector', ok: true },
      { name: 'browser_form', argsShape: 'selector', ok: true, verified: true },
    ],
    grantedLanes: ['web', 'browser'],
    laneFor,
    fingerprint: 'fp',
  });
  assert.equal(out.ok, true, out.reason);
  const avoid = out.candidate.learned.avoid;
  assert.ok(avoid.some((a) => a.action.startsWith('browser_click')),
    `the failing browser action was not recorded: ${JSON.stringify(avoid)}`);
  assert.ok(avoid.every((a) => !a.action.includes('#') && !a.action.includes('.')),
    'a selector leaked into the avoid list');
});

test('browser learning: a transient element error is not a permanent verdict', () => {
  const out = extractCandidate({
    goal: formGoal('https://example.com'),
    trace: [
      // ELEMENT_NOT_FOUND is a real failure, but a TIMEOUT on the same call is
      // the network or the renderer, not a broken strategy.
      { name: 'browser_open', argsShape: 'url', ok: false, cls: 'TIMEOUT' },
      { name: 'browser_open', argsShape: 'url', ok: true },
      { name: 'browser_read', argsShape: 'url', ok: true },
      { name: 'browser_form', argsShape: 'selector', ok: true, verified: true },
    ],
    grantedLanes: ['web', 'browser'],
    laneFor,
    fingerprint: 'fp',
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.candidate.learned.avoid, [],
    'a transient browser timeout was recorded as a strategy to avoid');
  assert.ok(out.candidate.tools.includes('browser_open'), 'the tool that eventually worked was dropped');
});

test('browser learning: the same procedure against a redesigned page goes STALE', async () => {
  // The real use case for revalidation: a form procedure learned on one version
  // of a page, then the page is redeployed.
  let body = '<form><input name="a"></form>';
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-form-'));
  try {
    const before = await originFingerprint(origin);
    const out = extractCandidate({
      goal: formGoal(origin),
      trace: FORM_TRACE,
      grantedLanes: ['web', 'browser'],
      laneFor,
      fingerprint: 'fp',
    });
    assert.equal(out.ok, true);

    // Store it with the origin and the fingerprint the form served.
    const store = new LearnedSkillStore({ dir, fingerprint: 'fp' });
    const skill = out.candidate;
    skill.learned.external = { origins: [origin], checks: [before], capturedAt: new Date().toISOString() };
    const skillDir = path.join(dir, skill.name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify(skill, null, 2));
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# form procedure\n');

    // Unchanged page: the skill stays valid.
    const same = await revalidateExternal(store.list());
    assert.equal(same[0].changed, false);

    // The form is rebuilt and the content changes.
    body = '<form><input name="a"><input name="b"><select name="c"></select></form>';
    const changed = await revalidateExternal(store.list());
    assert.equal(changed[0].changed, true, 'a redesigned form did not invalidate the procedure');
    assert.equal(changed[0].state, SKILL_STATES.STALE);

    // Persisting keeps the procedure — a stale skill is evidence, not garbage.
    const stored = store.get(skill.name);
    stored.learned.state = SKILL_STATES.STALE;
    store.persist(stored);
    assert.equal(store.get(skill.name).learned.procedure.length, skill.learned.procedure.length);
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('browser learning: a form goal text with selectors is sanitised before storage', () => {
  const dirty = 'Klicka på #submit i form.ansokan > div:nth-child(3) och fyll i input[name="personnummer"]';
  const { text, redactions } = sanitizeInstruction(dirty);
  assert.ok(!text.includes('nth-child'));
  assert.ok(!text.includes('#submit'));
  assert.ok(!text.includes('input[name='));
  assert.ok(redactions.includes('selector'));
});
