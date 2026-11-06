import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface BinaryResolutionInput {
  platform: string;
  arch?: string;
  isPackaged: boolean;
  resourcesPath?: string;
  cwd?: string;
  appPath?: string;
  moduleDir?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}

/** Resolve the native agent-desktop executable instead of an npm `.cmd` shim. */
export function resolveAgentDesktopBinary(input: BinaryResolutionInput): string {
  const exists = input.exists ?? existsSync;
  if (input.platform !== 'win32') return 'agent-desktop';
  const override = input.env?.STUDDY_AGENT_DESKTOP_BINARY;
  if (override && exists(override)) return override;
  if (input.isPackaged && input.resourcesPath) {
    const bundled = join(input.resourcesPath, 'bin', 'agent-desktop.exe');
    if (exists(bundled)) return bundled;
  }
  const arch = input.arch ?? process.arch;
  const nativeName = arch === 'arm64' ? 'agent-desktop-win32-arm64.exe' : 'agent-desktop-win32-x64.exe';
  const candidates = [
    input.cwd ? join(input.cwd, 'node_modules', 'agent-desktop', 'bin', nativeName) : null,
    input.appPath ? join(input.appPath, '..', '..', '..', 'node_modules', 'agent-desktop', 'bin', nativeName) : null,
  ].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) if (exists(candidate)) return candidate;
  let dir = input.moduleDir;
  while (dir) {
    const candidate = join(dir, 'node_modules', 'agent-desktop', 'bin', nativeName);
    if (exists(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'agent-desktop';
}
