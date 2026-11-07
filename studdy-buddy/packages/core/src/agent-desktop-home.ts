import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** agent-desktop stores an owner-protected private file. Shared or migrated
 * locations may be owned by a different Windows principal. Use a dedicated,
 * per-user local application state root instead of changing someone else's
 * file ACL or deleting existing state. Respect intentional user overrides.
 */
export function configureAgentDesktopHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): { configured: boolean; path: string | null; detail: string } {
  if (env.AGENT_DESKTOP_HOME?.trim()) {
    return { configured: true, path: env.AGENT_DESKTOP_HOME.trim(), detail: 'Explicit native helper state location' };
  }
  if (platform !== 'win32') return { configured: false, path: null, detail: 'No Windows-specific state path required' };
  const local = env.LOCALAPPDATA?.trim();
  if (!local) return { configured: false, path: null, detail: 'LOCALAPPDATA unavailable' };
  const home = join(local, 'Studdy-Buddy', 'agent-desktop');
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    env.AGENT_DESKTOP_HOME = home;
    return { configured: true, path: home, detail: 'Per-user native helper state root' };
  } catch {
    return { configured: false, path: null, detail: 'Could not create per-user agent-desktop state directory' };
  }
}
