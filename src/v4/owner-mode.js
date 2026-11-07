/**
 * MAJIN V4 — Owner Mode.
 *
 * Host tools used to be behind `MAJIN_V4_HOST_TOOLS=1`, which means the owner
 * had to edit an environment variable and restart the host to give their own
 * phone access to their own computer. That is not a product.
 *
 * Owner Mode is the same decision, made once, from the phone, written down:
 *
 *   - a persisted grant in `<data>/v4/owner-mode.json` (0600)
 *   - per-lane, so "files yes, desktop no" is expressible
 *   - an explicit folder allowlist for the filesystem lane; without one the
 *     files lane stays off, because "all disks" is not a default
 *   - revocable from the phone in one tap, effective on the next call
 *   - every grant and revoke is written to the audit log with a timestamp
 *
 * The env var still works and is documented as the headless/installer path. It
 * can force tools ON; it can never override a revocation, because a revoke the
 * owner made from the phone must win over a stale config line.
 *
 * What this is not: it is not an OS-level sandbox. A granted filesystem lane
 * reaches whatever the MAJIN process can reach; the allowlist is a guardrail
 * around the tool, not an ACL. SECURITY.md says so.
 */
import fs from 'node:fs';
import path from 'node:path';

export const OWNER_MODE_SCHEMA = 'majin.v4.owner-mode/v1';

/** Lanes the owner can grant. `browser` is the runtime, not a V1 module name. */
export const GRANTABLE_LANES = Object.freeze([
  'files', 'shell', 'shelltools', 'sys', 'power', 'web', 'research', 'jobs', 'flows', 'github',
  'audit', 'learn', 'marketing', 're', 'trading', 'net', 'agent', 'channels',
  'desktop', 'screen', 'computer', 'browser', 'mcp',
]);

/** Lanes whose risk justifies a confirmation that names the consequence. */
export const SENSITIVE_LANES = Object.freeze(['shell', 'shelltools', 'power', 'desktop', 'screen', 'computer', 'agent', 'mcp', 'channels']);

export class OwnerModeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'OwnerModeError';
    this.code = code;
    this.status = status;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Expand ~ and normalise a folder the owner typed or picked. */
export function normaliseFolder(raw, { allowRoot = false } = {}) {
  const value = String(raw ?? '').trim();
  if (!value) throw new OwnerModeError('INVALID_FOLDER', 'a folder path is required');
  if (value.length > 400) throw new OwnerModeError('INVALID_FOLDER', 'the folder path is too long');
  if (value.includes('\0')) throw new OwnerModeError('INVALID_FOLDER', 'the folder path contains a null byte');
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const expanded = value === '~' ? home : value.replace(/^~(?=[\\/]|$)/, home);
  // A drive/filesystem root is never an acceptable grant. Checked BEFORE resolve,
  // because `path.resolve('C:\\')` on Linux yields a relative-looking path and
  // would pass. The grant file can travel between machines, so the guard must
  // not depend on where it runs.
  if (!allowRoot && isFilesystemRoot(expanded)) {
    throw new OwnerModeError('INVALID_FOLDER', 'granting an entire drive is not allowed; pick a folder inside it');
  }
  const resolved = path.resolve(expanded);
  if (!allowRoot && resolved === path.parse(resolved).root) {
    throw new OwnerModeError('INVALID_FOLDER', 'granting an entire drive is not allowed; pick a folder inside it');
  }
  return resolved;
}

/** True for `/`, `\\`, `C:\\`, `C:/`, and any single-letter drive alone. */
export function isFilesystemRoot(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return false;
  if (/^([a-zA-Z]:)?[\\/]*$/.test(raw)) return true;
  if (/^[a-zA-Z]:$/.test(raw)) return true;
  return false;
}

/**
 * Normalise an owner-supplied browser write grant to one exact origin.
 * A page URL may be pasted for convenience, but only its scheme/host/port is
 * stored. URL credentials are refused because they can visually disguise the
 * real host and must never become a persistent permission.
 */
export function normaliseBrowserOrigin(raw, { allowAll = false } = {}) {
  const value = String(raw ?? '').trim();
  if (allowAll && value === '*') return '*';
  if (!value) throw new OwnerModeError('INVALID_BROWSER_ORIGIN', 'a browser origin or URL is required');
  if (value.length > 2048) throw new OwnerModeError('INVALID_BROWSER_ORIGIN', 'the browser origin is too long');
  if (value.includes('\0')) throw new OwnerModeError('INVALID_BROWSER_ORIGIN', 'the browser origin contains a null byte');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new OwnerModeError('INVALID_BROWSER_ORIGIN', 'the browser origin must be a valid http(s) origin or URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new OwnerModeError('INVALID_BROWSER_ORIGIN', 'only http(s) browser origins can be granted');
  }
  if (url.username || url.password) {
    throw new OwnerModeError('INVALID_BROWSER_ORIGIN', 'browser origins with embedded credentials are not allowed');
  }
  return url.origin;
}

function normaliseBrowserOrigins(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(normaliseBrowserOrigin))].sort();
}

function persistedBrowserOrigins(raw) {
  if (!raw || raw.schema !== OWNER_MODE_SCHEMA) return [];
  const origins = [];
  for (const value of Array.isArray(raw.browserOrigins) ? raw.browserOrigins : []) {
    try {
      origins.push(normaliseBrowserOrigin(value, { allowAll: true }));
    } catch {
      // A corrupt or credential-bearing persisted entry is ignored rather
      // than discarding every valid owner grant in the same file.
    }
  }
  return [...new Set(origins)].sort();
}

export class OwnerMode {
  /**
   * @param {object} o
   * @param {string} o.file           where the grant lives
   * @param {string[]} [o.forceLanes] env-forced lanes (installer path)
   * @param {Function} [o.now]
   */
  constructor({ file, forceLanes = [], now = () => Date.now() } = {}) {
    this.file = file;
    this.forceLanes = forceLanes;
    this.now = now;
    this.state = this.#load();
  }

  #load() {
    const raw = readJson(this.file);
    if (!raw || raw.schema !== OWNER_MODE_SCHEMA) {
      return { schema: OWNER_MODE_SCHEMA, version: 1, lanes: [], folders: [], browserOrigins: [], grantedAt: null, revokedAt: null, history: [] };
    }
    const browserOrigins = persistedBrowserOrigins(raw);
    return {
      schema: OWNER_MODE_SCHEMA,
      version: raw.version || 1,
      lanes: Array.isArray(raw.lanes) ? raw.lanes.filter((l) => GRANTABLE_LANES.includes(l)) : [],
      folders: Array.isArray(raw.folders) ? raw.folders.filter((f) => typeof f === 'string') : [],
      browserOrigins,
      grantedAt: raw.grantedAt || null,
      revokedAt: raw.revokedAt || null,
      history: Array.isArray(raw.history) ? raw.history.slice(-50) : [],
    };
  }

  #save(entry) {
    if (entry) {
      this.state.history.push({ at: new Date(this.now()).toISOString(), ...entry });
      if (this.state.history.length > 50) this.state.history = this.state.history.slice(-50);
    }
    writePrivate(this.file, this.state);
  }

  #reloadBrowserOrigins() {
    // Browser origins are intentionally dynamic: a grant or revocation from
    // another owner CLI process must be visible to an already-running host
    // and must not be overwritten by that host's next unrelated save.
    this.state.browserOrigins = persistedBrowserOrigins(readJson(this.file));
  }

  /** Effective lanes: what the owner granted, plus anything the installer forced. */
  activeLanes() {
    const set = new Set(this.state.lanes);
    for (const lane of this.forceLanes) if (GRANTABLE_LANES.includes(lane)) set.add(lane);
    // The filesystem lane is meaningless without at least one folder.
    if (set.has('files') && this.state.folders.length === 0) set.delete('files');
    return [...set];
  }

  enabled() {
    return this.activeLanes().length > 0;
  }

  folders() {
    return [...this.state.folders];
  }

  /** Exact origins where the owner has authorized browser writes/submits. */
  browserOrigins() {
    this.#reloadBrowserOrigins();
    return [...this.state.browserOrigins];
  }

  /** True when a path is inside one of the granted folders. */
  allowsPath(candidate) {
    let target;
    try {
      target = path.resolve(String(candidate));
    } catch {
      return false;
    }
    return this.state.folders.some((folder) => {
      const root = path.resolve(folder);
      const rel = path.relative(root, target);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
  }

  /** Grant lanes, folders and/or exact browser write origins. Returns the new state. */
  grant({ lanes = [], folders = [], browserOrigins = [], reason = null, fullAccess = false } = {}) {
    const wanted = [...new Set(lanes)];
    for (const lane of wanted) {
      if (!GRANTABLE_LANES.includes(lane)) throw new OwnerModeError('UNKNOWN_LANE', `unknown lane: ${lane}`);
    }
    const addedFolders = folders.map(value => normaliseFolder(value, { allowRoot: fullAccess === true }));
    const addedBrowserOrigins = fullAccess === true ? ['*'] : normaliseBrowserOrigins(browserOrigins);
    this.#reloadBrowserOrigins();

    const nextLanes = new Set(this.state.lanes);
    for (const lane of wanted) nextLanes.add(lane);

    const nextFolders = new Set(this.state.folders);
    for (const f of addedFolders) nextFolders.add(f);

    const nextBrowserOrigins = new Set(this.state.browserOrigins);
    for (const origin of addedBrowserOrigins) nextBrowserOrigins.add(origin);

    // Granting a folder implies the files lane, and granting a browser write
    // origin implies the browser runtime lane: that is what the owner meant.
    if (addedFolders.length) nextLanes.add('files');
    if (addedBrowserOrigins.length) nextLanes.add('browser');

    this.state.lanes = [...nextLanes];
    this.state.folders = [...nextFolders];
    this.state.browserOrigins = [...nextBrowserOrigins].sort();
    this.state.grantedAt = new Date(this.now()).toISOString();
    this.state.revokedAt = null;
    this.#save({ action: 'grant', lanes: wanted, folders: addedFolders, browserOrigins: addedBrowserOrigins, reason });
    return this.view();
  }

  /** Grant one or more exact browser write origins without touching other lanes/folders. */
  grantBrowserOrigins(origins, reason = null) {
    return this.grant({ browserOrigins: Array.isArray(origins) ? origins : [origins], reason });
  }

  /** Revoke specific lanes/folders/browser origins, or everything with no argument. Effective at once. */
  revoke({ lanes = null, folders = null, browserOrigins = null, reason = null } = {}) {
    if (!lanes && !folders && !browserOrigins) {
      this.state.lanes = [];
      this.state.folders = [];
      this.state.browserOrigins = [];
      this.state.revokedAt = new Date(this.now()).toISOString();
      this.#save({ action: 'revoke-all', reason });
      return this.view();
    }
    const removedBrowserOrigins = Array.isArray(browserOrigins) ? normaliseBrowserOrigins(browserOrigins) : null;
    this.#reloadBrowserOrigins();
    if (Array.isArray(lanes)) this.state.lanes = this.state.lanes.filter((l) => !lanes.includes(l));
    if (Array.isArray(folders)) {
      const drop = new Set(folders.map((f) => path.resolve(f)));
      this.state.folders = this.state.folders.filter((f) => !drop.has(path.resolve(f)));
    }
    if (removedBrowserOrigins) {
      const drop = new Set(removedBrowserOrigins);
      this.state.browserOrigins = this.state.browserOrigins.filter((origin) => !drop.has(origin));
    }
    if (Array.isArray(lanes) && lanes.includes('browser')) this.state.browserOrigins = [];
    if (this.state.folders.length === 0) this.state.lanes = this.state.lanes.filter((l) => l !== 'files');
    this.state.revokedAt = new Date(this.now()).toISOString();
    this.#save({ action: 'revoke', lanes, folders, browserOrigins: removedBrowserOrigins, reason });
    return this.view();
  }

  /** Revoke one or more browser write origins, or all of them when omitted. */
  revokeBrowserOrigins(origins = null, reason = null) {
    if (origins == null) {
      this.#reloadBrowserOrigins();
      const removed = [...this.state.browserOrigins];
      this.state.browserOrigins = [];
      this.state.revokedAt = new Date(this.now()).toISOString();
      this.#save({ action: 'revoke-browser-origins', browserOrigins: removed, reason });
      return this.view();
    }
    return this.revoke({ browserOrigins: Array.isArray(origins) ? origins : [origins], reason });
  }

  /** What the phone is shown. */
  view() {
    this.#reloadBrowserOrigins();
    const active = this.activeLanes();
    return {
      enabled: active.length > 0,
      lanes: active,
      granted: this.state.lanes,
      forced: this.forceLanes,
      folders: this.state.folders,
      browserOrigins: [...this.state.browserOrigins],
      effectiveBrowserOrigins: active.includes('browser') ? [...this.state.browserOrigins] : [],
      sensitive: active.filter((l) => SENSITIVE_LANES.includes(l)),
      grantable: GRANTABLE_LANES,
      grantedAt: this.state.grantedAt,
      revokedAt: this.state.revokedAt,
      history: this.state.history.slice(-10),
      note: 'A grant reaches whatever the MAJIN process can reach. It is a guardrail, not an OS sandbox.',
    };
  }
}
