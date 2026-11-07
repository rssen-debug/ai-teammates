/**
 * "Revalidate the skill when a website, API or environment changes."
 *
 * The environment half was always there (platform, Node, lanes, tools). The other
 * half — a site or API the procedure depended on — was not represented at all, so
 * a procedure learned against a page that has since been redesigned kept looking
 * healthy forever.
 *
 * This drives a REAL local HTTP server that changes what it serves, so the
 * revalidation is proven rather than described: same content keeps the skill
 * valid, changed content marks it STALE, and an unreachable origin does not
 * (a network blip is not evidence that a site changed).
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  LEARNING_SCHEMA, SKILL_STATES, LearnedSkillStore,
  externalOrigins, originFingerprint, revalidateExternal,
} from '../../src/v4/learning.js';

async function serving(getBody) {
  const server = http.createServer((req, res) => {
    const body = getBody();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: `"${body.length}"` });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

function skillWith(origins, checks) {
  return {
    schema: 'majin.v4.skill/v1',
    name: 'learn-web-abc',
    title: 'Hämta en sida och läs den',
    summary: '',
    requires: ['web'],
    tools: ['web_fetch'],
    prefers: [],
    experimental: false,
    learned: {
      schema: LEARNING_SCHEMA,
      state: SKILL_STATES.REUSABLE,
      category: 'web',
      categories: ['web'],
      keywords: ['sida'],
      procedure: ['Call web_fetch with url.'],
      avoid: [], slots: [], stepFailures: {}, revisions: [],
      verification: { method: 'v2.http' },
      environment: { fingerprint: 'fp' },
      external: { origins, checks, capturedAt: new Date().toISOString() },
      confidence: 0.9, successes: 3, failures: 0, scenarios: ['a', 'b'],
      lastValidatedAt: new Date().toISOString(),
    },
  };
}

test('revalidation: only the origin is recorded, never the path or query', () => {
  // The path and query of a real request routinely carry ids, names and search
  // terms; storing them would put personal data in a universal instruction.
  assert.deepEqual(
    externalOrigins({ url: 'https://example.com/kund/anders?id=42&mail=a@b.se' }),
    ['https://example.com'],
  );
  assert.deepEqual(externalOrigins({ url: 'not a url' }), []);
  assert.deepEqual(externalOrigins({ url: 'ftp://example.com/x' }), [], 'only http(s) is a web dependency');
  assert.deepEqual(externalOrigins({ urls: ['https://a.se/x', 'http://b.se/y'] }), ['https://a.se', 'http://b.se']);
});

test('revalidation: an unchanged site leaves the skill alone', async () => {
  const fixed = '<html><body>samma innehåll</body></html>';
  const site = await serving(() => fixed);
  try {
    const before = await originFingerprint(site.url);
    assert.equal(before.status, 200);
    assert.ok(before.hash);

    const skill = skillWith([site.url], [before]);
    const transitions = await revalidateExternal([skill]);
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].changed, false);
    assert.equal(transitions[0].state, SKILL_STATES.REUSABLE);
  } finally {
    await site.close();
  }
});

test('revalidation: a changed site marks the skill STALE, not FAILED', async () => {
  let body = '<html><body>version 1</body></html>';
  const site = await serving(() => body);
  try {
    const before = await originFingerprint(site.url);
    const skill = skillWith([site.url], [before]);

    // The site is redesigned.
    body = '<html><body>helt ny layout, version 2, andra fält</body></html>';
    const transitions = await revalidateExternal([skill]);
    assert.equal(transitions[0].changed, true);
    assert.equal(transitions[0].state, SKILL_STATES.STALE);
    assert.equal(transitions[0].origin, site.url);
  } finally {
    await site.close();
  }
});

test('revalidation: an unreachable origin is not evidence that the site changed', async () => {
  const site = await serving(() => 'x');
  const url = site.url;
  await site.close(); // now nothing is listening there

  const skill = skillWith([url], [{ origin: url, status: 200, hash: 'abc123', length: 1 }]);
  const transitions = await revalidateExternal([skill], { timeoutMs: 800 });
  assert.equal(transitions[0].changed, false, 'a network failure was treated as a site change');
  assert.equal(transitions[0].state, SKILL_STATES.REUSABLE);
});

test('revalidation: it is bounded — max three origins, one request each, no retries', async () => {
  let hits = 0;
  const site = await serving(() => { hits += 1; return 'y'; });
  try {
    const before = await originFingerprint(site.url);
    hits = 0;
    const origins = [site.url, `${site.url}/a`, `${site.url}/b`, `${site.url}/c`];
    // Four entries recorded, but only three may be checked.
    const skill = skillWith(origins, [{ ...before }, { ...before }, { ...before }, { ...before }]);
    await revalidateExternal([skill]);
    assert.equal(hits, 3, `expected 3 bounded requests, saw ${hits}`);
  } finally {
    await site.close();
  }
});

test('revalidation: through the store, a changed site flips the persisted skill to STALE', async () => {
  let body = 'first version of the page';
  const site = await serving(() => body);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-reval-'));
  try {
    const before = await originFingerprint(site.url);
    const store = new LearnedSkillStore({ dir, fingerprint: 'fp' });
    const skill = skillWith([site.url], [before]);
    const skillDir = path.join(dir, skill.name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify(skill, null, 2));
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# proc\n');
    assert.equal(store.get(skill.name).learned.state, SKILL_STATES.REUSABLE);

    body = 'second version, completely different';
    const transitions = await revalidateExternal(store.list());
    assert.equal(transitions[0].changed, true);

    // Applying the transition is the caller's job; the store must persist it.
    const stored = store.get(skill.name);
    stored.learned.state = SKILL_STATES.STALE;
    stored.learned.staleReason = `external resource changed: ${site.url}`;
    store.persist(stored);

    const reread = JSON.parse(fs.readFileSync(path.join(skillDir, 'skill.json'), 'utf8'));
    assert.equal(reread.learned.state, SKILL_STATES.STALE);
    assert.match(reread.learned.staleReason, /external resource changed/);
    assert.ok(reread.learned.integrity, 'the integrity hash was not refreshed on persist');
  } finally {
    await site.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
