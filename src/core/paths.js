/**
 * MAJIN — filesystem layout.
 * One data dir holds everything (config, memory, skills, logs, tool output).
 * Windows default: %LOCALAPPDATA%\MAJIN   ·  elsewhere: ~/.majin
 * MAJIN_HOME overrides. MAJIN_CONFIG points straight at a config file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* Locate the app root: works as plain ESM, as an esbuild CJS bundle and inside a pkg snapshot. */
const selfDir = (() => {
  try {
    if (typeof __dirname !== 'undefined') return __dirname;
  } catch {
    /* ESM */
  }
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
})();
export const repoRoot = process.pkg || path.basename(selfDir) === 'dist' ? selfDir : path.resolve(selfDir, '..', '..');

export function expand(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function dataDir() {
  if (process.env.MAJIN_HOME) return path.resolve(expand(process.env.MAJIN_HOME));
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'MAJIN');
  }
  return path.join(os.homedir(), '.majin');
}

const D = dataDir();

export const dirs = {
  root: D,
  config: path.join(D, 'config.json'),
  devConfig: path.join(repoRoot, 'majin.config.json'),
  workspace: process.env.MAJIN_WORKSPACE || path.join(D, 'workspace'),
  memory: path.join(D, 'memory'),
  sessions: path.join(D, 'sessions'),
  skills: path.join(D, 'skills'),
  adapters: path.join(D, 'adapters'),
  plugins: path.join(D, 'plugins'),
  rules: path.join(D, 'rules'),
  logs: path.join(D, 'logs'),
  out: path.join(D, 'out'),
  uploads: path.join(D, 'uploads'),
  cache: path.join(D, 'cache'),
  creds: path.join(D, 'creds'),
  pid: path.join(D, 'majin.pid'),
};

/** YARA rules shipped with the app — copied into the data dir on first run so they stay editable. */
export const pkgRules = path.join(repoRoot, 'rules');

/**
 * Data directory for a config value: absolute stays, relative hangs under the MAJIN home.
 * Without this, `memory.dir: "memory"` would write into whatever folder the process
 * happened to start in (the repo, or worse: an unwritable Program Files dir).
 */
export function resolveData(raw, fallback = dirs.root) {
  const v = raw == null || raw === '' ? null : expand(String(raw));
  if (!v) return fallback;
  return path.isAbsolute(v) ? path.normalize(v) : path.join(D, v);
}

export function ensureDirs() {
  for (const [k, v] of Object.entries(dirs)) {
    if (k === 'config' || k === 'devConfig' || k === 'pid') continue;
    fs.mkdirSync(v, { recursive: true });
  }
  try {
    if (fs.existsSync(pkgRules)) {
      for (const f of fs.readdirSync(pkgRules)) {
        if (!f.endsWith('.yar')) continue;
        const dst = path.join(dirs.rules, f);
        if (!fs.existsSync(dst)) fs.copyFileSync(path.join(pkgRules, f), dst);
      }
    }
  } catch {
    /* read-only install: the loader also looks in the package dir */
  }
}

export function rel(p) {
  const r = path.relative(dirs.root, p);
  return r && !r.startsWith('..') ? r : p;
}

export function safeJoin(root, target) {
  const abs = path.resolve(expand(root), target ?? '.');
  const r = path.relative(path.resolve(root), abs);
  // V1: a sibling path starts with '..' plus a separator; '..backup' is inside.
  const outside = r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r);
  return { abs, outside, root: path.resolve(root) };
}
