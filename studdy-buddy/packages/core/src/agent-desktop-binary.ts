import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BinaryResolutionOptions {
  platform?: string; arch?: string; moduleDir?: string; cwd?: string;
  env?: NodeJS.ProcessEnv; exists?: (path: string) => boolean;
  /** Legacy Electron options are ignored: the CLI is never packaged in asar. */
  isPackaged?: boolean; resourcesPath?: string;
}
/** Resolve the installed native helper from source, dist, or a global npm install. */
export function resolveAgentDesktopBinary(options: BinaryResolutionOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const override = env.STUDDY_AGENT_DESKTOP_BINARY?.trim();
  if (override) return override;
  const arch = options.arch ?? process.arch;
  const binary = platform === 'win32' && arch === 'x64' ? 'agent-desktop-win32-x64.exe'
    : platform === 'linux' && arch === 'x64' ? 'agent-desktop-linux-x64'
    : platform === 'darwin' ? `agent-desktop-darwin-${arch === 'arm64' ? 'arm64' : 'x64'}` : null;
  if (!binary) return 'agent-desktop';
  const exists = options.exists ?? existsSync;
  const roots = [options.moduleDir ?? dirname(fileURLToPath(import.meta.url)), options.cwd ?? process.cwd()];
  for (const root of roots) {
    let dir = root;
    for (let i = 0; i < 7; i++) {
      const candidate = join(dir, 'node_modules', 'agent-desktop', 'bin', binary);
      if (exists(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return 'agent-desktop';
}
