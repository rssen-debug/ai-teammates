/**
 * Evidence-backed capability ledger, NOT an IQ or model-intelligence score.
 * Each distinct, verified operation is counted at most once, persisted locally.
 * Idle time, replies without tool proof, and repeated operations add nothing.
 * 1/100 is the starting level; 100 requires 99 distinct verified scenarios.
 */
export interface SkillStore {
  get<T>(key: string): T | null | undefined;
  set(key: string, value: unknown): void;
}

const KEY = 'buddy.verified-skills.v1';
const PREFIXES = ['observe:', 'launch:', 'screen:', 'gmail:', 'model:', 'memory:'];
const SAFE_KEY = /^[a-z0-9:._-]{1,70}$/;

export class VerifiedSkillLedger {
  constructor(private readonly store: SkillStore) {}
  keys(): string[] {
    const values = this.store.get<unknown>(KEY);
    if (!Array.isArray(values)) return [];
    return Array.from(new Set(values.filter(
      (x): x is string => typeof x === 'string' && SAFE_KEY.test(x) && PREFIXES.some(prefix => x.startsWith(prefix)),
    ))).slice(0, 99);
  }
  level(): number { return 1 + this.keys().length; }
  record(kind: string, evidenceConfirmed: boolean): number {
    if (!evidenceConfirmed || !SAFE_KEY.test(kind) || !PREFIXES.some(prefix => kind.startsWith(prefix))) {
      return this.level();
    }
    const keys = this.keys();
    if (!keys.includes(kind) && keys.length < 99) this.store.set(KEY, [...keys, kind]);
    return this.level();
  }
  details(): { level: number; verified: number; description: string } {
    const keys = this.keys();
    return {
      level: 1 + keys.length,
      verified: keys.length,
      description: keys.length + ' unika verktygsfall verifierade lokalt. Nivån mäter testad funktion, inte AI-IQ.',
    };
  }
}
