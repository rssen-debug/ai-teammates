/**
 * V6 authorization for the OpenCode <-> MAJIN tool surface.
 *
 * Grants are read live from the owner's existing owner-mode file. V6 never
 * creates or widens a grant, and a revoked lane fails closed on the next call.
 * Meta/discovery tools are always available because they perform no action.
 */
import { laneForSourceTool } from '../v5/host-bridge.js';

export const META_TOOLS = new Set([
  'driver_status', 'tools_search', 'skills_search', 'skills_read', 'procedures_search', 'procedures_read',
]);

export function requiredLane(entry) {
  const name = String(entry?.name || '');
  if (META_TOOLS.has(name)) return 'meta';
  if (name === 'documents_extract') return 'files';
  if (name.startsWith('jobs_')) return 'jobs';
  if (name.startsWith('browser_')) return 'browser';
  if (name.startsWith('fs_')) return 'files';
  const source = String(entry?.source || '').trim() || name.replace(/^([^_]+)_/, '$1.');
  return String(entry?.lane || laneForSourceTool(source));
}

export function isAuthorized(entry, grantedLanes = []) {
  const lane = requiredLane(entry);
  if (lane === 'meta') return true;
  if (!Array.isArray(grantedLanes)) return false;
  if (grantedLanes.includes(lane)) return true;
  return (lane === 'web' && grantedLanes.includes('research'))
    || (lane === 'shelltools' && grantedLanes.includes('shell'))
    || (lane === 'shell' && grantedLanes.includes('shelltools'));
}

export function fingerprintGrants({ lanes = [], folders = [] } = {}) {
  return JSON.stringify({
    lanes: [...new Set(lanes)].sort(),
    folders: [...new Set((folders || []).map((folder) => String(folder).toLowerCase()))].sort(),
  });
}

export function filterCatalog(catalog, lanes, query = '', limit = 30) {
  // Models often type `fs.read` while the driver publishes `fs_read`. Treat the
  // two separators as equivalent instead of pretending the tool is missing.
  const normalize = (value) => String(value || '').toLowerCase().replaceAll('_', '.');
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
      source: entry.source || null,
      lane: requiredLane(entry),
    }));
}
