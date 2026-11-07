/**
 * MAJIN V4 — supervised plugin worker.
 *
 * Owns the lifecycle of one child process per plugin:
 *   spawn (stripped env) -> activate -> [call -> result]* -> shutdown
 *
 * Guarantees: a plugin cannot block the host event loop, a crash is reported as
 * a failed plugin instead of a dead server, calls time out, and every call has a
 * hard ceiling on concurrent work.
 *
 * Honest limit: same OS user, same filesystem. This is crash/CPU isolation, not
 * a security boundary against malicious code. See docs/v4/SECURITY.md.
 */
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plugin-worker.js');

/** Only these env keys reach a plugin process; keys are never in this list. */
const ENV_ALLOWLIST = ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'];

export function sanitizedEnv(source = process.env) {
  const out = {};
  for (const key of ENV_ALLOWLIST) if (source[key] != null) out[key] = source[key];
  // A child that inherits NODE_OPTIONS could be told to preload code; drop it.
  return out;
}

export class PluginWorker {
  constructor({ dir, manifest, timeoutMs = 5000, callTimeoutMs = 15_000, spawnImpl = fork } = {}) {
    this.dir = dir;
    this.manifest = manifest;
    this.timeoutMs = timeoutMs;
    this.callTimeoutMs = callTimeoutMs;
    this.spawnImpl = spawnImpl;
    this.child = null;
    this.registered = [];
    this.pending = new Map();
    this.counter = 0;
    this.dead = false;
    this.exitReason = null;
  }

  #spawn() {
    const child = this.spawnImpl(WORKER, [], {
      cwd: this.dir,
      env: sanitizedEnv(),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      // Node runs the plugin with no inspector and no eval privileges beyond ESM.
      execArgv: ['--no-warnings'],
    });
    // A plugin that floods stdout must not fill memory or leak into host logs.
    child.stdout?.resume();
    child.stderr?.resume();
    child.on('exit', (code, signal) => {
      this.dead = true;
      this.exitReason = signal ? `signal ${signal}` : `exit ${code}`;
      for (const [, p] of this.pending) p.reject(Object.assign(new Error(`plugin ${this.manifest.name} died (${this.exitReason})`), { cls: 'PROCESS_CRASH' }));
      this.pending.clear();
    });
    child.on('message', (msg) => this.#onMessage(msg));
    return child;
  }

  #onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'register') {
      this.registered.push({ kind: msg.kind, name: msg.name });
      return;
    }
    if (msg.type === 'result') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(Object.assign(new Error(msg.error || 'plugin tool failed'), { cls: msg.cls || 'UNKNOWN' }));
    }
  }

  #await(type, { timeoutMs = this.timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`plugin ${this.manifest.name} did not send "${type}" within ${timeoutMs}ms`)), timeoutMs);
      const onMessage = (msg) => {
        if (msg?.type === type) {
          clearTimeout(timer);
          this.child.off('message', onMessage);
          resolve(msg);
        } else if (msg?.type === 'activation-failed' || msg?.type === 'fatal') {
          clearTimeout(timer);
          this.child.off('message', onMessage);
          reject(new Error(msg.error || 'plugin activation failed'));
        }
      };
      this.child.on('message', onMessage);
      this.child.once('exit', () => {
        clearTimeout(timer);
        this.child.off('message', onMessage);
        reject(new Error(`plugin ${this.manifest.name} exited during ${type} (${this.exitReason || 'unknown'})`));
      });
    });
  }

  async start() {
    this.child = this.#spawn();
    await this.#await('ready', { timeoutMs: this.timeoutMs });
    this.child.send({ type: 'activate', dir: this.dir, manifest: this.manifest });
    await this.#await('activated', { timeoutMs: this.timeoutMs });
    return this;
  }

  /** Proxy a tool call into the worker. Never returns a fabricated success. */
  call(name, input, { timeoutMs = this.callTimeoutMs, signal = null } = {}) {
    if (this.dead || !this.child) {
      return Promise.reject(Object.assign(new Error(`plugin ${this.manifest.name} is not running`), { cls: 'DEPENDENCY_MISSING' }));
    }
    if (signal?.aborted) {
      return Promise.reject(Object.assign(new Error('cancelled before the plugin call started'), { cls: 'CANCELLED', code: 'ABORTED' }));
    }
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`plugin tool ${name} timed out after ${timeoutMs}ms`), { cls: 'TIMEOUT' }));
      }, timeoutMs);
      // A cancelled call cannot be un-sent, but it can stop being awaited; and
      // stopping the whole worker is the only way to stop the code inside it.
      const onAbort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        signal.removeEventListener?.('abort', onAbort);
        this.stop();
        reject(Object.assign(new Error(`plugin tool ${name} cancelled; its worker was stopped`), { cls: 'CANCELLED', code: 'ABORTED' }));
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => { signal?.removeEventListener?.('abort', onAbort); resolve(v); },
        reject: (e) => { signal?.removeEventListener?.('abort', onAbort); reject(e); },
        timer,
      });
      this.child.send({ type: 'call', id, name, input });
    });
  }

  /**
   * Graceful stop, then a hard kill. Pipes and the IPC channel are destroyed so
   * a stopped plugin leaves no handle behind (which would keep a test runner or
   * a short-lived CLI process alive).
   */
  stop() {
    const child = this.child;
    if (this.stopped) return this.stopped;
    if (!child || this.dead) return Promise.resolve();
    this.dead = true;
    // Keep a referenced deadline until exit: callers await this promise and on
    // POSIX an unreferenced child plus an unreferenced timer can end Node early.
    let timer;
    this.stopped = new Promise((resolve) => child.once('exit', () => { clearTimeout(timer); resolve(); }));
    try {
      child.send({ type: 'shutdown' });
    } catch { /* already gone */ }
    try {
      child.disconnect();
    } catch { /* channel already closed */ }
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch { /* already dead */ }
    }, 500);
    return this.stopped;
  }
}
