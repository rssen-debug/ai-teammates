import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Obsidian-compatible local Markdown memory.
 *
 * The vault is separate from the learning database: notes provide searchable
 * historical context, but NEVER count as demonstrated knowledge or evidence.
 * No plugins, cloud sync, Obsidian installation, or provider credentials needed.
 */
export class ObsidianMemory {
  readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, 'Obsidian-Vault');
    mkdirSync(join(this.path, 'Daily'), { recursive: true });
    const index = join(this.path, 'README.md');
    if (!existsSync(index)) {
      writeFileSync(index,
        '# Buddy memory\n\n' +
        'Local, editable Markdown notes compatible with Obsidian. Open this folder as a vault.\n\n' +
        '- [[Daily]] — conversation summaries, not proof of mastery\n' +
        '- API keys, passwords, and screenshots must never be recorded here.\n' +
        '- To erase these notes, delete the Obsidian-Vault folder.\n',
        { encoding: 'utf8' });
    }
  }

  private scrub(text: string): string {
    return text
      .replace(/\beyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g, '[REDACTED JWT]')
      .replace(/\b(?:sk|pk|ghp|gho|ghu|ghs|github_pat)[-_][A-Za-z0-9_-]{18,}\b/gi, '[REDACTED KEY]')
      .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{16,}/gi, '$1[REDACTED]')
      .replace(/\b(?:api[\s_-]?key|token|password|lösenord)\s*[:=]\s*\S+/gi, '[REDACTED SECRET]')
      .replace(/https?:\/\/[^\s)]*(?:token|api_key|key)=[^\s)]*/gi, '[REDACTED URL]')
      .replace(/[\r\n]+/g, ' ')
      .trim();
  }

  /** Record only completed user/assistant turns, never screen images or secrets. */
  remember(question: string, answer: string, now = new Date()): void {
    const safeQuestion = this.scrub(question).slice(0, 600);
    const safeAnswer = this.scrub(answer).slice(0, 900);
    if (!safeQuestion || !safeAnswer || safeQuestion.includes('[REDACTED') || safeAnswer.includes('[REDACTED')) return;
    const date = now.toISOString().slice(0, 10);
    const file = join(this.path, 'Daily', date + '.md');
    if (!existsSync(file)) {
      writeFileSync(file, '---\ntype: buddy-memory\ndate: ' + date + '\n---\n\n# ' + date + '\n\n', 'utf8');
    }
    appendFileSync(file,
      '## ' + now.toISOString().slice(11, 19) + ' · Gespräch\n' +
      '**Student:** ' + safeQuestion + '\n\n' +
      '**Buddy replied (unverified, not demonstrated mastery):** ' + safeAnswer + '\n\n',
      'utf8');
  }

  /** Retrieve a tiny, relevant subset from prior days for better continuity. */
  recall(question: string, maxChars = 1300): string[] {
    const query = new Set(this.scrub(question).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
    if (!query.size) return [];
    const daily = join(this.path, 'Daily');
    let files: string[];
    try { files = readdirSync(daily).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse().slice(0, 35); }
    catch { return []; }
    const candidates: { text: string; score: number }[] = [];
    for (const f of files) {
      const body = readFileSync(join(daily, f), 'utf8').slice(-20000);
      const sections = body.split(/\n## /).slice(1);
      for (const section of sections) {
        const text = section.replace(/^[^\n]*\n/, '').trim().slice(0, 520);
        const words = new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
        let shared = 0;
        for (const word of query) if ([...words].some(candidate => candidate === word || candidate.startsWith(word) || word.startsWith(candidate))) shared += 1;
        if (shared) candidates.push({ text, score: shared });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    const results: string[] = [];
    let used = 0;
    for (const note of candidates.slice(0, 4)) {
      if (used + note.text.length > maxChars) break;
      results.push(note.text);
      used += note.text.length;
    }
    return results;
  }
}
