import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { GmailConnector, GitHubDebugSync, DebugJournal } from '@studdy/core';

const dirs: string[] = [];
function dir() { const d = mkdtempSync(join(tmpdir(), 'studdy-connectors-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('Gmail OAuth/PKCE protocol (local callback, synthetic Google transport)', () => {
  it('uses S256, matching state, refresh token and encrypted storage; list and disconnect are explicit', async () => {
    const dataDir = dir();
    const calls: { url: string; init?: RequestInit }[] = [];
    const transport = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url); calls.push({ url: target, init });
      if (target.endsWith('/token')) return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600 });
      if (target.includes('/messages?')) return Response.json({ messages: [{ id: 'm1', threadId: 't1' }] });
      if (target.includes('/messages/m1')) return Response.json({ id: 'm1', threadId: 't1', snippet: 'Hej', payload: { headers: [{ name: 'Subject', value: 'Lektion' }, { name: 'From', value: 'lärare@example.com' }] } });
      if (target.endsWith('/revoke')) return new Response('', { status: 200 });
      throw new Error('Unexpected URL ' + target);
    }) as typeof fetch;
    const gmail = new GmailConnector(dataDir, async authUrl => {
      const url = new URL(authUrl);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('scope')).toContain('gmail.readonly');
      const redirect = new URL(url.searchParams.get('redirect_uri')!);
      const callback = await fetch(redirect + '?state=' + url.searchParams.get('state') + '&code=synthetic-code');
      expect(callback.status).toBe(200);
    }, transport);
    expect((await gmail.connect('12345-test.apps.googleusercontent.com')).connected).toBe(true);
    const tokenCall = calls.find(c => c.url.endsWith('/token'))!;
    const form = new URLSearchParams(String(tokenCall.init?.body));
    expect(form.get('code_verifier')).toBeTruthy();
    expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(join(dataDir, 'secrets.vault'), 'utf8')).not.toContain('synthetic-refresh');
    expect((await gmail.list())[0]).toMatchObject({ subject: 'Lektion', from: 'lärare@example.com' });
    await gmail.disconnect();
    expect(gmail.status().connected).toBe(false);
    expect(calls.some(c => c.url.endsWith('/revoke'))).toBe(true);
  }, 10_000);
});

describe('GitHub opt-in diagnostic protocol (synthetic transport, no repository writes)', () => {
  it('keeps the PAT out of config/report and uploads only sanitized codes', async () => {
    const dataDir = dir();
    const token = 'github_pat_synthetic_not_real_1234567890';
    const requests: { url: string; init?: RequestInit }[] = [];
    const transport = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      expect(String(url)).toBe('https://api.github.com/repos/test/repo/contents/buddy-diagnostics/DEBUGGER.md');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + token);
      return init?.method === 'PUT' ? Response.json({ content: { sha: 'next' } }) : new Response('', { status: 404 });
    }) as typeof fetch;
    const sync = new GitHubDebugSync(dataDir, transport);
    sync.configure({ repository: 'test/repo', token, enabled: true });
    new DebugJournal(dataDir).record('cli.provider', new Error('PROVIDER_AUTH HTTP 401 password=hunter2'));
    const report = sync.report();
    expect(report).toContain('PROVIDER_AUTH');
    expect(report).not.toContain('hunter2'); expect(report).not.toContain(token);
    expect((await sync.publish()).ok).toBe(true);
    const put = requests.find(r => r.init?.method === 'PUT')!;
    const body = JSON.parse(String(put.init?.body));
    expect(Buffer.from(body.content, 'base64').toString('utf8')).toBe(report);
    expect(readFileSync(join(dataDir, 'github-debug-sync.json'), 'utf8')).not.toContain(token);
    expect((await sync.publish()).detail).toContain('Inga nya');
  });
});
