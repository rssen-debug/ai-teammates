/**
 * MAJIN V4 — where the filesystem lane may touch disk.
 *
 * Owner Mode has always *recorded* granted folders (`owner-mode.json`), but
 * nothing enforced or advertised them: the V1 `fs.*` tools resolved any path
 * they were given, and the model was never told which folders existed. The
 * result was the reported behaviour — MAJIN could not find a document the owner
 * had explicitly granted, and the grant was decoration.
 *
 * This module is the single answer to "may this path be touched?":
 *
 *   allowed  = the V4 workspace, plus every folder the owner granted
 *   relative paths  resolve against the workspace
 *   absolute paths  must land inside the workspace or a granted folder
 *
 * It is used twice, on purpose:
 *   1. the adapter refuses a call that reaches outside BEFORE it runs;
 *   2. the same list is put in the system prompt, so the model knows where to
 *      look instead of guessing the workspace.
 *
 * Symlinks are resolved (`realpath`) when the target exists, so a link inside a
 * granted folder cannot be used to step outside it.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Normalise a folder list: absolute, resolved, de-duplicated. */
export function normaliseRoots(folders = []) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(folders) ? folders : []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    let resolved;
    try {
      resolved = path.resolve(raw);
    } catch {
      continue;
    }
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

/** Resolve an existing path to its real location; missing paths resolve lexically. */
function realish(target) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target);
  } catch {
    // A path that does not exist yet (mkdir, write) is judged lexically, but its
    // deepest existing ancestor is resolved so a symlinked parent cannot lie.
    let dir = path.dirname(target);
    for (let i = 0; i < 40; i += 1) {
      try {
        // Use the same resolver as the existing-target branch. On Windows the
        // native resolver expands 8.3 names (RUNNER~1), while the JS resolver
        // may retain them; mixing them can falsely deny a new workspace file.
        const real = fs.realpathSync.native ? fs.realpathSync.native(dir) : fs.realpathSync(dir);
        return path.join(real, path.relative(dir, target));
      } catch {
        const parent = path.dirname(dir);
        if (parent === dir) return target;
        dir = parent;
      }
    }
    return target;
  }
}

export function isInside(target, root) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Check one path against the allowed roots.
 * Returns `{ allowed, abs, root, reason }` — never throws.
 */
export function checkPath(candidate, { workspace, folders = [] } = {}) {
  if (candidate == null || String(candidate).trim() === '') {
    return { allowed: true, abs: null, root: null, reason: 'default path (workspace)' };
  }
  const raw = String(candidate).trim();
  const roots = [];
  if (workspace) roots.push(path.resolve(workspace));
  roots.push(...normaliseRoots(folders));
  if (!roots.length) return { allowed: false, abs: null, root: null, reason: 'no allowed roots configured' };

  const base = workspace ? path.resolve(workspace) : roots[0];
  let abs;
  try {
    abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(base, raw);
  } catch {
    return { allowed: false, abs: null, root: null, reason: 'unparsable path' };
  }
  // Judge the REAL location, never the path as written: a symlink inside a
  // granted folder must not become a door out of it. `realish` resolves the
  // deepest existing ancestor, so a file that does not exist yet still gets a
  // truthful answer for the directory it would be created in.
  const realTarget = realish(abs);
  for (const root of roots) {
    const realRoot = realish(root);
    if (isInside(realTarget, realRoot)) {
      return { allowed: true, abs: realTarget, root, reason: null };
    }
  }
  return {
    allowed: false,
    abs: realTarget,
    root: null,
    reason: `outside the workspace and every granted folder (${roots.length} allowed)`,
  };
}

/** The path arguments each V1 file tool actually uses. */
export const PATH_ARGUMENTS = Object.freeze({
  'browser.upload': ['path'],
  'web.download': ['path'],
  'fs.list': ['path'],
  'fs.read': ['path'],
  'fs.write': ['path'],
  'fs.patch': ['path'],
  'fs.search': ['path'],
  'fs.grep': ['path'],
  'fs.find': ['path'],
  'fs.move': ['from', 'to'],
  'fs.copy': ['from', 'to'],
  'fs.delete': ['path'],
  'fs.stat': ['path'],
  'fs.mkdir': ['path'],
  'fs.tar': ['archive', 'path', 'cwd'],
});

/**
 * Enforce the policy for one tool call. Throws a classified error the runner
 * turns into PERMISSION_DENIED, so the model sees "denied" and not "crash".
 */
export function assertPathsAllowed(toolName, input = {}, { workspace, folders = [] } = {}) {
  const keys = PATH_ARGUMENTS[toolName];
  if (!keys) return;
  for (const key of keys) {
    const value = input?.[key];
    if (value == null || value === '') continue;
    const check = checkPath(value, { workspace, folders });
    if (!check.allowed) {
      const err = new Error(
        `${toolName}: ${key}="${String(value).slice(0, 160)}" is ${check.reason}. `
        + 'Grant the folder in the Permissions panel of the app, or use a path inside the workspace.',
      );
      err.code = 'protected';
      err.cls = 'PERMISSION_DENIED';
      throw err;
    }
  }
}
