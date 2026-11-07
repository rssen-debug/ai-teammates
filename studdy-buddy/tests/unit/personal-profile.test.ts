import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObsidianMemory } from '../../packages/core/src/obsidian-memory.js';
import { modelRequest } from '../../packages/cli/src/interactive.js';

describe('Personal memory and natural model selection', () => {
  it('persists user-approved facts and rejects secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studdy-profile-'));
    try {
      const memory = new ObsidianMemory(dir);
      expect(memory.rememberProfile('Jag föredrar korta svar')).toBe(true);
      expect(memory.rememberProfile('Jag föredrar korta svar')).toBe(true);
      expect(memory.rememberProfile('api_key=sk-12345678901234567890')).toBe(false);
      const reopened = new ObsidianMemory(dir);
      expect(reopened.profileFacts()).toEqual(['Jag föredrar korta svar']);
      expect(readFileSync(join(dir, 'Obsidian-Vault', 'Profile.md'), 'utf8')).not.toContain('sk-123456');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('recognizes explicit model changes but never turns general chat into model actions', () => {
    expect(modelRequest('byt modell till kilo-auto/free')).toBe('kilo-auto/free');
    expect(modelRequest('använd modellen deepseek-v4-flash')).toBe('deepseek-v4-flash');
    expect(modelRequest('byt till min webbläsare')).toBeNull();
    expect(modelRequest('kan du förklara modeller?')).toBeNull();
  });
});
