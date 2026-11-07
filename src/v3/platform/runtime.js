export const V3_MIN_NODE_VERSION = [22, 0, 0].join('.');

/** The repository's installed production dependencies require Node >=22. */
export function isV3NodeSupported(version = process.versions.node) {
  const match = String(version).trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return false;
  return Number(match[1]) >= 22;
}

export function assertV3NodeSupported(version = process.versions.node) {
  if (!isV3NodeSupported(version)) {
    throw new Error(`MAJIN V3 requires Node.js >=${V3_MIN_NODE_VERSION}; detected ${version || 'unknown'}.`);
  }
}
