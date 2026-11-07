/**
 * jobs: the application state machine, dedupe, CV-match and the Platsbanken
 * wire parser — all pure/offline except one honest live probe at the end,
 * gated the same way the browser suite is (MAJIN_JOBS_LIVE=1).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication, transition, fingerprint, normalizeUrl, scoreCv, cvSkills, STATUS } from '../src/core/jobs/model.js';
import { parseHits, parseHit, searchPlatsbanken } from '../src/core/jobs/platsbanken.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-jobs-'));
process.env.MAJIN_HOME = HOME;
import { loadCv, saveCv, loadApplications, saveApplications } from '../src/core/jobs/store.js';

test('status machine: the honest path, the illegal jumps, terminal means terminal', () => {
  const job = { site: 'platsbanken', title: 'Webbutvecklare', company: 'Test AB', url: 'https://arbetsformedlingen.se/platsbanken/annonser/123' };
  const app = createApplication(job, { now: () => 1000 });
  assert.equal(app.status, 'found');
  assert.equal(app.fp, fingerprint(job));
  assert.throws(() => transition(app, 'submitted'), /cannot move .* from found to submitted/, 'no teleporting from found to submitted');
  transition(app, 'matched', { evidence: { score: 0.9 } });
  transition(app, 'started');
  transition(app, 'waiting', { evidence: { note: 'approval asked' } });
  assert.throws(() => transition(app, 'completed'), /unknown status/, 'typos in status names are caught');
  transition(app, 'submitted', { by: 'agent', evidence: { proof: 'https://example.com/thanks?id=42' } });
  assert.equal(app.history.length, 5, 'every move is a line in the history');
  assert.equal(app.history.at(-1).by, 'agent');
  assert.throws(() => transition(app, 'failed', { evidence: { error: 'x' } }), /done is done/, 'submitted stays submitted');
  assert.deepEqual(STATUS, ['found', 'matched', 'started', 'waiting', 'submitted', 'failed', 'skipped']);
});

test('status machine: failure demands words, submission demands proof, retry is real', () => {
  const app = createApplication({ title: 'X', company: 'Y', url: 'https://x.se/jobb/1' });
  transition(app, 'matched', { evidence: { score: 0.5 } });
  transition(app, 'started');
  assert.throws(() => transition(app, 'failed'), /must say WHY/, 'silent failure is refused');
  transition(app, 'failed', { evidence: { error: 'the form rejected the upload' } });
  transition(app, 'started', { evidence: { note: 'retry after fix' } }, 'failed → started is the retry');
  assert.throws(() => transition(app, 'submitted'), /must carry PROOF/, 'submission without proof is refused');
});

test('dedupe: tracking junk cannot create twins; real params keep jobs apart', () => {
  const a = { title: 'Dev', company: 'C', url: 'https://site.se/jobs/42?utm_source=x&utm_campaign=y' };
  const b = { title: 'Dev', company: 'C', url: 'https://SITE.se/jobs/42/' };
  assert.equal(fingerprint(a), fingerprint(b), 'same job, different tracking — one fingerprint');
  const c = { title: 'Dev', company: 'C', url: 'https://site.se/list?jobId=42' };
  const d = { title: 'Dev', company: 'C', url: 'https://site.se/list?jobId=43' };
  assert.notEqual(fingerprint(c), fingerprint(d), 'different jobId params are different jobs');
  const noUrl1 = { title: 'Webbutvecklare', company: 'Tésterå AB' };
  const noUrl2 = { title: 'webbutvecklare', company: 'testera ab' };
  assert.equal(fingerprint(noUrl1), fingerprint(noUrl2), 'title+company fallback folds case and diacritics');
  assert.notEqual(fingerprint(noUrl1), fingerprint({ title: 'webbutvecklare', company: 'annat ab' }));
  assert.equal(normalizeUrl('HTTPS://Site.SE/path/?utm_source=z&b=2&a=1#frag'), 'https://site.se/path?a=1&b=2');
});

test('match: tagged demands beat ad text; honest basis reporting', () => {
  const cv = 'Systemutvecklare. Node.js, TypeScript, PostgreSQL, Docker, Kubernetes, GitHub Actions. Svenska och engelska. Körkort B.';
  assert.ok(cvSkills(cv).includes('node') && cvSkills(cv).includes('typescript'), 'the CV reads its own skills');
  const tagged = scoreCv(cv, {
    title: 'Backendutvecklare',
    mustHave: ['Node.js', 'SQL'],
    niceToHave: ['Kubernetes', 'GraphQL'],
  });
  assert.equal(tagged.basis, 'tagged');
  assert.equal(tagged.score, 0.83, '2/2 must (2.0) + 1/2 nice (0.5) over 3.0 = 0.833 → honestly 0.83');
  assert.ok(tagged.matched.includes('devops'), 'kubernetes folds to devops — NOT csharp (the .net ⊂ kubernetes trap)');
  assert.ok(tagged.missing.includes('api'), 'graphql folded into api reports the miss');
  const texty = scoreCv(cv, { title: 'Senior Node TypeScript Rust Developer', description: 'Vi söker dig som kan node och typescript, gärna rust.' });
  assert.equal(texty.basis, 'text');
  assert.ok(texty.score > 0 && texty.score < 1, 'text match is partial, never inflated');
  assert.ok(texty.matched.includes('node') && !texty.matched.includes('rust'));
  const empty = scoreCv('hej hej hej', { title: 'Dev', description: 'python' });
  assert.equal(empty.score, null, 'unrecognizable CV admits it cannot score');
});

/* the REAL wire shape, observed 2026-10-18 against the production API —
   trimmed, but every field the parser reads is exercised verbatim */
const FIXTURE = {
  total: { value: 431 },
  hits: [
    {
      id: 31581608,
      webpage_url: 'https://arbetsformedlingen.se/platsbanken/annonser/31581608',
      headline: 'websida utvecklare',
      application_deadline: '2026-11-11T23:59:59',
      publication_date: '2026-10-12T06:38:05',
      number_of_vacancies: 1,
      description: { text: 'Websida designer till LAREOL HB' },
      employer: { name: 'LAREOL HB', email: null, url: null },
      experience_required: true,
      application_details: { information: null, reference: 'webbutvecklare', email: 'ansok@example.org', url: null, other: null },
      must_have: { skills: [{ weight: null, concept_id: 'x', label: 'HTML, märkspråk' }], languages: [], work_experiences: [], education: [] },
      nice_to_have: { skills: [{ weight: null, concept_id: 'y', label: 'Python, programmeringsspråk' }] },
      workplace_address: { municipality: 'Göteborg', city: null, region: 'Västra Götaland', country: 'Sverige' },
      removed: false,
    },
  ],
};

test('platsbanken parser: canonical jobs from the production JSON shape', () => {
  const { total, jobs } = parseHits(FIXTURE);
  assert.equal(total, 431, 'total.value is the API count, not this page');
  assert.equal(jobs.length, 1);
  const j = jobs[0];
  assert.equal(j.site, 'platsbanken');
  assert.equal(j.siteId, '31581608', 'id is stringified — no number/string wobble downstream');
  assert.equal(j.title, 'websida utvecklare');
  assert.equal(j.company, 'LAREOL HB');
  assert.equal(j.city, 'Göteborg', 'municipality is the city when city is null');
  assert.equal(j.deadline, '2026-11-11T23:59:59');
  assert.deepEqual(j.apply, { email: 'ansok@example.org' }, 'email apply beats absent url');
  assert.deepEqual(j.mustHave, ['HTML, märkspråk']);
  assert.deepEqual(j.niceToHave, ['Python, programmeringsspråk']);
  assert.equal(j.experienceRequired, true);
  /* url-apply wins when both exist */
  const both = parseHit({ ...FIXTURE.hits[0], application_details: { url: 'https://apply.example.org/', email: 'x@y.se' } });
  assert.deepEqual(both.apply, { url: 'https://apply.example.org/' });
  assert.deepEqual(parseHit({}).apply, null, 'no contact channel = honest null, not a guess');
  assert.deepEqual(parseHits({}).jobs, [], 'a broken payload parses to empty, not to a crash');
});

test('store: roundtrip + corrupt-file safety (a torn store is empty, never fatal)', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(path.join(HOME, 'jobs'), { recursive: true });
  await saveCv('Test-CV med node och git');
  const cv = await loadCv();
  assert.equal(cv.text, 'Test-CV med node och git');
  const app = createApplication({ title: 'Dev', company: 'C', url: 'https://x.se/1' });
  await saveApplications({ [app.fp]: app });
  const back = await loadApplications();
  assert.equal(back[app.fp].title, 'Dev');
  writeFileSync(path.join(HOME, 'jobs', 'applications.json'), '{broken json', 'utf8');
  const safe = await loadApplications();
  assert.deepEqual(safe, {}, 'corrupt file reads as empty — the pipeline survives');
});

test('jobs tools: registered, right risks, cv.set/show work end-to-end', async () => {
  const { toolCount, buildRegistry } = await import('../src/core/tools/index.js');
  assert.equal(toolCount(), 149, '149 integrated tools are registered; none are disabled');
  const cfg = { get: () => 0, set: () => {} };
  const reg = buildRegistry({ cfg });
  const names = reg.list().map((t) => t.name);
  for (const t of ['jobs.search', 'jobs.match', 'jobs.list', 'jobs.start', 'jobs.skip', 'jobs.cv.set', 'jobs.cv.show', 'jobs.prepare', 'jobs.send']) {
    assert.ok(names.includes(t), `${t} is registered`);
  }
  const risks = Object.fromEntries(reg.list().map((t) => [t.name, t.risk]));
  assert.equal(risks['jobs.search'], 'read');
  assert.equal(risks['jobs.cv.set'], 'write');
  assert.equal(risks['jobs.start'], 'write');
  assert.equal(risks['jobs.prepare'], 'exec');
  assert.equal(risks['jobs.send'], 'destructive', 'every submission asks — that is the whole point');
  const set = await reg.exec('jobs.cv.set', { text: 'CV: JavaScript developer, react, node, svenska, engelska' }, { session: 'jest' });
  const out = JSON.parse(set.result); // exec caps to the result envelope — fields ride inside
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.ok(out.skills.includes('javascript'));
  const show = await reg.exec('jobs.cv.show', {}, { session: 'jest' });
  assert.equal(show.ok, true);
  assert.ok(JSON.parse(show.result).chars > 10);
  const matchNoSearch = await reg.exec('jobs.match', {}, { session: 'jest' });
  assert.equal(matchNoSearch.ok, true, 'scoring an empty pipeline is an empty answer, not a crash');
});

const WHY_SKIP = 'set MAJIN_JOBS_LIVE=1 for a real Platsbanken round-trip (network, third-party, may rate-limit)';
test('live: real Platsbanken search end-to-end', { skip: process.env.MAJIN_JOBS_LIVE !== '1' && WHY_SKIP, timeout: 30000 }, async () => {
  const r = await searchPlatsbanken({ q: 'utvecklare', limit: 3 });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.ok(r.jobs.length >= 1, 'real hits come back');
  assert.ok(r.jobs[0].title && r.jobs[0].url, 'canonical fields are populated');
});

test('formfill: generic field roles — no site recipes, words decide', async () => {
  const { classifyField } = await import('../src/core/jobs/formfill.js');
  assert.equal(classifyField({ tag: 'input', type: 'email', label: 'E-post', name: 'candidate[email]' }).role, 'email');
  assert.equal(classifyField({ tag: 'input', type: 'tel', aria: 'Telefonnummer' }).role, 'phone');
  assert.equal(classifyField({ tag: 'input', type: 'text', label: 'Ditt namn' }).role, 'name');
  assert.equal(classifyField({ tag: 'input', type: 'file' }).role, 'cv', 'a bare file input in a form wants the CV');
  assert.equal(classifyField({ tag: 'input', type: 'file', label: 'Ladda upp ditt CV här' }).role, 'cv');
  assert.equal(classifyField({ tag: 'textarea', label: 'Personligt brev' }).role, 'coverletter');
  assert.equal(classifyField({ tag: 'input', type: 'url', label: 'LinkedIn-profil' }).role, 'linkedin');
  assert.equal(classifyField({ tag: 'input', type: 'hidden', name: 'csrf' }).role, 'ignore', 'hidden is never an answer');
  assert.equal(classifyField({ tag: 'input', type: 'text', name: 'x_9kq' }).get ? 'x' : classifyField({ tag: 'input', type: 'text', name: 'x_9kq' }).role, 'other', 'wordless mystery stays "other", never guessed');
  // traps: longest whole-word must win over substring bait
  assert.equal(classifyField({ tag: 'input', type: 'text', label: 'Phone model preference' }).role, 'phone');
  assert.notEqual(classifyField({ tag: 'input', type: 'text', label: 'Internet speed (Mbit)' }).role, 'linkedin', 'internet contains "in" — whole-word only');
});

test('formfill: contact extraction finds the real thing, never invents', async () => {
  const { extractContact } = await import('../src/core/jobs/formfill.js');
  const c = extractContact('Anna Svensson\nanna.svensson@example.se\n073-123 45 67\nlinkedin.com/in/annasv\ngithub.com/annasv-codes');
  assert.equal(c.email, 'anna.svensson@example.se');
  assert.ok(c.phone && c.phone.includes('073'));
  assert.equal(c.linkedin, 'linkedin.com/in/annasv');
  assert.equal(c.github, 'github.com/annasv-codes');
  const none = extractContact('bara text utan kontaktinfo');
  assert.equal(none.email, null, 'no email in the CV says null, not a guess');
  assert.equal(none.phone, null);
});

test('formfill: proof = confirmation words; a redirect alone proves nothing', async () => {
  const { buildProof } = await import('../src/core/jobs/formfill.js');
  const good = buildProof({ urlBefore: 'https://x.se/apply', urlAfter: 'https://x.se/thanks', pageText: 'TACK FÖR DIN ANSÖKAN! Vi återkommer inom två veckor.' });
  assert.equal(good.accepted, true);
  assert.equal(good.kind, 'url+words');
  assert.ok(good.words.length >= 2, 'both phrases counted');
  const wordsOnly = buildProof({ urlBefore: 'https://x.se/apply', urlAfter: 'https://x.se/apply', pageText: 'Your application has been submitted.' });
  assert.equal(wordsOnly.accepted, true);
  assert.equal(wordsOnly.kind, 'words', 'SPA confirms in place — words without a url move are still proof');
  const movedOnly = buildProof({ urlBefore: 'https://x.se/apply', urlAfter: 'https://x.se/step2', pageText: 'step 2 of 4 — tell us about your salary' });
  assert.equal(movedOnly.accepted, false, 'the portal moved but confirmed nothing — the move is not proof');
  assert.equal(movedOnly.kind, 'none');
});

test('formfill: planValue never invents contact data', async () => {
  const { planValue } = await import('../src/core/jobs/formfill.js');
  assert.equal(planValue('email', { profile: { email: 'a@b.se' } }), 'a@b.se');
  assert.equal(planValue('phone', { profile: {} }), null, 'missing phone is null, never a made-up number');
  assert.equal(planValue('cv', {}), '__cv__', 'the file sentinel');
  assert.equal(planValue('other', { profile: { email: 'a@b.se' } }), null);
});

test('coerceForType: url fields get a scheme, everything else is left alone', async () => {
  const { coerceForType } = await import('../src/core/jobs/formfill.js');
  assert.equal(coerceForType('github.com/testkandidat', 'url'), 'https://github.com/testkandidat', 'the CI failure: schemeless into type=url silently cancels the submit');
  assert.equal(coerceForType('linkedin.com/in/annasv', 'URL'), 'https://linkedin.com/in/annasv');
  assert.equal(coerceForType('https://x.se/a', 'url'), 'https://x.se/a', 'already-schemed passes through');
  assert.equal(coerceForType('github.com/testkandidat', 'text'), 'github.com/testkandidat', 'text fields keep whatever the user meant');
  assert.equal(coerceForType('070-111 22 33', 'tel'), '070-111 22 33');
  assert.equal(coerceForType('', 'url'), null, 'empty is empty, not https://air');
  assert.equal(coerceForType(null, 'url'), null);
});
