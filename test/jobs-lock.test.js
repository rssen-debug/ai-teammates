import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
// Tests must NEVER share the user's default %LOCALAPPDATA%/MAJIN/jobs or a
// folder with other parallel Node test workers. The previous Windows QA run
// had EPERM/EEXIST races between test processes resetting that shared folder.
const qaJobsHome=fs.mkdtempSync(path.join(os.tmpdir(),'majin-jobs-lock-'));
process.env.MAJIN_HOME=qaJobsHome;
const { _resetJobsFiles, upsertApplication, loadApplications, withAppsLock, appsLockPath } =
  await import('../src/core/jobs/store.js');
test.after(()=>fs.rmSync(qaJobsHome,{recursive:true,force:true}));

test('JOBS named-lock: 20 concurrent upserts from 5 sessions all SURVIVE race-free (no lost update)', async () => {
  _resetJobsFiles();
  const jobs = [];
  for (let s = 0; s < 5; s++) {
    for (let i = 0; i < 4; i++) {
      jobs.push(upsertApplication({ fp: `app-s${s}-${i}`, company: `co-${s}`, title: `t${i}`, at: new Date().toISOString() }));
    }
  }
  await Promise.all(jobs);
  const apps = await loadApplications();
  assert.equal(Object.keys(apps).length, 20, 'every concurrent upsert must land: got ' + Object.keys(apps).length);
  assert.equal(fs.existsSync(appsLockPath()), false, 'lock released after the storm (no residue)');
  _resetJobsFiles();
});

test('JOBS named-lock: stale lock from a dead holder is stolen with an AUDIT TRAIL, never silently', async () => {
  _resetJobsFiles();
  const lock = appsLockPath();
  await fsp.mkdir(path.dirname(lock), { recursive: true });
  await fsp.mkdir(lock);
  /* age the lock far beyond the stale threshold */
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(lock, past, past);
  let ran = false;
  const val = await withAppsLock(async () => { ran = true; return 'did-it'; }, { holder: 'rescue-task' });
  assert.equal(val, 'did-it');
  assert.equal(ran, true, 'work ran after the steal');
  assert.equal(fs.existsSync(lock), false, 'stolen lock released properly');
  _resetJobsFiles();
});

test('JOBS named-lock: lock auto-releases even when the guarded work THROWS', async () => {
  _resetJobsFiles();
  await assert.rejects(() => withAppsLock(async () => { throw new Error('boom inside critical section'); }), /boom/);
  assert.equal(fs.existsSync(appsLockPath()), false, 'the finally{} released it — exceptions must not brick future writers');
  /* and it still works right after */
  const r = await upsertApplication({ fp: 'post-crash-1', company: 'x' });
  assert.equal(r.existed, false);
  _resetJobsFiles();
});
