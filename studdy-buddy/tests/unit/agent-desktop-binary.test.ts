import { describe, it, expect } from 'vitest';
import { resolveAgentDesktopBinary } from '@studdy/core';
import { join } from 'node:path';

describe('native binary resolution', () => {
  it('finds the real Linux helper instead of assuming PATH', () => {
    const target = join('/opt/cli', 'node_modules', 'agent-desktop', 'bin', 'agent-desktop-linux-x64');
    expect(resolveAgentDesktopBinary({ platform: 'linux', arch: 'x64', moduleDir: '/opt/cli', cwd: '/unrelated', exists: p => p === target })).toBe(target);
  });
  it('prefers env override when it exists', () => {
    expect(resolveAgentDesktopBinary({ platform: 'win32', isPackaged: false, env: { STUDDY_AGENT_DESKTOP_BINARY: 'C:/tool.exe' } as NodeJS.ProcessEnv, exists: () => true })).toBe('C:/tool.exe');
  });
  it('does not invent an archived Electron resources path', () => {
    const resolved = resolveAgentDesktopBinary({ platform: 'win32', isPackaged: true, resourcesPath: 'C:/app/resources', cwd: '/none', moduleDir: '/none', exists: () => false });
    expect(resolved).toBe('agent-desktop');
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
