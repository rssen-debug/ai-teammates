import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GmailClient, classifyApplicationEmail, extractReference, extractLinks,
  loadGmailCredentials, matchEmailToApplication,
} from '../../src/v6/gmail.js';

const b64url = (text) => Buffer.from(text, 'utf8').toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

test('marketing mail is not mistaken for an application verification', () => {
  const marketing = classifyApplicationEmail({
    subject: 'Weekly job alert: 42 new roles',
    from: 'jobs <no-reply@jobsite.example>',
    snippet: 'Unsubscribe from this newsletter',
    text: 'Recommended jobs for you. Unsubscribe here.',
  });
  assert.equal(marketing.isApplicationEmail, false);
  assert.equal(marketing.kind, 'marketing');

  const verification = classifyApplicationEmail({
    subject: 'Verify your email address for your application',
    from: 'Acme Careers <careers@acme.example>',
    snippet: 'Please verify your email address to complete your application.',
  });
  assert.equal(verification.isApplicationEmail, true);
  assert.equal(verification.kind, 'verification');

  const confirmation = classifyApplicationEmail({
    subject: 'Thank you for your application',
    from: 'Acme Careers <careers@acme.example>',
    snippet: 'We have received your application for Frontend Developer.',
    text: 'Your application has been received. Reference: ACME-2026-0042',
  });
  assert.equal(confirmation.isApplicationEmail, true);
  assert.equal(confirmation.kind, 'confirmation');
  assert.equal(extractReference(confirmation && 'Reference: ACME-2026-0042'), 'ACME-2026-0042');
  assert.deepEqual(extractLinks('See https://acme.example/verify?token=secret and https://acme.example/verify?token=secret'), ['https://acme.example/verify?token=secret']);

  const ambiguous = classifyApplicationEmail({
    subject: 'Application received — special offer inside',
    from: 'marketing@example.com',
    snippet: 'Unsubscribe. Your application has been received.',
  });
  assert.equal(ambiguous.isApplicationEmail, false);
  assert.equal(ambiguous.kind, 'ambiguous');
});

test('email is matched to the right application by employer and role', () => {
  const applications = [
    { id: 'app-acme', job: { company: 'Acme AB', title: 'Frontend Developer', siteId: '1' } },
    { id: 'app-beta', job: { company: 'Beta AB', title: 'Backend Developer', siteId: '2' } },
  ];
  const match = matchEmailToApplication({
    subject: 'Your application to Acme',
    text: 'Thank you for applying to the Frontend Developer role at Acme.',
  }, applications);
  assert.equal(match.applicationId, 'app-acme');
  assert.ok(match.reasons.includes('employer-name'));
  assert.equal(matchEmailToApplication({ subject: 'Unrelated', text: 'nothing' }, applications), null);
});

test('credentials are owner-supplied, read-only scoped and permission checked', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v6-gmail-creds-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'gmail.json');
  const creds = { clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh', account: 'owner@example.com' };
  fs.writeFileSync(file, JSON.stringify(creds));
  fs.chmodSync(file, 0o644);
  if (process.platform !== 'win32') {
    const blocked = loadGmailCredentials({ file });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'GMAIL_CREDENTIALS_PERMISSIONS');
  }
  fs.chmodSync(file, 0o600);
  const loaded = loadGmailCredentials({ file });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.credentials.scope, 'https://www.googleapis.com/auth/gmail.readonly');

  const unsafe = loadGmailCredentials({ file: path.join(root, 'missing.json'), env: {} });
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.error.code, 'GMAIL_NOT_CONFIGURED');

  const fromEnv = loadGmailCredentials({
    file: path.join(root, 'missing.json'),
    env: { MAJIN_V6_GMAIL_CLIENT_ID: 'a', MAJIN_V6_GMAIL_CLIENT_SECRET: 'b', MAJIN_V6_GMAIL_REFRESH_TOKEN: 'c' },
  });
  assert.equal(fromEnv.ok, true);
  assert.equal(fromEnv.source, 'env');
});

test('read-only Gmail search finds a confirmation without logging secrets or bodies', async (t) => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('oauth2.googleapis.com')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'access-token-value-123456', expires_in: 3600 }) };
    }
    if (url.includes('/messages?')) {
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'msg-1' }] }) };
    }
    if (url.includes('/messages/msg-1')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          id: 'msg-1', threadId: 't1', internalDate: String(Date.now()), snippet: 'We have received your application',
          labelIds: ['INBOX'],
          payload: {
            headers: [
              { name: 'Subject', value: 'Thank you for your application' },
              { name: 'From', value: 'Acme Careers <careers@acme.example>' },
              { name: 'Date', value: new Date().toUTCString() },
            ],
            mimeType: 'text/plain',
            body: { data: b64url('Thank you for your application to Acme. Your application has been received. Reference: ACME-2026-0042') },
          },
        }),
      };
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const events = [];
  const log = { append: (type, data) => events.push({ type, data }) };
  const client = new GmailClient({
    credentials: { clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh-token-value', account: 'owner@example.com' },
    fetchImpl, log,
  });
  const result = await client.findApplicationEmails({ company: 'Acme', title: 'Frontend Developer', sinceDays: 30 });
  assert.equal(result.scanned, 1);
  assert.equal(result.matched.kind, 'confirmation');
  assert.equal(result.matched.reference, 'ACME-2026-0042');
  assert.equal(result.matched.messageId, 'msg-1');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'gmail.checked');
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes('refresh-token-value'));
  assert.ok(!serialized.includes('access-token-value'));
  assert.ok(!serialized.includes('ACME-2026-0042'), 'message references are not copied into telemetry');
  assert.equal(calls.filter((call) => call.url.includes('/messages?')).length, 1);
  const authHeader = calls.find((call) => call.url.includes('/messages?')).options.headers.authorization;
  assert.equal(authHeader, 'Bearer access-token-value-123456');
});

test('a failed OAuth response is a typed failure, not an empty inbox', async () => {
  const client = new GmailClient({
    credentials: { clientId: 'id', clientSecret: 'secret', refreshToken: 'bad' },
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) }),
  });
  await assert.rejects(() => client.findApplicationEmails({ company: 'Acme' }), (error) => error.code === 'GMAIL_AUTH_FAILED');
});
