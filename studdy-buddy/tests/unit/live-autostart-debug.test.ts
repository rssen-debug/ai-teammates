import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureLoginAutostart } from '../../packages/cli/src/login-autostart.js';
import { DebugJournal } from '@studdy/core';

describe('Windows autostart, local-only debugger', () => {
  it('requires opt-in and writes no secret or absolute executable path', () => {
    const folder = mkdtempSync(join(tmpdir(), 'studdy-autostart-'));
    try {
      const options = { platform: 'win32', folder };
      expect(configureLoginAutostart(null, options).enabled).toBe(false);
      expect(configureLoginAutostart(true, options).enabled).toBe(true);
      const file = readFileSync(join(folder, 'Studdy-Buddy.cmd'), 'utf8');
      expect(file).toContain('cmd.exe /k studdy');
      expect(file).not.toContain('TOKEN');
      expect(configureLoginAutostart(false, options).enabled).toBe(false);
      expect(existsSync(join(folder, 'Studdy-Buddy.cmd'))).toBe(false);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
  it('rejects non-Windows autostart requests', () => {
    expect(configureLoginAutostart(true, { platform: 'linux', folder: '/tmp' }).ok).toBe(false);
  });
  it('summarizes recorded errors but does not expose JWTs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studdy-debug-'));
    try {
      const journal = new DebugJournal(dir);
      journal.record('observer', 'HTTP 502 failure eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJmb28iOiJiYXIiLCJmb29iYXIiOiJiYXoifQ.abcDEFghiJKLmnopQRSTUVWX', 'warn');
      const report = journal.summary();
      expect(report.count).toBe(1);
      expect(report.recent[0]).toContain('HTTP 502');
      expect(report.recent[0]).not.toContain('eyJhbGci');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
