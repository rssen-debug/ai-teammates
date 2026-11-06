import { describe, it, expect } from 'vitest';
import { resolveAgentDesktopBinary } from '@studdy/core';
import { join } from 'node:path';

describe('native binary resolution', () => {
  it('returns plain command on non-Windows', () => {
    expect(resolveAgentDesktopBinary({ platform: 'linux', isPackaged: false })).toBe('agent-desktop');
  });
  it('prefers env override when it exists', () => {
    expect(resolveAgentDesktopBinary({ platform: 'win32', isPackaged: false, env: { STUDDY_AGENT_DESKTOP_BINARY: 'C:/tool.exe' }, exists: () => true })).toBe('C:/tool.exe');
  });
  it('uses packaged resources when packaged', () => {
    const resolved = resolveAgentDesktopBinary({ platform: 'win32', isPackaged: true, resourcesPath: 'C:/app/resources', exists: (p) => p.includes('resources') });
    expect(resolved).toContain('agent-desktop.exe');
  });
  it('finds node_modules native x64 binary', () => {
    const target = join('C:/repo', 'node_modules', 'agent-desktop', 'bin', 'agent-desktop-win32-x64.exe');
    expect(resolveAgentDesktopBinary({ platform: 'win32', arch: 'x64', isPackaged: false, cwd: 'C:/repo', exists: (p) => p === target })).toBe(target);
  });
  it('walks up from installed CLI bundle directory', () => {
    const moduleDir = join('/opt/lib/node_modules', 'studdy-buddy');
    const target = join(moduleDir, 'node_modules', 'agent-desktop', 'bin', 'agent-desktop-win32-x64.exe');
    expect(resolveAgentDesktopBinary({ platform: 'win32', isPackaged: false, moduleDir, exists: (p) => p === target })).toBe(target);
  });
});
