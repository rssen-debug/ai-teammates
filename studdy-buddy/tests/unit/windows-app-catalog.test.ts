import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findStartMenuApp, shortcutName } from '../../packages/core/src/windows-app-catalog.js';

describe('Windows app discovery (no hardcoded Edge or Chrome launch)', () => {
  it('normalizes common user app names and finds a real Start Menu shortcut', () => {
    const root = mkdtempSync(join(tmpdir(), 'buddy-menu-'));
    try {
      const dir = join(root, 'Google');
      mkdirSync(dir);
      const chrome = join(dir, 'Google Chrome.lnk');
      writeFileSync(chrome, '');
      expect(shortcutName('  GOOGLE  Chrome  ')).toBe('google chrome');
      expect(findStartMenuApp('Google Chrome', [root])).toBe(chrome);
      expect(findStartMenuApp('Chrome', [root])).toBe(chrome);
      expect(findStartMenuApp('Nonexistent', [root])).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects ambiguous application names and unrelated files', () => {
    const root = mkdtempSync(join(tmpdir(), 'buddy-menu-'));
    try {
      writeFileSync(join(root, 'Google Chrome.lnk'), '');
      writeFileSync(join(root, 'Chrome Canary.lnk'), '');
      writeFileSync(join(root, 'Chrome.url'), '');
      expect(findStartMenuApp('Chrome', [root])).toBeNull();
      expect(findStartMenuApp('Google Chrome', [root])).toContain('Google Chrome.lnk');
      expect(findStartMenuApp('', [root])).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
