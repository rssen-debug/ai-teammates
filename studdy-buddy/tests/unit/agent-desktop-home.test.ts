import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureAgentDesktopHome } from '../../packages/core/src/agent-desktop-home.js';

describe('Windows agent-desktop private state isolation', () => {
  it('uses local per-user folder, not shared or foreign-owned state', () => {
    const dir=mkdtempSync(join(tmpdir(),'studdy-native-home-'));
    try {
      const env:NodeJS.ProcessEnv={LOCALAPPDATA:dir};
      const result=configureAgentDesktopHome(env,'win32');
      expect(result.configured).toBe(true);
      expect(result.path).toBe(join(dir,'Studdy-Buddy','agent-desktop'));
      expect(env.AGENT_DESKTOP_HOME).toBe(result.path);
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it('never overwrites an explicit user-provided location', () => {
    const env:NodeJS.ProcessEnv={AGENT_DESKTOP_HOME:'D:\\user-choice'};
    expect(configureAgentDesktopHome(env,'win32').path).toBe('D:\\user-choice');
    expect(env.AGENT_DESKTOP_HOME).toBe('D:\\user-choice');
  });
  it('does not change Linux environments or fake OS permissions', () => {
    const env:NodeJS.ProcessEnv={LOCALAPPDATA:'D:\\Windows'};
    expect(configureAgentDesktopHome(env,'linux').configured).toBe(false);
    expect(env.AGENT_DESKTOP_HOME).toBeUndefined();
  });
});
