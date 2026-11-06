import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { URL } from 'node:url';
import { openExternal } from './open-external.js';
import { FileVaultKeychain } from '@studdy/ai-router';

/**
 * Optional Gmail read-only OAuth integration for an installed desktop client.
 * The Google Cloud OAuth Desktop client ID belongs to the user; NO app-wide
 * shared secret is bundled, and no password, passkey or app password is taken.
 * OAuth token is stored in Buddy's encrypted local vault. Gmail contents are
 * only fetched in response to an explicit request, never background crawled.
 */
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const CONFIG_KEY = 'gmail.oauth.client_id';
const TOKEN_KEY = 'gmail.oauth.tokens';

type Tokens = { access_token: string; refresh_token: string; expires_at: number };
export type GmailSummary = { id: string; threadId: string; subject: string; from: string; date: string; snippet: string };

export class GmailConnector {
  private vault: FileVaultKeychain;
  private pending = false;
  constructor(dataDir: string, private readonly openUrl: (url: string) => Promise<void> = openExternal) { this.vault = new FileVaultKeychain(dataDir); }

  status(): { connected: boolean; configured: boolean; connecting: boolean } {
    return { connected: !!this.tokens(), configured: !!this.vault.get(CONFIG_KEY), connecting: this.pending };
  }
  private tokens(): Tokens | null {
    const raw = this.vault.get(TOKEN_KEY);
    if (!raw) return null;
    try {
      const o = JSON.parse(raw) as Tokens;
      return typeof o.access_token === 'string' && typeof o.refresh_token === 'string' ? o : null;
    } catch { return null; }
  }
  private save(tokens: Tokens): void { this.vault.set(TOKEN_KEY, JSON.stringify(tokens)); }

  async connect(clientId: string): Promise<{ connected: boolean; detail: string }> {
    if (this.pending) throw new Error('Gmail-inloggning pågår redan.');
    if (!/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clientId)) {
      throw new Error('Ange ett Google OAuth Desktop Client ID från Google Cloud Console.');
    }
    this.pending = true;
    let server: Server | null = null;
    try {
      const verifier = randomBytes(48).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const state = randomBytes(32).toString('hex');
      const response = new Promise<string>((resolve, reject) => {
        server = createServer((req, res) => {
          try {
            const u = new URL(req.url ?? '', 'http://127.0.0.1');
            if (u.pathname !== '/oauth') { res.writeHead(404); res.end(); return; }
            if (u.searchParams.get('state') !== state) {
              res.writeHead(403); res.end('Invalid OAuth state'); reject(new Error('Google OAuth state mismatch')); return;
            }
            const error = u.searchParams.get('error');
            const code = u.searchParams.get('code');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end('<html><body><h3>Buddy: Gmail-inloggning ' + (code ? 'klar' : 'avbruten') + '</h3>Du kan stänga fliken.</body></html>');
            if (code) resolve(code);
            else reject(new Error(error ? 'Gmail OAuth: ' + error : 'Google skickade ingen authorization code'));
          } catch (err) { reject(err); }
        });
        server!.on('error', reject);
      });
      await new Promise<void>((resolve, reject) => {
        server!.listen(0, '127.0.0.1', () => resolve());
        server!.once('error', reject);
      });
      const address = server!.address();
      if (!address || typeof address === 'string') throw new Error('Kan inte öppna lokal OAuth-port.');
      const redirect = 'http://127.0.0.1:' + address.port + '/oauth';
      const url = new URL(AUTH);
      for (const [k, v] of Object.entries({
        client_id: clientId, redirect_uri: redirect, response_type: 'code',
        scope: SCOPE, access_type: 'offline', prompt: 'consent',
        state, code_challenge: challenge, code_challenge_method: 'S256',
      })) url.searchParams.set(k, v);
      await this.openUrl(url.toString());
      const code = await Promise.race([
        response,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Gmail-inloggningen tog för lång tid.')), 180_000)),
      ]);
      const form = new URLSearchParams({
        client_id: clientId, redirect_uri: redirect, code,
        code_verifier: verifier, grant_type: 'authorization_code',
      });
      const result = await fetch(TOKEN, {
        method: 'POST', body: form,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!result.ok) throw new Error('Google OAuth token HTTP ' + result.status);
      const token = await result.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (!token.access_token || !token.refresh_token) throw new Error('Google skickade ingen återanvändbar OAuth-token.');
      this.save({
        access_token: token.access_token, refresh_token: token.refresh_token,
        expires_at: Date.now() + Math.max(60, token.expires_in ?? 3600) * 1000,
      });
      this.vault.set(CONFIG_KEY, clientId);
      return { connected: true, detail: 'Gmail anslutet med läsbehörighet. Ingen mejlåtkomst utan en uttrycklig fråga.' };
    } finally {
      this.pending = false;
      if (server) (server as Server).close();
    }
  }

  async disconnect(): Promise<void> {
    const tokens = this.tokens();
    this.vault.delete(TOKEN_KEY);
    this.vault.delete(CONFIG_KEY);
    if (tokens?.access_token) {
      try {
        await fetch('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: tokens.access_token }),
          signal: AbortSignal.timeout(8000),
        });
      } catch { /* Local removal still takes effect; Google revocation can be done via Google Account. */ }
    }
  }

  private async accessToken(): Promise<string> {
    const tokens = this.tokens();
    const clientId = this.vault.get(CONFIG_KEY);
    if (!tokens || !clientId) throw new Error('Gmail är inte anslutet.');
    if (tokens.expires_at > Date.now() + 90_000) return tokens.access_token;
    const res = await fetch(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId, refresh_token: tokens.refresh_token, grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error('Gmail-token måste förnyas genom Google-inloggning (HTTP ' + res.status + ').');
    const next = await res.json() as { access_token?: string; expires_in?: number };
    if (!next.access_token) throw new Error('Google skickade ingen access token.');
    this.save({
      access_token: next.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + (next.expires_in ?? 3600) * 1000,
    });
    return next.access_token;
  }

  async list(query = 'in:inbox', max = 8): Promise<GmailSummary[]> {
    const access = await this.accessToken();
    const q = query.slice(0, 180);
    const params = new URLSearchParams({ q, maxResults: String(Math.min(15, Math.max(1, max))) });
    const headers = { Authorization: 'Bearer ' + access };
    const res = await fetch(GMAIL + '/messages?' + params, { headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error('Gmail list HTTP ' + res.status);
    const payload = await res.json() as { messages?: { id: string; threadId: string }[] };
    const ids = (payload.messages ?? []).slice(0, 15);
    return Promise.all(ids.map(async item => {
      const info = await fetch(GMAIL + '/messages/' + encodeURIComponent(item.id) + '?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date',
        { headers, signal: AbortSignal.timeout(20_000) });
      if (!info.ok) throw new Error('Gmail message HTTP ' + info.status);
      const data = await info.json() as { id: string; threadId: string; snippet?: string; payload?: { headers?: { name: string; value: string }[] } };
      const head = (name: string) => data.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
      return { id: data.id, threadId: data.threadId, subject: head('Subject'), from: head('From'), date: head('Date'), snippet: (data.snippet ?? '').slice(0, 200) };
    }));
  }
}
