/**
 * MAJIN V4 — host supervisor.
 *
 * The private release runs on a Windows PC that is supposed to stay up. A crashed
 * host process must come back by itself, and the reason it died must be written
 * down instead of vanishing into a console window.
 *
 * What this does:
 *   - owns the host process lifecycle (spawn, health probe, restart)
 *   - restarts with exponential backoff and a hard cap inside a window, so a
 *     broken build crash-loops visibly instead of spinning forever
 *   - writes one JSON line per lifecycle event to a log file (0600)
 *   - stops cleanly: SIGTERM to the child, wait, then SIGKILL
 *
 * What this does NOT do: it does not decide policy, does not touch the network
 * except the configured health URL, and does not restart after a deliberate stop.
 *
 * Everything is injectable (spawn, fetch, clock, timers) so the restart logic is
 * tested here without a Windows machine.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const SUPERVISOR_DEFAULTS = Object.freeze({
  backoffMs: 1000,
  maxBackoffMs: 30_000,
  maxRestarts: 5,
  windowMs: 10 * 60 * 1000,
  healthTimeoutMs: 2000,
  startupGraceMs: 15_000,
  stopGraceMs: 5000,
  healthIntervalMs: 15_000,
});

export class Supervisor {
  /**
   * @param {object} o
   * @param {string[]} o.command        argv, e.g. ['node', 'src/v4/main.js']
   * @param {string}   [o.cwd]
   * @param {string}   [o.healthUrl]
   * @param {string}   [o.logFile]      JSONL lifecycle log
   * @param {object}   [o.env]
   */
  constructor({
    command,
    cwd = process.cwd(),
    healthUrl = 'http://127.0.0.1:7373/api/health',
    logFile = null,
    env = process.env,
    spawn = nodeSpawn,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    setTimeout: setTimeoutFn = setTimeout,
    clearTimeout: clearTimeoutFn = clearTimeout,
    ...options
  } = {}) {
    if (!Array.isArray(command) || command.length === 0) throw new Error('supervisor requires an argv command');
    this.command = command;
    this.cwd = cwd;
    this.healthUrl = healthUrl;
    this.logFile = logFile;
    this.env = env;
    this.spawn = spawn;
    this.fetch = fetchImpl;
    this.now = now;
    this.setTimeout = setTimeoutFn;
    this.clearTimeout = clearTimeoutFn;
    this.options = { ...SUPERVISOR_DEFAULTS, ...options };

    this.child = null;
    this.restarts = []; // timestamps of restarts inside the window
    this.stopping = false;
    this.healthTimer = null;
    this.restartTimer = null;
    this.startedAt = null;
    this.state = 'idle'; // idle | starting | healthy | restarting | stopped | failed
    this.lastError = null;
    this.stats = { spawns: 0, crashes: 0, healthFailures: 0, restarts: 0 };
  }

  log(event, detail = {}) {
    const line = JSON.stringify({ at: new Date(this.now()).toISOString(), event, ...detail });
    if (this.logFile) {
      try {
        fs.mkdirSync(path.dirname(this.logFile), { recursive: true, mode: 0o700 });
        fs.appendFileSync(this.logFile, `${line}\n`, { mode: 0o600 });
      } catch { /* logging must never take the host down */ }
    }
    return line;
  }

  /** One health probe. Resolves true only on a 200 with ok:true. */
  async probe() {
    if (!this.healthUrl) return true;
    try {
      const res = await this.fetch(this.healthUrl, { signal: AbortSignal.timeout(this.options.healthTimeoutMs) });
      if (!res.ok) return false;
      const body = await res.json();
      return body?.ok === true;
    } catch {
      return false;
    }
  }

  /** Start the process and wait until it answers health, or the grace period ends. */
  async start() {
    if (this.child) return this;
    this.stopping = false;
    this.state = 'starting';
    this.startedAt = this.now();
    this.stats.spawns += 1;

    const [bin, ...args] = this.command;
    this.child = this.spawn(bin, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // Drain output: a chatty host must not fill a pipe and block.
    this.child.stdout?.on('data', (d) => this.log('stdout', { bytes: d.length }));
    this.child.stderr?.on('data', (d) => this.log('stderr', { text: String(d).slice(0, 400) }));

    const startedChild = this.child;
    this.child.on('exit', (code, signal) => this.#onExit(code, signal));
    this.child.on('error', (err) => {
      this.log('spawn_error', { message: err.message });
      if (this.child === startedChild) this.#onExit(null, 'spawn_error');
    });

    const deadline = this.now() + this.options.startupGraceMs;
    while (this.now() < deadline) {
      const healthy = await this.probe();
      if (this.child !== startedChild || this.stopping || this.state === 'restarting') return this;
      if (healthy) {
        this.state = 'healthy';
        this.log('healthy', { pid: this.child?.pid ?? null, ms: this.now() - this.startedAt });
        this.#scheduleHealth();
        return this;
      }
      if (!this.child) break; // exited during startup
      await new Promise((r) => this.setTimeout(r, 250));
    }

    if (this.child) {
      // Started but never answered: that is a failure, not a success.
      this.log('unhealthy_after_grace', { graceMs: this.options.startupGraceMs });
      this.state = 'failed';
      this.lastError = 'host did not answer its health check';
    }
    return this;
  }

  #scheduleHealth() {
    if (this.healthTimer) this.clearTimeout(this.healthTimer);
    if (!this.options.healthIntervalMs) return;
    this.healthTimer = this.setTimeout(async () => {
      if (this.stopping || !this.child) return;
      const ok = await this.probe();
      if (!ok) {
        this.stats.healthFailures += 1;
        this.log('health_failed', { failures: this.stats.healthFailures });
        // Three consecutive misses is a hang, not a blip.
        if (this.stats.healthFailures >= 3) this.restart('health check failed repeatedly');
      } else {
        this.stats.healthFailures = 0;
      }
      if (this.state === 'healthy') this.#scheduleHealth();
    }, this.options.healthIntervalMs);
  }

  #onExit(code, signal) {
    const wasStopping = this.stopping;
    const wasRestarting = this.state === 'restarting';
    const pid = this.child?.pid ?? null;
    this.child = null;
    if (this.healthTimer) {
      this.clearTimeout(this.healthTimer);
      this.healthTimer = null;
    }
    if (wasStopping) {
      this.state = 'stopped';
      this.log('stopped', { pid, code, signal });
      return;
    }
    if (wasRestarting) {
      this.log('replaced', { pid, code, signal });
      return;
    }
    this.stats.crashes += 1;
    this.log('crashed', { pid, code, signal });
    this.lastError = `exit ${code ?? signal}`;
    this.restart(`process exited (${code ?? signal})`);
  }

  /** Restart with backoff, bounded by maxRestarts inside the window. */
  restart(reason) {
    if (this.stopping) return false;
    if (this.restartTimer) return true;
    const now = this.now();
    this.restarts = this.restarts.filter((t) => now - t < this.options.windowMs);
    if (this.restarts.length >= this.options.maxRestarts) {
      this.state = 'failed';
      this.lastError = `gave up after ${this.restarts.length} restarts: ${reason}`;
      this.log('gave_up', { reason, restarts: this.restarts.length, windowMs: this.options.windowMs });
      return false;
    }
    this.restarts.push(now);
    this.stats.restarts += 1;
    const delay = Math.min(this.options.maxBackoffMs, this.options.backoffMs * 2 ** (this.restarts.length - 1));
    this.state = 'restarting';
    this.log('restart_scheduled', { reason, delayMs: delay, attempt: this.restarts.length });
    if (this.healthTimer) this.clearTimeout(this.healthTimer);
    this.restartTimer = this.setTimeout(async () => {
      if (this.stopping) return;
      // Retire the unhealthy process before start(), which deliberately refuses
      // to create a second process while a child is still alive.
      const oldChild = this.child;
      if (oldChild) {
        try { oldChild.kill('SIGTERM'); } catch { /* already exited */ }
        const deadline = this.now() + this.options.stopGraceMs;
        while (this.child === oldChild && this.now() < deadline) {
          await new Promise((r) => this.setTimeout(r, 50));
        }
        if (this.child === oldChild) {
          try { oldChild.kill('SIGKILL'); } catch { /* already exited */ }
          this.restartTimer = null;
          this.state = 'failed';
          this.lastError = 'old host did not exit; refusing to start a duplicate';
          return;
        }
      }
      this.restartTimer = null;
      if (!this.stopping) await this.start();
    }, delay);
    return true;
  }

  /** Deliberate stop. Never triggers a restart. */
  async stop() {
    this.stopping = true;
    this.state = 'stopped';
    if (this.healthTimer) this.clearTimeout(this.healthTimer);
    if (this.restartTimer) this.clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    if (!child) return this;
    try {
      child.kill('SIGTERM');
    } catch { /* already gone */ }
    const deadline = this.now() + this.options.stopGraceMs;
    while (this.child && this.now() < deadline) {
      await new Promise((r) => this.setTimeout(r, 100));
    }
    if (this.child) {
      try {
        this.child.kill('SIGKILL');
      } catch { /* already gone */ }
      this.log('forced_kill', { reason: 'did not stop within grace' });
    }
    return this;
  }

  status() {
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      restartsInWindow: this.restarts.length,
      lastError: this.lastError,
      ...this.stats,
    };
  }
}
