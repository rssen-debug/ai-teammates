/**
 * MAJIN — job-search persistence. Everything under <MAJIN_HOME>/jobs/:
 *   cv.txt            the user's CV (plain text — the matcher reads words)
 *   applications.json { fp → application }  — fp = the dedupe key, so the
 *                     dedupe memory and the pipeline are the same file:
 *                     a job seen once is never shown twice unless asked for.
 * Writes are tmp-then-rename, reads treat a missing/corrupt file as empty —
 * a torn store must never cost the user their pipeline.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { dataDir } from '../paths.js';

export function jobsDir() {
  return path.join(dataDir(), 'jobs');
}

async function writeAtomic(abs, data) {
  const tmp = `${abs}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, abs);
}

async function readJson(abs, fallback) {
  try {
    return JSON.parse(await fsp.readFile(abs, 'utf8'));
  } catch {
    return fallback; // missing OR corrupt behaves like empty — never like fatal
  }
}

export const cvPath = () => path.join(jobsDir(), 'cv.txt');
export const appsPath = () => path.join(jobsDir(), 'applications.json');

export async function loadCv() {
  try {
    const text = await fsp.readFile(cvPath(), 'utf8');
    const stat = await fsp.stat(cvPath());
    return { text, updatedAt: stat.mtimeMs };
  } catch {
    return null;
  }
}

export async function saveCv(text) {
  await fsp.mkdir(jobsDir(), { recursive: true });
  await writeAtomic(cvPath(), String(text));
  const stat = await fsp.stat(cvPath());
  return { chars: String(text).length, updatedAt: stat.mtimeMs };
}

export async function loadApplications() {
  return readJson(appsPath(), {});
}

export async function saveApplications(apps) {
  await fsp.mkdir(jobsDir(), { recursive: true });
  await writeAtomic(appsPath(), JSON.stringify(apps, null, 1));
  return Object.keys(apps).length;
}

/** Cross-task named lock (adds what the open-debt note asked for, closed 2026-10-21): mkdir is atomic on every
   supported FS, incl. Windows — two concurrent writers can never both win.
   Stale locks (holder died mid-write) are stolen after 30s WITH the act
   recorded, never silently. */
const LOCK_STALE_MS = 30_000;
export function appsLockPath() { return appsPath() + '.lock'; }

export async function withAppsLock(fn, { maxWaitMs = 5000, holder = 'task' } = {}) {
  const lock = appsLockPath();
  await fsp.mkdir(path.dirname(lock), { recursive: true }); /* a missing parent is not a lockholder */
  const start = Date.now();
  for (;;) {
    try {
      await fsp.mkdir(lock);
      await fsp.writeFile(path.join(lock, 'holder.txt'), `${holder} \u00b7 ${new Date().toISOString()} \u00b7 pid:${process.pid}`);
      break;
    } catch (e) {
      // Windows can temporarily raise EPERM (instead of EEXIST) while a lock
      // directory is being removed by another writer. Retry ONLY when this
      // process can still WRITE the parent; genuine permission errors fail.
      // The existing maxWaitMs bound still applies, never wait forever.
      let transientWindowsEperm = false;
      if (process.platform === 'win32' && e.code === 'EPERM') {
        try {
          await fsp.access(path.dirname(lock), fs.constants.W_OK);
          transientWindowsEperm = true;
        } catch { /* actual inaccessible parent: preserve original error */ }
      }
      if (e.code !== 'EEXIST' && !transientWindowsEperm) throw e;
      try {
        const st = await fsp.stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fsp.rm(lock, { recursive: true, force: true });
          continue; /* steal recorded via the new holder entry, never silent */
        }
      } catch { /* raced */ }
      if (Date.now() - start > maxWaitMs) {
        const err = new Error('apps lock held too long by another task — refusing to silently overwrite; retry later');
        err.code = 'apps_lock_timeout';
        throw err;
      }
      await new Promise((r) => setTimeout(r, 40 + Math.random() * 60));
    }
  }
  try {
    return await fn();
  } finally {
    try { await fsp.rm(lock, { recursive: true, force: true }); } catch { /* released already */ }
  }
}

/** Upsert under the named apps lock: concurrent writers serialize — a lost
   update on the applications map becomes architecturally impossible. */
export async function upsertApplication(app) {
  return withAppsLock(async () => {
    const apps = await loadApplications();
    const existed = Boolean(apps[app.fp]);
    apps[app.fp] = app;
    await saveApplications(apps);
    return { existed, app };
  }, { holder: 'upsertApplication' });
}

/** Test + doctor helper: wipe every job file. fs sync on purpose (tests). */
export function _resetJobsFiles(target = jobsDir()) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* gone */ }
}
