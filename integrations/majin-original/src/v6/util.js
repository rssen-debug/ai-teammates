/**
 * MAJIN V6 — small, dependency-free durability primitives.
 *
 * Every V6 state file is written with write-temp+rename so a crash can never
 * leave a half-written queue. Nothing here talks to a model or a network.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function nowIso(clock = Date.now) {
  const ms = typeof clock === 'function' ? clock() : Number(clock);
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
}

export function newId(prefix = 'id', clock = Date.now) {
  const time = clock().toString(36).padStart(9, '0');
  return `${prefix}_${time}_${randomUUID().slice(0, 8)}`;
}

/** Deterministic JSON: key order never changes a fingerprint. */
export function canonicalJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return item;
  });
}

export function sha256(value) {
  const input = typeof value === 'string' ? value : canonicalJson(value);
  return createHash('sha256').update(input).digest('hex');
}

export function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
  return dir;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw Object.assign(new Error(`Unreadable JSON state: ${path.basename(file)} (${error.code || 'parse error'})`), {
      code: 'STATE_CORRUPT',
      cause: error,
    });
  }
}

export function atomicWriteJson(file, value, { mode = 0o600 } = {}) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 6)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
  return file;
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

export function clampInt(value, { min = 1, max = Number.MAX_SAFE_INTEGER, fallback = min } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

/** Sorted, bounded copy — never mutate an owner file by accident. */
export function sortedUnique(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String))].sort();
}

/**
 * Cross-process advisory lock (atomic mkdir). Stale holders are removed only
 * after the configured age; callers must still reconcile external effects.
 */
export async function withFileLock(lockPath, fn, { timeoutMs = 5000, staleMs = 30000, clock = Date.now } = {}) {
  const deadline = clock() + timeoutMs;
  let held = false;
  while (!held) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      fs.writeFileSync(path.join(lockPath, 'owner'), JSON.stringify({ pid: process.pid, at: new Date(clock()).toISOString() }), { mode: 0o600 });
      held = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(lockPath);
        if (clock() - stat.mtimeMs > staleMs) { fs.rmSync(lockPath, { recursive: true, force: true }); continue; }
      } catch { /* lock disappeared */ }
      if (clock() > deadline) throw Object.assign(new Error('Timed out waiting for a file lock'), { code: 'LOCK_TIMEOUT' });
      await sleep(15);
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}
