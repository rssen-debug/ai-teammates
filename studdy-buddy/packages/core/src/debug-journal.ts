import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Local-only, bounded diagnostic memory. This file is NEVER uploaded.
 * No screenshots, study text, prompts or token-bearing request bodies.
 * Export to GitHub requires a separate explicit action by the owner.
 */
export class DebugJournal {
  readonly path: string;
  private busy = false;
  constructor(dataDir: string) {
    this.path = join(dataDir, 'Obsidian-Vault', 'debugger.md');
    mkdirSync(join(dataDir, 'Obsidian-Vault'), { recursive: true });
    if (!existsSync(this.path)) {
      writeFileSync(this.path,
        '# Buddy debugger\n\n' +
        'Lokal felsökningshistorik. **Privat – publicera inte denna fil direkt.**\n' +
        'AI-nycklar, promptar, skärmbilder och råa konversationsdata ska inte finnas här.\n\n' +
        '## Händelser\n\n',
        { encoding: 'utf8', mode: 0o600 });
    }
  }

  /** Local-only summarized diagnostics; returns sanitized entries, not raw errors. */
  summary(limit = 5): { count: number; recent: string[] } {
    try {
      const rows = readFileSync(this.path, 'utf8').split(/\r?\n/)
        .filter(line => /^- \d{4}-\d\d-\d\dT/.test(line));
      return { count: rows.length, recent: rows.slice(-Math.max(0, Math.min(20, limit))).map(line => safe(line)) };
    } catch {
      return { count: 0, recent: [] };
    }
  }

  record(source: string, error: unknown, severity: 'error' | 'warn' = 'error'): void {
    if (this.busy) return;
    this.busy = true;
    try {
      const label = safe(source).slice(0, 42);
      const message = error instanceof Error ? error.name + ': ' + error.message : String(error);
      const details = safe(message).slice(0, 320);
      const timestamp = new Date().toISOString();
      const next = '- ' + timestamp + ' | ' + severity.toUpperCase() + ' | ' + label + ' | ' + details + '\n';
      const existing = readFileSync(this.path, 'utf8');
      const header = existing.includes('## Händelser\n\n') ? existing.split('## Händelser\n\n')[0] + '## Händelser\n\n' : '# Buddy debugger\n\n## Händelser\n\n';
      const rows = existing.slice(existing.indexOf('## Händelser\n\n') + '## Händelser\n\n'.length)
        .split('\n').filter(line => line.startsWith('- '));
      const output = header + [...rows.slice(-199), next.trimEnd()].join('\n') + '\n';
      const temporary = this.path + '.tmp';
      writeFileSync(temporary, output, { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, this.path);
    } catch {
      // Logging must never crash the real app.
    } finally {
      this.busy = false;
    }
  }
}

export function safe(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\beyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g, '[JWT]')
    .replace(/\b(?:sk|pk|ghp|gho|ghu|ghs|github_pat)[-_][A-Za-z0-9_-]{12,}\b/gi, '[KEY]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [KEY]')
    .replace(/\b(?:api[_ -]?key|password|token|secret)\s*[:=]\s*[^\s,]+/gi, '[SECRET]')
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/[a-zA-Z]:\\Users\\[^\\\s]+/g, '[USER_PATH]')
    .replace(/\/(?:home|Users)\/[^/\s]+/g, '[USER_PATH]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[EMAIL]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[IP]')
    .replace(/[\x60<>|]/g, '')
    .slice(0, 350);
}
