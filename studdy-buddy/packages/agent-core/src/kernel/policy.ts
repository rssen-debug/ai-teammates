/**
 * Unified kernel — authorization for the model-facing tool surface.
 *
 * Ported from MAJIN V6 (`src/v6/policy.js`). Grants are read live from the
 * owner's grant store; the kernel never creates or widens a grant, and a
 * revoked lane fails closed on the next call. Meta/discovery tools are always
 * available because they perform no action.
 *
 * `laneForSourceTool` is the original V6 mapping, kept verbatim so a tool name
 * means the same thing it did in MAJIN (a legacy surface that still works).
 */

export const META_TOOLS: ReadonlySet<string> = new Set([
  'driver_status', 'tools_search', 'skills_search', 'skills_read', 'procedures_search', 'procedures_read',
]);

export type KernelLane =
  | 'meta' | 'sys' | 'files' | 'shell' | 'shelltools' | 'net' | 'screen' | 'web' | 'browser'
  | 'research' | 'jobs' | 'flows' | 'github' | 'channels' | 'learn' | 'marketing' | 're'
  | 'trading' | 'power' | 'desktop' | 'computer' | 'majin-service' | 'agent-service'
  | 'media-service' | 'memory-service' | 'host-service' | 'unknown';

/** Original MAJIN lane mapping: a tool prefix decides which grant it needs. */
export function laneForSourceTool(sourceName: string): KernelLane {
  const name = String(sourceName || '');
  if (name === 'majin.self_audit') return 'sys';
  if (name === 'tools.search') return 'meta';
  if (name.startsWith('fs.')) return 'files';
  if (name.startsWith('exec.')) return 'shell';
  if (name.startsWith('shell.')) return 'shelltools';
  if (name.startsWith('sys.')) return name === 'sys.notify' ? 'screen' : 'sys';
  if (name.startsWith('net.')) return 'net';
  if (name.startsWith('screen.')) return 'screen';
  if (name.startsWith('web.')) return 'web';
  if (name.startsWith('browser.')) return 'browser';
  if (name.startsWith('research.')) return 'research';
  if (name.startsWith('jobs.')) return 'jobs';
  if (name.startsWith('flows.')) return 'flows';
  if (name.startsWith('github.')) return 'github';
  if (name.startsWith('channel.')) return 'channels';
  if (name.startsWith('ma.')) return 'learn';
  if (name.startsWith('marketing.')) return 'marketing';
  if (name.startsWith('re.')) return 're';
  if (name.startsWith('trading.')) return 'trading';
  if (name.startsWith('power.')) return 'power';
  if (name.startsWith('control.') || name.startsWith('mouse.') || name.startsWith('desktop.')) return 'desktop';
  if (name.startsWith('computer.') || name.startsWith('cursor.')) return 'computer';
  if (name.startsWith('majin.')) return 'majin-service';
  if (name.startsWith('agent.') || name.startsWith('team.')) return 'agent-service';
  if (name.startsWith('media.')) return 'media-service';
  if (name.startsWith('memory.')) return 'memory-service';
  if (name.startsWith('reset.') || name.startsWith('plugin.')) return 'host-service';
  return 'unknown';
}

export interface CatalogEntry {
  name: string;
  description?: string;
  source?: string | null;
  lane?: string | null;
  [key: string]: unknown;
}

export function requiredLane(entry: CatalogEntry): KernelLane {
  const name = String(entry?.name || '');
  if (META_TOOLS.has(name)) return 'meta';
  if (name === 'documents_extract') return 'files';
  if (name.startsWith('jobs_')) return 'jobs';
  if (name.startsWith('browser_')) return 'browser';
  if (name.startsWith('fs_')) return 'files';
  const source = String(entry?.source || '').trim() || name.replace(/^([^_]+)_/, '$1.');
  return (entry?.lane as KernelLane | null | undefined) ?? laneForSourceTool(source);
}

export function isAuthorized(entry: CatalogEntry, grantedLanes: readonly string[] = []): boolean {
  const lane = requiredLane(entry);
  if (lane === 'meta') return true;
  if (!Array.isArray(grantedLanes)) return false;
  if (grantedLanes.includes(lane)) return true;
  return (lane === 'web' && grantedLanes.includes('research'))
    || (lane === 'shelltools' && grantedLanes.includes('shell'))
    || (lane === 'shell' && grantedLanes.includes('shelltools'));
}

export function fingerprintGrants({ lanes = [], folders = [] }: { lanes?: readonly string[]; folders?: readonly string[] } = {}): string {
  return JSON.stringify({
    lanes: [...new Set(lanes)].sort(),
    folders: [...new Set((folders || []).map((folder) => String(folder).toLowerCase()))].sort(),
  });
}

export interface PublicCatalogEntry {
  name: string;
  description: string;
  source: string | null;
  lane: KernelLane;
}

export function filterCatalog(catalog: CatalogEntry[], lanes: readonly string[], query = '', limit = 30): PublicCatalogEntry[] {
  // Models often type `fs.read` while the driver publishes `fs_read`. Treat the
  // two separators as equivalent instead of pretending the tool is missing.
  const normalize = (value: unknown): string => String(value || '').toLowerCase().replaceAll('_', '.');
  const needle = normalize(query).trim();
  const bounded = Math.max(1, Math.min(50, Number(limit) || 30));
  return catalog
    .filter((entry) => isAuthorized(entry, lanes))
    .filter((entry) => !needle || [entry.name, entry.source, entry.description, entry.lane]
      .some((value) => normalize(value).includes(needle)))
    .slice(0, bounded)
    .map((entry) => ({
      name: entry.name,
      description: String(entry.description || '').slice(0, 180),
      source: entry.source ?? null,
      lane: requiredLane(entry),
    }));
}
