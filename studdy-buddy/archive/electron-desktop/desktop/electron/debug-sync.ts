import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileVaultKeychain } from '@studdy/ai-router';
import { safe } from './debug-journal.js';

type Config = { repository: string; enabled: boolean };
type GitHubFile = { sha?: string };

const HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'Studdy-Buddy-Diagnostics', 'X-GitHub-Api-Version': '2022-11-28' };
const REMOTE_PATH = 'buddy-diagnostics/DEBUGGER.md';

/**
 * Explicit opt-in GitHub diagnostic publishing.
 *
 * IMPORTANT: The private debugger.md is NEVER uploaded.
 * A separate allowlisted, code-only summary is generated from it. The PAT is
 * encrypted in the same local key vault as the AI provider secret and is never
 * returned to the renderer, the model or logs.
 */
export class GitHubDebugSync {
  private readonly configPath: string;
  private readonly keychain: FileVaultKeychain;
  private readonly localDebugPath: string;
  private active = false;
  private lastPublished = '';

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.configPath = join(dataDir, 'github-debug-sync.json');
    this.localDebugPath = join(dataDir, 'Obsidian-Vault', 'debugger.md');
    this.keychain = new FileVaultKeychain(dataDir);
  }

  private config(): Config {
    if (!existsSync(this.configPath)) return { repository: '', enabled: false };
    try {
      const json = JSON.parse(readFileSync(this.configPath, 'utf8')) as Partial<Config>;
      return { repository: typeof json.repository === 'string' ? json.repository : '', enabled: json.enabled === true };
    } catch {
      return { repository: '', enabled: false };
    }
  }

  status(): { repository: string; enabled: boolean; hasToken: boolean; target: string } {
    const config = this.config();
    return {
      repository: config.repository,
      enabled: config.enabled,
      hasToken: Boolean(this.keychain.get('github.debug.pat')),
      target: REMOTE_PATH,
    };
  }

  configure(input: { repository: string; token?: string; enabled: boolean }): { repository: string; enabled: boolean; hasToken: boolean; target: string } {
    if (!/^[a-zA-Z0-9_.-]{1,80}\/[a-zA-Z0-9_.-]{1,100}$/.test(input.repository)) {
      throw new Error('Ange ett repository som owner/repo, t.ex. rssen-debug/ai-teammates.');
    }
    // GitHub fine-grained PAT with Contents: read/write, only this repo.
    // Never accept keys in an AI chat command.
    if (input.token?.trim()) this.keychain.set('github.debug.pat', input.token.trim());
    if (input.enabled && !this.keychain.get('github.debug.pat')) {
      throw new Error('GitHub-nyckel saknas. Ange den i den säkra inställningsrutan.');
    }
    writeFileSync(this.configPath, JSON.stringify({ repository: input.repository, enabled: input.enabled } satisfies Config), { mode: 0o600 });
    return this.status();
  }

  /** Only machine-classified error codes; do not upload the local details. */
  report(): string {
    const lines = existsSync(this.localDebugPath) ? readFileSync(this.localDebugPath, 'utf8').split(/\r?\n/) : [];
    const rows = lines.filter(line => /^- \d{4}-\d\d-\d\dT/.test(line)).slice(-80).map(line => {
      const parts = line.split('|');
      const timestamp = (parts[0] ?? '').match(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/)?.[0] ?? '';
      const severity = /WARN/i.test(parts[1] ?? '') ? 'WARN' : 'ERROR';
      const source = safe(parts[2] ?? 'unknown').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 36) || 'unknown';
      const errorCode = ((parts[3] ?? '').match(/\b(?:HTTP\s*[1-5]\d\d|[A-Z][A-Z0-9_]{2,36}|TS\d{4,5}|E[A-Z0-9_]{3,30})\b/) ?? [])[0] ?? 'UNCLASSIFIED';
      return '- ' + timestamp + ' | ' + severity + ' | ' + source + ' | ' + errorCode;
    });
    return [
      '# STUDDY BUDDY — Sanitized debugger report',
      '',
      '> Opt-in export. Only severity, subsystem and machine-classified error codes.',
      '> No chat content, screenshots, file paths, API keys, tokens, URLs or raw traces.',
      '',
      '## Recent events',
      '',
      ...(rows.length ? rows : ['No classified events.']),
      '',
    ].join('\n');
  }

  async publish(): Promise<{ ok: boolean; detail: string }> {
    if (this.active) return { ok: false, detail: 'Synkronisering pågår redan.' };
    const config = this.config();
    const token = this.keychain.get('github.debug.pat');
    if (!config.enabled || !token) return { ok: false, detail: 'GitHub-synk är inte aktiverad.' };
    this.active = true;
    try {
      const report = this.report();
      if (report === this.lastPublished) return { ok: true, detail: 'Inga nya rapporterade fel.' };
      const url = 'https://api.github.com/repos/' + config.repository + '/contents/' + REMOTE_PATH;
      const authorization = { ...HEADERS, Authorization: 'Bearer ' + token };
      const lookup = await fetch(url, { headers: authorization, signal: AbortSignal.timeout(15000) });
      let sha: string | undefined;
      if (lookup.status === 200) {
        const file = await lookup.json() as GitHubFile;
        sha = typeof file.sha === 'string' ? file.sha : undefined;
      } else if (lookup.status !== 404) {
        throw new Error('GitHub lookup HTTP ' + lookup.status);
      }
      const res = await fetch(url, {
        method: 'PUT',
        headers: { ...authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'chore(buddy): update sanitized diagnostics',
          content: Buffer.from(report, 'utf8').toString('base64'),
          ...(sha ? { sha } : {}),
        }),
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) throw new Error('GitHub update HTTP ' + res.status);
      this.lastPublished = report;
      return { ok: true, detail: 'Rensad felrapport är uppdaterad i ' + config.repository + '/' + REMOTE_PATH };
    } catch (err) {
      // Explicitly never echo the server response body, which might include
      // secret-bearing input or provider error text.
      return { ok: false, detail: err instanceof Error ? err.message : 'GitHub-synk misslyckades.' };
    } finally {
      this.active = false;
    }
  }
}
