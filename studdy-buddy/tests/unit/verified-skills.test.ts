import { describe, it, expect } from 'vitest';
import { VerifiedSkillLedger } from '../../apps/desktop/electron/verified-skills.js';

describe('verified Buddy skills (not an IQ metric)', () => {
  it('begins at 1/100; idle events, errors and repetitions do not increase level', () => {
    const values = new Map<string, unknown>();
    const ledger = new VerifiedSkillLedger({
      get: <T>(k: string) => values.get(k) as T | undefined,
      set: (k, v) => { values.set(k, v); },
    });
    expect(ledger.level()).toBe(1);
    expect(ledger.record('launch:chrome', false)).toBe(1);
    expect(ledger.record('launch:chrome', true)).toBe(2);
    expect(ledger.record('launch:chrome', true)).toBe(2);
    expect(ledger.record('danger:arbitrary', true)).toBe(2);
    expect(ledger.record('observe:windows', true)).toBe(3);
    expect(new VerifiedSkillLedger({
      get: <T>(k: string) => values.get(k) as T | undefined,
      set: (k, v) => { values.set(k, v); },
    }).details().verified).toBe(2);
  });
  it('never exceeds 100 and is derived only from unique confirmed scenarios', () => {
    const values = new Map<string, unknown>();
    const ledger = new VerifiedSkillLedger({
      get: <T>(k: string) => values.get(k) as T | undefined,
      set: (k, v) => { values.set(k, v); },
    });
    for (let i = 0; i < 120; i++) ledger.record('launch:app-' + i, true);
    expect(ledger.level()).toBe(100);
    expect(ledger.details().verified).toBe(99);
  });
});
