import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObsidianMemory } from '../../apps/desktop/electron/obsidian-memory.js';

const paths: string[] = [];
function newVault(): ObsidianMemory {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-obsidian-'));
  paths.push(dir);
  return new ObsidianMemory(dir);
}
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('Obsidian memory for the universal agent', () => {
  it('creates a Markdown vault and retrieves a relevant historical exchange', () => {
    const vault = newVault();
    vault.remember('Kan du förklara ARP?', 'ARP mappar IPv4-adresser till MAC-adresser.', new Date('2026-11-06T10:20:30Z'));
    const daily = readFileSync(join(vault.path, 'Daily', '2026-11-06.md'), 'utf8');
    expect(daily).toContain('ARP mappar');
    expect(readFileSync(join(vault.path, 'README.md'), 'utf8')).toContain('Obsidian');
    expect(vault.recall('ARP och MAC-adress').join(' ')).toContain('ARP mappar');
    expect(vault.recall('elektricitet i solen')).toEqual([]);
  });

  it('refuses to record a JWT or API key in readable notes', () => {
    const vault = newVault();
    const fake = 'eyJ' + 'a'.repeat(25) + '.eyJ' + 'b'.repeat(30) + '.' + 'c'.repeat(25);
    vault.remember('Test: ' + fake, 'Hemlig nyckel: ' + fake);
    expect(vault.recall('test')).toEqual([]);
    vault.remember('Testa Kilo?', 'Token: sk_' + 'A'.repeat(30));
    expect(vault.recall('Kilo')).toEqual([]);
  });
});
