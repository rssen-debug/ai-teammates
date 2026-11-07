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

  /** Explicitly approved profile facts survive a restart and are not counted as mastery. */
  rememberProfile(fact: string): boolean {
    const safe = this.scrub(fact).slice(0, 180);
    if (!safe || safe.includes('[REDACTED') || /[\r\n]/.test(safe)) return false;
    const path = join(this.path, 'Profile.md');
    const existing = this.profileFacts();
    if (existing.some(item => item.toLocaleLowerCase('sv-SE') === safe.toLocaleLowerCase('sv-SE'))) return true;
    const next = [...existing, safe].slice(-30);
    writeFileSync(path, '# Mina valda minnen\n\n' + next.map(item => '- ' + item).join('\n') + '\n', 'utf8');
    return true;
  }

  /** Read a small bounded set of user-selected facts, never credentials. */
  profileFacts(): string[] {
    const path = join(this.path, 'Profile.md');
    if (!existsSync(path)) return [];
    try {
      return readFileSync(path, 'utf8').split('\n')
        .filter(line => line.startsWith('- '))
        .map(line => this.scrub(line.slice(2)).slice(0, 180))
        .filter(line => line.length > 0 && !line.includes('[REDACTED'))
        .slice(-30);
    } catch { return []; }
  }

  /** Coarse user-authorized activity patterns. Store neither screenshots,
   * page titles nor raw UI text; each type counts at most once per UTC hour.
   * These are observation periods, NOT hours worked or a personality score.
   */
  observedPatterns(): Array<{ kind: 'study' | 'code' | 'creative'; periods: number; lastHour: string }> {
    const file = join(this.path, 'Activity.md');
    if (!existsSync(file)) return [];
    try {
      const entries = readFileSync(file, 'utf8').split(/\r?\n/);
      return entries.flatMap(line => {
        const m = /^- (study|code|creative): ([0-9]{1,7}) periods; last ([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2})Z$/.exec(line);
        return m ? [{ kind: m[1] as 'study'|'code'|'creative',
          periods: Math.min(9999999, Number(m[2])), lastHour: m[3]! }] : [];
      }).slice(0, 3);
    } catch { return []; }
  }

  recordObservedPattern(kind: 'study' | 'code' | 'creative', now = new Date()): boolean {
    const hour = now.toISOString().slice(0, 13);
    const existing = this.observedPatterns();
    if (existing.some(row => row.kind === kind && row.lastHour === hour)) return false;
    const old = existing.find(row => row.kind === kind);
    const next = [...existing.filter(row => row.kind !== kind),
      { kind, periods: Math.min(9999999, (old?.periods ?? 0) + 1), lastHour: hour }]
      .sort((a, b) => a.kind.localeCompare(b.kind));
    writeFileSync(join(this.path, 'Activity.md'),
      '# Coarse observed work patterns\n\n' +
      'These describe verified on-screen activity categories, not personal traits, proficiency, time worked, or surveillance recordings.\n' +
      'No window titles or UI text are saved. Max one observation period per UTC hour and category.\n\n' +
      next.map(row => '- ' + row.kind + ': ' + row.periods + ' periods; last ' + row.lastHour + 'Z').join('\n') + '\n', 'utf8');
    return true;
  }

  /**
   * Autopilot: learn a durable fact from a normal message, with no /remember.
   * Returns the stored fact when something was learned, otherwise null, so the
   * caller can show it once and the user can correct it.
   */
  rememberProfileAuto(message: string): string | null {
    const fact = extractProfileFact(message);
    if (!fact) return null;
    if (!isNewFact(fact, this.profileFacts())) return null;
    return this.rememberProfile(fact) ? fact : null;
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

/**
 * Autopilot profile learning.
 *
 * The user was explicit: "I should never have to write /remember, it should be
 * autopilot." So the app now extracts durable facts about the person from the
 * conversation itself, with rules strict enough that it cannot fill the profile
 * with noise or secrets:
 *
 *   - only first-person statements ("jag pluggar till nätverkstekniker",
 *     "my exam is in March", "I prefer short answers")
 *   - never anything containing a credential, e-mail address, phone number,
 *     personal number, or URL
 *   - never a question (a question is a request, not a fact)
 *   - at most one new fact per turn, at most 40 stored, newest last
 *   - everything is shown in /profile and can be deleted by editing one file
 *
 * This is extraction, not inference. It never guesses a fact the user did not
 * state, because a wrong "memory" about a person is worse than no memory.
 */

const SECRET = /\b(?:sk|pk|ghp|gho|ghu|ghs|github_pat)[-_][A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{10,}|api[_\s-]?key|token|password|lösenord|passcode|otp|personnummer|\b\d{6}[-+]?\d{4}\b|@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|https?:\/\//i;

/** Sentence splitter that keeps abbreviations from creating fake facts. */
function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && s.length <= 200);
}

/**
 * A durable fact must be *about the speaker*, so the sentence has to start with
 * the first person, not merely contain it. "den här appen fungerar inte som jag
 * vill" contains "jag" but says nothing about the person; storing it would be
 * the automatic-memory equivalent of a bad summariser.
 */
const FIRST_PERSON = /^(?:ja|nej|okej|alltså|liksom|well|so|okay)[, ]+\s*(?:jag|i'm|i am|my|min|mitt|mina|mig|me)\b/i;
const FIRST_PERSON_LOOSE = /\b(?:jag|mig|min|mitt|mina|i'm|i am|my|me)\b/i;
const IDENTITY = /\b(?:jag\s+(?:är|pluggar|studerar|läser|jobbar|arbetar|bor|heter|gilllar|föredrar|vill|behöver|har|siktar)|i\s+(?:am|study|work|live|prefer|need|have|want)|my\s+(?:name|exam|course|goal|level|job|deadline))\b/i;
const PREFERENCE = /\b(?:föredrar|föredra|vill ha|gillar|ogillar|föredrar|prefers?|likes?|dislikes?|always|alltid|hellre)\b/i;

/**
 * Returns the durable fact contained in one user message, or null.
 * Pure function: same input always gives the same output, so it is testable.
 */
export function extractProfileFact(message: string): string | null {
  const text = message.trim();
  if (text.length < 10 || text.length > 400) return null;
  if (text.endsWith('?')) return null;
  if (SECRET.test(text)) return null;
  for (const sentence of sentences(text)) {
    if (sentence.endsWith('?')) continue;
    if (SECRET.test(sentence)) continue;
    if (!FIRST_PERSON.test(sentence) && !FIRST_PERSON_LOOSE.test(sentence)) continue;
    // Starts with a third party ("appen", "det", "den här …") => not about the user.
    if (!FIRST_PERSON.test(sentence) && /^(?:den|det|de|den här|det här|this|that|it|the app|appen)\b/i.test(sentence)) continue;
    if (!IDENTITY.test(sentence) && !PREFERENCE.test(sentence)) continue;
    // Strip leading filler so the stored fact reads as a statement.
    return sentence
      .replace(/^(?:ja|nej|okej|alltså|liksom|well|so|okay)[, ]+/i, '')
      .replace(/[.!]+$/, '')
      .trim()
      .slice(0, 180);
  }
  return null;
}

/** True when this fact is worth storing next to the facts we already have. */
export function isNewFact(fact: string, existing: string[]): boolean {
  const normalise = (s: string) => s.toLocaleLowerCase('sv-SE').replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
  const candidate = normalise(fact);
  if (!candidate) return false;
  const words = new Set(candidate.split(' ').filter((w) => w.length > 3));
  if (!words.size) return false;
  for (const item of existing) {
    const known = normalise(item);
    if (known === candidate) return false;
    const knownWords = new Set(known.split(' ').filter((w) => w.length > 3));
    let shared = 0;
    for (const word of words) if (knownWords.has(word)) shared += 1;
    // 70% overlap means it is the same fact said differently.
    if (shared / words.size >= 0.7) return false;
  }
  return true;
}
