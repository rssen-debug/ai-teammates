import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startJob, runSync, listBackends, getJob } from '../src/core/executors.js';

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'exec-ws-'));

test('W3 backends inventory: measured, never promised', () => {
  const b = listBackends();
  assert.equal(b.local.available, true);
  for (const k of ['docker', 'ssh']) {
    assert.ok(typeof b[k].available === 'boolean');
    assert.ok(b[k].note.length > 10);
  }
});

test('W3 local backend: real run with exit code + duration + persisted logs', async () => {
  const dir = ws();
  const out = await runSync({ command: process.platform === 'win32' ? "Write-Output 'exec-test'; Write-Output 'abc'" : 'echo exec-test && printf "abc"', backend: 'local', timeoutSec: 30 }, { workspace: dir });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.exitCode, 0);
  assert.match(out.io.stdout, /exec-test/);
  assert.ok(fs.existsSync(out.paths.stdout), 'stdout log persisted on disk');
  assert.ok(fs.existsSync(path.join(out.paths.metaDir, 'meta.json')), 'meta.json persisted');
  assert.ok(out.ms > 0);
});

test('W3 local timeout: job killed, honest TIMED OUT + no false success', async () => {
  const dir = ws();
  const out = await runSync({ command: process.platform === 'win32' ? 'Start-Sleep 30' : 'sleep 30', backend: 'local', timeoutSec: 1 }, { workspace: dir });
  assert.equal(out.ok, false);
  assert.ok(out.timedOut === true, JSON.stringify(out));
  assert.ok(out.ms && out.ms < 5000);
});

test('W3 cancellation: handle.cancel actually stops a running job (SIGTERM path)', async () => {
  const dir = ws();
  const started = startJob({ command: process.platform === 'win32' ? 'Start-Sleep 30' : 'sleep 30', backend: 'local', timeoutSec: 60 }, { workspace: dir });
  assert.equal(started.ok, true);
  assert.ok(getJob(started.meta.id), 'job visible while running');
  started.handle.cancel('test-stop');
  const meta = await started.handle.settled();
  assert.equal(meta.cancelledBy, 'test-stop');
  assert.ok(Number(meta.exitCode) !== 0 || meta.signal);
});

test('W3 docker backend: explicit request, never silent host-fallback', async () => {
  const dir = ws();
  const marker = path.join(dir, 'HOST_FALLBACK_FORBIDDEN.txt');
  // A deterministic hostile command: if the implementation silently chooses
  // the local PowerShell/bash backend, this writes into the isolated workspace.
  const command = process.platform === 'win32'
    ? 'Set-Content -Path HOST_FALLBACK_FORBIDDEN.txt -Value BAD'
    : 'printf BAD > HOST_FALLBACK_FORBIDDEN.txt';
  const out = startJob({ command, backend: 'docker' }, { workspace: dir });
  if (out.ok) {
    out.handle.cancel('test-no-host-fallback');
    await out.handle.settled();
  }
  assert.equal(out.ok, false, 'docker without an image must never run a host command');
  // Docker availability probing on CI can vary over seconds under load. Both
  // are truthful fail-closed outcomes; do not compare two racy independent probes.
  assert.ok(['docker_image_required', 'docker_unavailable'].includes(out.error?.code),
    'explicit unavailable/image error expected, got ' + JSON.stringify(out.error));
  if (out.error.code === 'docker_unavailable') assert.match(out.error.message, /FORBIDDEN/);
  if (out.error.code === 'docker_image_required') assert.match(out.error.message, /job\\.image|image/);
  assert.equal(fs.existsSync(marker), false, 'host command must not run as fallback');
});

test('W3 ssh backend: no host configured → honest error code (not host-exec)', () => {
  const out = startJob({ command: 'echo x', backend: 'ssh' }, { workspace: ws() });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'ssh_host_required');
  assert.match(out.error.message, /FORBIDDEN/);
});

test('W3 output caps: output exceeding max bytes is truncated, never crashes', async () => {
  const dir = ws();
  const out = await runSync({ command: (process.platform === 'win32' ? "'A' * 200000" : 'yes A | head -c 200000'), backend: 'local', timeoutSec: 30, maxOutputBytes: 4096 }, { workspace: dir });
  const size = fs.readFileSync(out.paths.stdout).length;
  assert.ok(size <= 4096, `capped (${size}B)`);
  assert.ok(out.exitCode === 0 || out.exitCode === null || out.exitCode !== undefined);
});
