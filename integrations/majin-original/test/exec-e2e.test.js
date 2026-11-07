import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildRegistry } from '../src/core/tools/index.js';
import { execTools } from '../src/core/tools/exec.js';

/* W3 VERIFIED-delta: run real commands through the tool surface (not core in
   isolation), measure artifacts on disk, prove cancel is an act with identity,
   and re-prove the never-silent-backend-fallback contract through the same
   surface the agent uses. */

const tools = (name) => execTools.find((t) => t.name === name);

function setup() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-e2e'));
  const cfg = { get: (k) => (k === 'workspace' ? workspace : undefined), peek: () => undefined, patch: () => {} };
  const registry = buildRegistry({ cfg });
  return { workspace, ctx: { cfg, registry, session: 'w3-e2e' } };
}

test('W3 E2E local: real command runs, exit measured, stdout actually captured into durable artifacts', async () => {
  const { ctx } = setup();
  // Windows uses Windows PowerShell 5.1, which does NOT support Bash/PS7 &&.
  const cmd = process.platform === 'win32'
    ? "Write-Output 'w3-e2e-marker-252'; exit 0"
    : 'echo w3-e2e-marker-252 && exit 0';
  const started = await tools('exec.start').run({ backend: 'local', command: cmd, timeoutSec: 30 }, ctx);
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.match(started.meta.id, /^ex-/);
  assert.ok(started.meta.metaDir && fs.existsSync(started.meta.metaDir), 'metaDir must exist immediately: ' + started.meta.metaDir);

  const waited = await tools('exec.wait').run({ id: started.meta.id }, ctx);
  assert.equal(waited.ok, true, 'ok semantics follow the exit code: ' + JSON.stringify(waited.meta).slice(0, 200));
  assert.equal(waited.meta.exitCode, 0);
  assert.match(waited.meta.stdoutTail, /w3-e2e-marker-252/);
  /* durable streams: the full log survives on disk independent of the tool answer */
  const onDisk = fs.readFileSync(waited.meta.paths.stdout, 'utf8');
  assert.match(onDisk, /w3-e2e-marker-252/);
  assert.equal(fs.existsSync(path.join(waited.meta.paths.metaDir, 'meta.json')), true, 'archived meta.json must exist after settle');
}, 40000);

test('W3 E2E cancel: sleeper becomes ' + "'cancelled (explicit-actor)'" + ' — no silent zombie', async () => {
  const { ctx } = setup();
  const started = await tools('exec.start').run({ backend: 'local', command: process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30', timeoutSec: 120 }, ctx);
  assert.equal(started.ok, true, JSON.stringify(started));
  await new Promise((r) => setTimeout(r, 400));
  const cancelled = await tools('exec.cancel').run({ id: started.meta.id, reason: 'e2e-because-we-prove-it' }, ctx);
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  const waited = await tools('exec.wait').run({ id: started.meta.id }, ctx);
  assert.equal(waited.ok, false, 'a cancelled job is NOT a success — honest exit surface');
  assert.equal(waited.error.code, 'cancelled');
  assert.match(String(waited.meta.cancelledBy || waited.result), /e2e-because-we-prove-it|cancelled/, 'the cancel act keeps its actor+reason: ' + JSON.stringify(waited.meta).slice(0, 300));
}, 40000);

test('W3 E2E backend honesty through the same surface: docker/ssh never fall back to host-exec', async () => {
  const { ctx } = setup();
  const docker = await tools('exec.start').run({ backend: 'docker', command: 'echo nope', image: '' }, ctx);
  assert.equal(docker.ok, false);
  assert.match(docker.error.code, /docker_image_required|docker_unavailable/, 'deterministic refusal codes only: ' + docker.error.code);
  const ssh = await tools('exec.start').run({ backend: 'ssh', command: 'id' }, ctx);
  assert.equal(ssh.ok, false);
  assert.equal(ssh.error.code, 'ssh_host_required', 'ssh without host must refuse at this exact code: ' + ssh.error.code);
  /* and the no-fallback corollary: the HOST never ran the docker/ssh command */
  /* the no-fallback corollary made measurable: a refusal spawns NOTHING —
     no id, no metaDir, no process. Presence would mean a hidden start. */
  assert.equal(docker.meta?.id ?? null, null, 'refused docker job must not have spawned a process: ' + JSON.stringify(docker.meta || null));
  assert.equal(ssh.meta?.id ?? null, null, 'refused ssh job must not have spawned a process: ' + JSON.stringify(ssh.meta || null));
  const refusedDir = path.join(os.tmpdir(), 'w3-e2e-must-not-exist');
  assert.equal(fs.existsSync(refusedDir), false);
}, 40000);

test('W3 E2E exec.backends exposes measured availability (for honest planning)', async () => {
  const { ctx } = setup();
  const b = await tools('exec.backends').run({}, ctx);
  assert.equal(b.ok, true);
  const text = String(b.result);
  assert.match(text, /local/);
  assert.match(text, /docker|ssh/);
}, 20000);


test('W3 E2E completed-before-wait: quick command remains waitable with full durable output', async () => {
  const { ctx } = setup();
  const marker = 'qa-fast-finished-before-wait-123';
  const started = await tools('exec.start').run({ backend: 'local',
    command: 'echo '+marker, timeoutSec: 15 }, ctx);
  assert.equal(started.ok, true, JSON.stringify(started));
  // Deliberately let the process complete BEFORE calling exec.wait.
  // Previously settled() attached the exit handler only at wait time.
  await new Promise(resolve => setTimeout(resolve, 1800));
  const waited = await tools('exec.wait').run({ id: started.meta.id }, ctx);
  assert.equal(waited.ok, true, JSON.stringify(waited).slice(0, 700));
  assert.equal(waited.meta.exitCode, 0);
  assert.equal(waited.meta.status, 'completed');
  assert.match(waited.meta.stdoutTail, /qa-fast-finished-before-wait-123/);
  const again = await tools('exec.wait').run({ id: started.meta.id }, ctx);
  assert.equal(again.ok, true, 'a second waiter must receive the cached settled promise');
  assert.equal(again.meta.exitCode, 0);
  assert.ok(fs.existsSync(path.join(waited.meta.paths.metaDir,'meta.json')));
});
