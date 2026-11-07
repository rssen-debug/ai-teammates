import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventLog } from '../../src/v6/events.js';
import { JobStore, PROFILE_SCHEMA, canonicalUrl, jobFingerprint, loadProfiles, eligibility } from '../../src/v6/jobs/store.js';
import { transitionApplication, reconcileApplication } from '../../src/v6/jobs/state.js';
import { JobHunter } from '../../src/v6/jobs/hunter.js';

const profile = {
  schema: PROFILE_SCHEMA,
  candidates: [{
    id: 'it-candidate',
    displayName: 'IT Candidate',
    cvPath: '/owner/cv/it.pdf',
    contactEmail: 'candidate@example.com',
    gmailAccount: 'candidate@example.com',
    exclusions: { companies: ['Atea', 'Gigstep', 'Poolia'], roles: ['säljare'], locations: ['Kiruna'], salaryMin: 40000 },
    rules: { locationsAllow: ['stockholm', 'remote'], minScore: 0.5 },
    approval: { policy: 'allow-list', authorizedCompanies: ['Acme'] },
    quotas: { maxPerDay: 3 },
  }],
};

function fixture(t, { profiles = profile } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v6-jobs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesFile = path.join(root, 'profiles.json');
  if (profiles) fs.writeFileSync(profilesFile, JSON.stringify(profiles));
  const log = new EventLog(path.join(root, 'events'));
  const store = new JobStore({ file: path.join(root, 'applications.json'), log });
  const loaded = loadProfiles(profilesFile);
  return { root, log, store, loaded };
}

const jobs = [
  { site: 'platsbanken', siteId: '1', title: 'Frontend Developer', company: 'Acme AB', city: 'Stockholm', url: 'https://example.com/jobs/1?utm_source=x', apply: { url: 'https://example.com/jobs/1/apply' }, mustHave: ['JavaScript', 'React', 'Kubernetes'], description: 'React and Node.js' },
  { site: 'platsbanken', siteId: '2', title: 'Frontend Developer', company: 'Atea AB', city: 'Stockholm', url: 'https://example.com/jobs/2' },
  { site: 'platsbanken', siteId: '3', title: 'Backend Developer', company: 'Beta AB', city: 'Stockholm', url: 'https://example.com/jobs/3', mustHave: ['Node.js', 'TypeScript'] },
];

test('canonical URLs and fingerprints ignore tracking parameters and fragments', () => {
  assert.equal(canonicalUrl('https://Example.com/jobs/1/?utm_source=x&b=2&a=1#top'), 'https://example.com/jobs/1?a=1&b=2');
  assert.equal(jobFingerprint({ url: 'https://example.com/jobs/1?utm_campaign=z' }), jobFingerprint({ url: 'https://example.com/jobs/1' }));
  assert.equal(canonicalUrl('javascript:alert(1)'), null);
});

test('profiles are validated and candidate separation is explicit', (t) => {
  const { loaded } = fixture(t);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.candidates[0].id, 'it-candidate');
  const bad = structuredClone(profile);
  bad.candidates.push({ ...bad.candidates[0], displayName: 'second copy' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v6-bad-profiles-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'profiles.json');
  fs.writeFileSync(file, JSON.stringify(bad));
  assert.throws(() => loadProfiles(file), /Duplicate candidate id/);
});

test('employer, role, location and salary exclusions are enforced per candidate', (t) => {
  const { loaded } = fixture(t);
  const candidate = loaded.candidates[0];
  assert.equal(eligibility({ company: 'Atea AB', city: 'Stockholm' }, candidate).reason.code, 'COMPANY_EXCLUDED');
  assert.equal(eligibility({ company: 'Gigstep', city: 'Stockholm' }, candidate).reason.code, 'COMPANY_EXCLUDED');
  assert.equal(eligibility({ company: 'Poolia Sverige AB', city: 'Stockholm' }, candidate).reason.code, 'COMPANY_EXCLUDED');
  assert.equal(eligibility({ company: 'Acme', title: 'Säljare', city: 'Stockholm' }, candidate).reason.code, 'ROLE_EXCLUDED');
  assert.equal(eligibility({ company: 'Acme', title: 'Dev', city: 'Kiruna' }, candidate).reason.code, 'LOCATION_EXCLUDED');
  assert.equal(eligibility({ company: 'Acme', title: 'Dev', city: 'Göteborg' }, candidate).reason.code, 'LOCATION_NOT_ALLOWED');
  assert.equal(eligibility({ company: 'Acme', title: 'Dev', city: 'Stockholm', salary: 30000 }, candidate).reason.code, 'SALARY_BELOW_MINIMUM');
  assert.equal(eligibility({ company: 'Acme', title: 'Dev', city: 'Stockholm', salary: 50000 }, candidate).eligible, true);
});

test('application transitions refuse missing evidence and never revive an uncertain submission', () => {
  const app = { id: 'app_1', state: 'DISCOVERED', history: [] };
  assert.throws(() => transitionApplication(app, 'MATCHED', {}), /numeric match score/);
  transitionApplication(app, 'MATCHED', { evidence: { score: 0.7 } });
  assert.throws(() => transitionApplication(app, 'APPROVED', {}), /owner policy reference/);
  transitionApplication(app, 'APPROVED', { evidence: { approvalRef: 'policy:test' } });
  assert.throws(() => transitionApplication(app, 'FORM_PREPARED', {}), /Cannot move/);
  transitionApplication(app, 'FORM_STARTED', { evidence: { portalUrl: 'https://portal.example/apply' } });
  assert.throws(() => transitionApplication(app, 'FORM_PREPARED', { evidence: { cvFileName: 'cv.pdf' } }), /fieldsVerified/);
  transitionApplication(app, 'FORM_PREPARED', { evidence: { fieldsVerified: true, cvFileName: 'cv.pdf' } });
  transitionApplication(app, 'SUBMITTING', {});
  assert.throws(() => transitionApplication(app, 'SUBMITTED_UNCONFIRMED', { evidence: { receipt: {} } }), /concrete acknowledgement/);
  transitionApplication(app, 'SUBMITTED_UNCONFIRMED', { evidence: { receipt: { kind: 'portal', reference: 'R1' } } });
  assert.throws(() => transitionApplication(app, 'SUBMITTING', {}), /Cannot move/);
  transitionApplication(app, 'UNCERTAIN', {});
  assert.throws(() => transitionApplication(app, 'CONFIRMED_RECEIVED', { evidence: { confirmationId: 'x', confirmedAt: new Date().toISOString() } }), /owner reconciliation/);
  assert.throws(() => reconcileApplication(app, { outcome: 'confirmed', evidence: null }), /requires evidence/);
  reconcileApplication(app, { outcome: 'confirmed', evidence: { confirmationId: 'portal-9' } });
  assert.equal(app.state, 'CONFIRMED_RECEIVED');
  assert.throws(() => transitionApplication(app, 'SKIPPED', {}), /Cannot move/);
});

test('discovery deduplicates real listings and applies exclusions before storing', async (t) => {
  const { log, store, loaded } = fixture(t);
  let calls = 0;
  const hunter = new JobHunter({
    store, profiles: loaded, log,
    searchFn: async () => { calls += 1; return { ok: true, jobs }; },
    cvReader: async () => 'JavaScript React Node.js TypeScript',
  });
  const first = await hunter.discover({ candidateId: 'it-candidate', query: 'frontend', limit: 10 });
  assert.equal(first.ok, true);
  assert.equal(first.discovered, 3);
  assert.equal(first.newJobs, 2);
  assert.equal(first.excluded, 1);
  assert.ok(first.skipped.some((entry) => entry.code === 'COMPANY_EXCLUDED'));

  const second = await hunter.discover({ candidateId: 'it-candidate', query: 'frontend', limit: 10 });
  assert.equal(second.newJobs, 0);
  const all = await store.list({ candidateId: 'it-candidate' });
  assert.equal(all.length, 2, 'duplicate listings are not stored twice');

  const unknown = await hunter.discover({ candidateId: 'other', query: 'x' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'CANDIDATE_UNKNOWN');
  assert.equal(calls, 2);
});

test('matching, approval policy, submission evidence and email confirmation form one pipeline', async (t) => {
  const { log, store, loaded } = fixture(t);
  const gmailResults = [];
  const gmail = {
    account: 'candidate@example.com',
    findApplicationEmails: async () => gmailResults.shift() || { scanned: 0, matched: null },
  };
  const hunter = new JobHunter({
    store, profiles: loaded, log, gmail,
    searchFn: async () => ({ ok: true, jobs: [jobs[0]] }),
    cvReader: async () => 'JavaScript React Node.js TypeScript',
  });
  await hunter.discover({ candidateId: 'it-candidate', query: 'frontend' });
  const [app] = await store.list({ candidateId: 'it-candidate' });

  const evaluated = await hunter.evaluate({ applicationId: app.id });
  assert.equal(evaluated.ok, true);
  let stored = await store.get(app.id);
  assert.equal(stored.state, 'APPROVED', 'allow-list policy approved the authorized employer');
  assert.ok(stored.score > 0.5);

  assert.equal((await hunter.recordSubmission({ applicationId: app.id, receipt: null })).ok, false);
  stored = await store.get(app.id);
  assert.equal(stored.state, 'APPROVED', 'a submission cannot skip form preparation');

  const { transitionApplication } = await import('../../src/v6/jobs/state.js');
  transitionApplication(stored, 'FORM_STARTED', { evidence: { portalUrl: 'https://portal.example/apply' } });
  transitionApplication(stored, 'FORM_PREPARED', { evidence: { fieldsVerified: true, cvFileName: 'cv-it.pdf' } });
  await store.save(stored);

  const submitted = await hunter.recordSubmission({
    applicationId: app.id,
    receipt: { kind: 'portal-ack', reference: 'ACK-123', url: 'https://example.com/jobs/1/apply' },
    portalUrl: 'https://example.com/jobs/1/apply',
  });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.state, 'SUBMITTED_UNCONFIRMED');

  const repeated = await hunter.recordSubmission({
    applicationId: app.id,
    receipt: { kind: 'portal-ack', reference: 'ACK-123' },
  });
  assert.equal(repeated.alreadySubmitted, true, 'an acknowledged submission is never repeated');

  gmailResults.push({
    scanned: 2,
    matched: { messageId: 'msg-1', kind: 'verification', receivedAt: new Date().toISOString(), senderDomain: 'portal.example' },
  });
  const pending = await hunter.checkVerificationEmail({ applicationId: app.id });
  assert.equal(pending.state, 'EMAIL_VERIFICATION_PENDING');

  gmailResults.push({
    scanned: 3,
    matched: { messageId: 'msg-2', kind: 'confirmation', receivedAt: new Date().toISOString(), senderDomain: 'portal.example', reference: 'ACK-123' },
  });
  const confirmed = await hunter.checkVerificationEmail({ applicationId: app.id });
  assert.equal(confirmed.state, 'CONFIRMED_RECEIVED');
  stored = await store.get(app.id);
  assert.equal(stored.state, 'CONFIRMED_RECEIVED');
  assert.ok(stored.evidence.some((item) => item.type === 'gmail-confirmation'));
  const confirmedEvents = log.read({ types: ['job.confirmed'], limit: 10 });
  assert.equal(confirmedEvents.length, 1, 'confirmation is recorded once');
});

test('without a Gmail client the check is an explicit blocker, not a success', async (t) => {
  const { store, loaded } = fixture(t);
  const hunter = new JobHunter({ store, profiles: loaded, gmail: null });
  const result = await hunter.checkVerificationEmail({ applicationId: 'missing' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'GMAIL_NOT_CONFIGURED');
});
