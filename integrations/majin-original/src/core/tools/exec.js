/**
 * MAJIN W3 execution backends — registry skin over src/core/executors.js.
 * risk:'exec' means the existing guard/approval flow applies by design.
 */
import fs from 'node:fs';
import path from 'node:path';
import { def } from './registry.js';
import { startJob, getJob, listBackends, VERSION } from '../executors.js';
import { journal } from '../browser.js';

export const execTools = [
  def({
    name: 'exec.backends',
    group: 'exec',
    risk: 'read',
    desc: 'List which execution backends (local/docker/ssh) are actually available on this machine — measured, not promised.',
    params: {},
    examples: ['exec.backends({})'],
    async run() {
      const b = listBackends();
      return { ok: true, result: Object.entries(b).map(([k, v]) => `${k}: ${v.available ? 'available' : 'unavailable'} — ${v.note}`).join('\n'), meta: { version: VERSION, backends: b }, summary: 'backend inventory' };
    },
  }),
  def({
    name: 'exec.start',
    group: 'exec',
    risk: 'exec',
    desc: 'Start a job on an explicitly chosen backend (local | docker | ssh). Never falls back to a different backend silently: if docker/ssh is unavailable the job refuses with an error code. Supports timeout + cancellation later.',
    params: {
      backend: 'string: local | docker | ssh [local|docker|ssh]',
      command: 'string: the command to run',
      cwd: 'string: working directory (optional)',
      timeoutSec: 'string: timeout seconds (optional, default 300)',
      image: 'string: docker image when backend=docker (optional)',
      sshHost: 'string: ssh host when backend=ssh (optional)',
      sshUser: 'string: ssh user when backend=ssh (optional)',
      sshPort: 'string: ssh port when backend=ssh (optional)',
    },
    examples: ['exec.start({backend:"local", command:"pwd && node --version", timeoutSec:60})', 'exec.start({backend:"docker", image:"node:22-alpine", command:"node -e console.log(process.version)"})'],
    async run({ backend = 'local', command, cwd, timeoutSec = 300, image, sshHost, sshUser, sshPort }, ctx) {
      const session = ctx.session || 'default';
      journal.guard(session, `exec.start:${backend}:${String(command).slice(0, 60)}`);
      const res = startJob(
        { command: String(command), cwd, timeoutSec: Number(timeoutSec) || 300, backend, image, ssh: sshHost ? { host: sshHost, user: sshUser || null, port: sshPort ? Number(sshPort) : null } : null },
        { workspace: ctx.cfg.get('workspace') || process.cwd() }
      );
      if (!res.ok) return { ok: false, error: res.error };
      return {
        ok: true,
        result: `started ${res.meta.id} on ${backend} (timeout ${res.meta.timeoutSec}s)`,
        meta: { id: res.meta.id, backend, metaDir: res.meta.metaDir, startedAt: res.meta.startedAt },
        summary: `${res.meta.id} on ${backend}`,
      };
    },
  }),
  def({
    name: 'exec.wait',
    group: 'exec',
    risk: 'exec',
    desc: 'Wait for a running job (by exec.start id) to finish; returns exit code, duration and truncated output (full streams live in the artifacts dir).',
    params: { id: 'string: job id returned by exec.start' },
    examples: ['exec.wait({id:"ex-1a2b3c4d"})'],
    async run({ id }, ctx) {
      const h = getJob(String(id));
      if (!h) return { ok: false, error: { code: 'no_such_job', message: `no running job "${id}" (finished jobs are archived in meta.json in their metaDir)` } };
      const meta = await h.settled();
      const stdout = fs.existsSync(h.stdoutPath) ? fs.readFileSync(h.stdoutPath, 'utf8') : '';
      const stderr = fs.existsSync(h.stderrPath) ? fs.readFileSync(h.stderrPath, 'utf8') : '';
      const okRes = !(meta.timedOut || meta.cancelledBy) && Number(meta.exitCode) === 0;
      return {
        ok: okRes,
        result: `${meta.id}: exit=${meta.exitCode} · ${meta.ms}ms${meta.timedOut ? ' · TIMED OUT' : ''}${meta.cancelledBy ? ` · cancelled (${meta.cancelledBy})` : ''}\n${stdout.slice(-4000)}`,
        error: okRes ? undefined : { code: meta.timedOut ? 'timeout' : meta.cancelledBy ? 'cancelled' : 'non_zero_exit', message: `${meta.id}: exit=${meta.exitCode}${meta.timedOut ? ' (timeout)' : ''}` },
        meta: { ...meta, stdoutTail: stdout.slice(-8000), stderrTail: stderr.slice(-8000), paths: { stdout: h.stdoutPath, stderr: h.stderrPath, metaDir: h.metaDir } },
        summary: `${meta.id} exit=${meta.exitCode}`,
      };
    },
  }),
  def({
    name: 'exec.cancel',
    group: 'exec',
    risk: 'exec',
    desc: 'Cancel a running job (SIGTERM then SIGKILL after grace). Cancellation is an act, not a guess: returns who cancelled and when.',
    params: { id: 'string: job id', reason: 'string: why (optional)' },
    examples: ['exec.cancel({id:"ex-1a2b3c4d", reason:"user asked to stop"})'],
    async run({ id, reason }, ctx) {
      const session = ctx.session || 'default';
      journal.guard(session, `exec.cancel:${id}`);
      const h = getJob(String(id));
      if (!h) return { ok: false, error: { code: 'no_such_job', message: `no running job "${id}"` } };
      const did = h.cancel(reason || 'user-request');
      return { ok: did, result: did ? `cancel signalled for ${id}` : `${id} was already terminating`, meta: { id, did }, summary: did ? `cancel ${id}` : `no-op ${id}` };
    },
  }),
  def({
    name: 'exec.logs',
    group: 'exec',
    risk: 'read',
    desc: 'Read persisted logs for a job id from the exec artifact dir (works also for finished jobs while on disk).',
    params: { id: 'string: job id', stream: 'string: stdout | stderr · optional (default stdout) [stdout|stderr]' },
    examples: ['exec.logs({id:"ex-1a2b3c4d"})'],
    async run({ id, stream = 'stdout' }, ctx) {
      const dir = path.join(ctx.cfg.get('workspace') || process.cwd(), 'exec', String(id));
      const f = path.join(dir, `${stream === 'stderr' ? 'stderr' : 'stdout'}.log`);
      if (!fs.existsSync(f)) return { ok: false, error: { code: 'logs_missing', message: `no ${stream} log under ${dir}` } };
      const text = fs.readFileSync(f, 'utf8');
      return { ok: true, result: text.slice(-6000), meta: { path: f, bytes: fs.statSync(f).size }, summary: `${id} ${stream} (${fs.statSync(f).size}B)` };
    },
  }),
];
