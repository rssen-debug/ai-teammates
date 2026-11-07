/**
 * MAJIN V6 — owner-supplied secrets.
 *
 * Secrets come from the process environment or an owner-only file. They are
 * never read from the repository, persisted into V6 state or included in
 * events. Only a boolean + source label leaves this module.
 */
import fs from 'node:fs';
import path from 'node:path';

export function loadOwnerToken({ envNames = [], file = null, env = process.env } = {}) {
  for (const name of envNames) {
    const value = env[name];
    if (typeof value === 'string' && value.trim()) {
      return { ok: true, token: value.trim(), source: `env:${name}`, error: null };
    }
  }
  if (file) {
    if (!fs.existsSync(file)) {
      return { ok: false, token: null, source: null, error: { code: 'TOKEN_FILE_MISSING', reason: `Token file not found: ${path.basename(file)}` } };
    }
    try {
      const stat = fs.statSync(file);
      if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
        return { ok: false, token: null, source: null, error: { code: 'TOKEN_FILE_PERMISSIONS', reason: 'Token file must be chmod 600' } };
      }
      const token = fs.readFileSync(file, 'utf8').trim();
      if (!token) return { ok: false, token: null, source: null, error: { code: 'TOKEN_FILE_EMPTY', reason: 'Token file is empty' } };
      return { ok: true, token, source: 'file', error: null };
    } catch (error) {
      return { ok: false, token: null, source: null, error: { code: 'TOKEN_FILE_UNREADABLE', reason: String(error.message || error).slice(0, 200) } };
    }
  }
  return { ok: false, token: null, source: null, error: { code: 'TOKEN_MISSING', reason: 'No owner token supplied' } };
}
