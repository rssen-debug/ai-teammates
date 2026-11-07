/**
 * MAJIN W3 EXECUTION BACKENDS — one interface, three real backends.
 *
 *   local  — the host this MAJIN instance runs on (default; gapless).
 *   docker — an isolated container, only IF the docker binary exists.
 *   ssh    — an explicitly configured remote host over system ssh.
 *
 * Hard honesty rules (master directive W3):
 *  - A missing docker/ssh binary or config NEVER silently runs the job on the host.
 *  - Every backend supports: timeout, cancellation, output caps, persisted logs
 *    and artifact paths. Exit codes, signal and duration are always recorded.
 *  - No new runtime dependencies: system binaries (docker, ssh) are spawned.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const EXEC_SCHEMA = {
  job: { command: 'string', cwd: 'string?', env: 'object?', timeoutSec: 'number?', maxOutputBytes: 'number?', backend: 'string', image: 'string?', ssh: 'object?', mounts: 'array?' },
};

export const VERSION = 'majin-exec/1';
const JOBS = new Map();

export function listBackends() {
  const docker = spawnSync('docker', ['--version'], { timeout: 4000, encoding: 'utf8' });
  const ssh = spawnSync('ssh', ['-V'], { timeout: 4000, encoding: 'utf8' });
  return {
    local: { available: true, note: 'always available (host process spawn)' },
    docker: { available: docker.status === 0, version: (docker.stdout || '').trim() || null, note: docker.status === 0 ? 'docker binary found; container daemon and image execution not yet verified' : 'docker binary not on PATH — set up Docker or use backend=local explicitly' },
    ssh: { available: ssh.status === 0 || ssh.status === 1, version: ((ssh.stderr || '').split('\n')[0] || '').trim() || null, note: 'system ssh; requires an explicit host + BatchMode-compatible key/agent auth' },
  };
}

export function makeMetaDir(baseDir, id) {
  const d = path.join(baseDir, id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export class ExecHandle {
  constructor(id, proc, meta, metaDir) {
    this.id = id; this.proc = proc; this.meta = meta; this.metaDir = metaDir;
    this.cancelled = false;
    this.stdoutPath = path.join(metaDir, 'stdout.log');
    this.stderrPath = path.join(metaDir, 'stderr.log');
    this.stdoutBuf = []; this.stderrBuf = [];

    // Start observing process completion IMMEDIATELY, never when exec.wait is
    // first called. Fast Windows processes can exit before exec.wait arrives.
    // Keep the same settled promise for all later and concurrent waiters.
    this._settlement = new Promise((resolve) => {
      let finished = false;
      let timeout = null;
      const finish = (code, sig) => {
        if (finished) return;
        finished = true;
        if (timeout) clearTimeout(timeout);
        meta.doneAt = new Date().toISOString();
        meta.ms = Date.now() - meta.t0;
        meta.exitCode = code;
        meta.signal = sig;
        meta.status = meta.timedOut ? 'timed_out' : meta.cancelledBy ? 'cancelled' :
          meta.spawnError ? 'error' : code === 0 ? 'completed' : 'failed';
        try {
          fs.writeFileSync(this.stdoutPath, Buffer.concat(this.stdoutBuf));
          fs.writeFileSync(this.stderrPath, Buffer.concat(this.stderrBuf));
          fs.writeFileSync(path.join(this.metaDir, 'meta.json'), JSON.stringify(
            { ...meta, t0: undefined, stdoutPath: this.stdoutPath, stderrPath: this.stderrPath }, null, 2));
        } catch (err) {
          meta.persistError = String(err?.message || err);
        }
        this.stdoutBuf = []; this.stderrBuf = [];
        // exec.start -> exec.wait is intentionally asynchronous. Retain the
        // settled handle briefly so "already finished" is never no_such_job.
        // Archived evidence remains on disk after this TTL.
        const expiry = setTimeout(() => { if (JOBS.get(this.id) === this) JOBS.delete(this.id); }, 120000);
        expiry.unref?.();
        resolve(meta);
      };
      // close (not exit) guarantees pipes were flushed before writing logs.
      proc.once('close', finish);
      proc.once('error', (err) => {
        meta.spawnError = String(err?.message || err);
        // Node emits close after a spawn error; avoid a permanently dangling
        // promise if an unusual process adapter never emits close.
        setImmediate(() => { if (!finished && proc.pid == null) finish(null, null); });
      });
      if (meta.timeoutSec > 0) {
        timeout = setTimeout(() => {
          if (!finished) {
            meta.timedOut = true;
            this.cancel('timeout');
          }
        }, meta.timeoutSec * 1000);
        timeout.unref?.();
      }
    });
  }
  cancel(reason = 'user-request') {
    if (this.cancelled || !this.proc || this.proc.killed || this.meta.doneAt) return false;
    this.cancelled = true;
    this.meta.cancelledBy = reason;
    try { this.proc.kill('SIGTERM'); } catch {}
    const proc = this.proc;
    setTimeout(() => { try { if (!proc.killed) proc.kill('SIGKILL'); } catch {} }, 5000).unref?.();
    return true;
  }
  settled() { return this._settlement; }
}

function cappedAppend(buf, chunk, cap) {
  if (Buffer.concat(buf).length >= cap) return;
  const room = cap - Buffer.concat(buf).length;
  buf.push(Buffer.from(chunk.slice(0, room)));
}

export function startJob({ command, cwd, env = {}, timeoutSec = 300, maxOutputBytes = 1 << 20, backend = 'local', image = null, ssh = null, mounts = [] }, { workspace }) {
  const id = `ex-${crypto.randomBytes(4).toString('hex')}`;
  const now = new Date().toISOString();
  const base = { t0: Date.now(), id, backend, command, startedAt: now, timeoutSec, maxOutputBytes, status: 'running' };
  let spawned;
  switch (backend) {
    case 'local': {
      const isWin = process.platform === 'win32';
      spawned = isWin
        ? spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
            cwd: cwd || workspace || process.cwd(),
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        : spawn('bash', ['-lc', command], {
            cwd: cwd || workspace || process.cwd(),
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
      base.shell = isWin ? 'powershell' : 'bash -lc';
      break;
    }
    case 'docker': {
      const check = spawnSync('docker', ['--version'], { timeout: 4000, encoding: 'utf8' });
      if (check.status !== 0) {
        return { ok: false, error: { code: 'docker_unavailable', message: 'docker binary not found on PATH — backend=docker explicitly requested and silently running on the host is FORBIDDEN (W3)', hint: 'install Docker or choose backend=local explicitly' } };
      }
      if (!image) return { ok: false, error: { code: 'docker_image_required', message: 'backend=docker needs job.image (e.g. node:22-alpine)' } };
      const wsMount = mounts.length ? [] : ['-v', `${workspace || process.cwd()}:/work`];
      const args = ['run', '--rm', '--name', id, '--memory', `${Math.min(2048, 512)}m`, '--cpus', '1.0', ...wsMount, ...mounts.map(String), '-w', '/work', image, 'sh', '-lc', command];
      spawned = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      base.image = image; base.isolation = 'container (memory 512m, cpus 1.0)';
      break;
    }
    case 'ssh': {
      if (!ssh || !ssh.host) return { ok: false, error: { code: 'ssh_host_required', message: 'backend=ssh needs job.ssh.host — host not configured and silently running on host is FORBIDDEN (W3)' } };
      const probe = spawnSync('ssh', ['-V'], { timeout: 4000, encoding: 'utf8' });
      if (probe.status >= 2 || probe.error) {
        return { ok: false, error: { code: 'ssh_unavailable', message: 'system ssh not usable on this machine' } };
      }
      const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ...(ssh.port ? ['-p', String(ssh.port)] : []), `${ssh.user ? ssh.user + '@' : ''}${ssh.host}`, command];
      spawned = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      base.sshTarget = `${ssh.user || ''}@${ssh.host}${ssh.port ? ':' + ssh.port : ''}`;
      break;
    }
    default:
      return { ok: false, error: { code: 'backend_unknown', message: `unknown backend "${backend}" (local|docker|ssh)` } };
  }
  base.cmd = spawned.spawnargs;
  const metaDir = makeMetaDir(path.join(workspace || process.cwd(), 'exec'), id);
  const handle = new ExecHandle(id, spawned, base, metaDir);
  spawned.stdout.on('data', (c) => cappedAppend(handle.stdoutBuf, c, maxOutputBytes));
  spawned.stderr.on('data', (c) => cappedAppend(handle.stderrBuf, c, maxOutputBytes));
  spawned.on('error', (e) => { base.spawnError = e.message; });
  JOBS.set(id, handle);
  return { ok: true, handle, meta: { ...base, t0: undefined, metaDir } };
}

export function getJob(id) { return JOBS.get(id) || null; }

export async function runSync(job, opts) {
  const started = startJob(job, opts);
  if (!started.ok) return started;
  const meta = await started.handle.settled();
  const stdout = fs.existsSync(started.handle.stdoutPath) ? fs.readFileSync(started.handle.stdoutPath, 'utf8') : '';
  const stderr = fs.existsSync(started.handle.stderrPath) ? fs.readFileSync(started.handle.stderrPath, 'utf8') : '';
  return {
    ok: !(meta.timedOut || meta.cancelledBy) && Number(meta.exitCode) === 0,
    ...meta, io: { stdout: stdout.slice(-20000), stderr: stderr.slice(-20000) },
    paths: { metaDir: started.handle.metaDir, stdout: started.handle.stdoutPath, stderr: started.handle.stderrPath },
  };
}
