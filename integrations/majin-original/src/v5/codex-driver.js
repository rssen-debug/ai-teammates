import fs from 'node:fs';
import path from 'node:path';
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scrubMcpEnv } from '../v4/mcp.js';

const workerFile = fileURLToPath(new URL('./codex-worker.js', import.meta.url));
const hash = value => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)).digest('hex');
export const driverFingerprint = (name, input) => hash({ name, input });
export class CodexDriver {
  constructor(options) {
    this.options = options;
    this.stateDir = path.resolve(options.stateDir);
    fs.mkdirSync(this.stateDir, { recursive: true });
    this.lockFile = path.join(this.stateDir, 'owner.lock');
    if (fs.existsSync(this.lockFile)) {
      const pid = Number(fs.readFileSync(this.lockFile, 'utf8'));
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch (error) { if (error.code !== 'ESRCH') alive = true; }
      if (alive) throw new Error('Another CODEX DRIVER owns this state directory');
      fs.unlinkSync(this.lockFile);
    }
    fs.writeFileSync(this.lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
    this.operations = new Map(); this.worker = null; this.active = null; this.closed = false;
    this.busy = false;
    // A previous process may have crashed after an external effect. Never replay it.
    for (const file of fs.readdirSync(this.stateDir).filter(f => /^[a-f0-9]{64}\.json$/.test(f))) {
      const record = JSON.parse(fs.readFileSync(path.join(this.stateDir, file), 'utf8'));
      if (record.status === 'running') {
        record.status = 'uncertain'; record.errorCode = 'RESTART_REQUIRES_INSPECTION';
        record.blocker = 'Inspect current state before issuing a new operation ID; the previous action may have happened.';
      }
      this.operations.set(record.operationId, record); this.save(record);
    }
  }
  save(record) {
    const file = path.join(this.stateDir, `${hash(record.operationId)}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }
  async start() {
    if (this.closed) throw new Error('Driver closed');
    if (this.worker) return;
    this.worker = fork(workerFile, [], { execArgv: [], detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
      env: { ...scrubMcpEnv(), PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
        ...(process.env.MAJIN_V4_BROWSER ? { MAJIN_V4_BROWSER: process.env.MAJIN_V4_BROWSER } : {}),
        ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
        ...(process.platform === 'win32' ? { PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD' } : {}), MAJIN_HOME: path.join(this.stateDir, 'majin'),
        MAJIN_WORKSPACE: this.options.workspace, MAJIN_DRIVER_OPTIONS: JSON.stringify(this.options) } });
    const worker = this.worker;
    worker.stderr.on('data', chunk => process.stderr.write(chunk));
    worker.on('message', msg => {
      if (msg.id && this.active?.id === msg.id) this.active.resolve(msg.value);
    });
    try { await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tool worker startup timeout')), 15000);
      worker.once('error', error => { clearTimeout(timer); reject(error); });
      worker.once('exit', () => { clearTimeout(timer); reject(new Error('Tool worker exited during startup')); });
      const onMessage = msg => { if (msg.ready) {
        clearTimeout(timer); this.catalog = msg.tools; worker.off('message', onMessage); resolve();
      } };
      worker.on('message', onMessage);
    }); } catch (error) {
      if (this.worker === worker) this.worker = null;
      worker.kill(); throw error;
    }
    worker.on('exit', () => {
      if (this.worker === worker) this.worker = null;
      if (this.active?.worker === worker) this.active.resolve({ ok: false, error: { code: 'WORKER_EXIT', message: 'Worker exited; inspect state before retrying' } });
    });
  }
  list() {
    return (this.catalog || []).map(({ source, ...t }) => ({ ...t, inputSchema: {
      ...t.inputSchema, properties: { ...t.inputSchema.properties, operationId: { type: 'string', minLength: 1, maxLength: 160,
        description: 'Stable unique ID for this action; reuse returns the previous result without repeating the action.' } },
      required: [...(t.inputSchema.required || []), 'operationId'],
    } }));
  }
  async call(name, args = {}) {
    if (this.closed) throw new Error('Driver closed');
    const { operationId, ...input } = args;
    if (typeof operationId !== 'string' || !operationId.length || operationId.length > 160) throw new Error('operationId (1–160 chars) is required');
    const fingerprint = driverFingerprint(name, input);
    const previous = this.operations.get(operationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('Operation ID already belongs to different arguments');
      return this.result(previous);
    }
    if (this.busy) throw new Error('An operation is running; inspect or cancel it before starting another');
    if (!this.catalog?.some(t => t.name === name)) throw new Error(`Unknown/unavailable tool: ${name}`);
    this.busy = true;
    try { await this.start(); } catch (error) { this.busy = false; throw error; }
    const record = { operationId, fingerprint, tool: name, status: 'running', startedAt: new Date().toISOString(),
      result: null, evidence: [], errorCode: null, blocker: null, details: null };
    this.operations.set(operationId, record); this.save(record);
    const id = randomUUID();
    let timer;
    try {
      const pending = new Promise(resolve => { this.active = { id, record, worker: this.worker, resolve }; });
      timer = setTimeout(() => { this.cancel(operationId, 'TIMEOUT').catch(e => console.error(e.message)); }, this.options.timeoutMs || 60000);
      this.worker.send({ id, name, args: input });
      const value = await pending;
      if (record.status === 'running') {
        record.status = value.error?.code === 'WORKER_EXIT' ? 'uncertain' : value.ok === false ? 'failed' : 'completed';
        record.errorCode = value.error?.code || null; record.blocker = value.error?.message || null;
        record.details = value.error?.meta || value.error?.details || value.meta || null;
        const { image, ...data } = value; record.result = data;
        if (image) {
          const filename = `${hash(operationId)}.png`;
          fs.writeFileSync(path.join(this.stateDir, filename), Buffer.from(image.data, 'base64'), { mode: 0o600 });
          record.evidence.push({ type: 'image', mimeType: 'image/png', file: filename });
        }
      }
    } catch (error) {
      record.status = 'uncertain'; record.errorCode = 'IPC_FAILURE'; record.blocker = error.message;
    } finally {
      clearTimeout(timer); this.active = null; this.busy = false; record.finishedAt = new Date().toISOString(); this.save(record);
    }
    return this.result(record);
  }
  result(record) {
    const content = [{ type: 'text', text: JSON.stringify(record) }];
    for (const item of record.evidence || []) if (item.type === 'image') content.push({ type: 'image', mimeType: item.mimeType,
      data: fs.readFileSync(path.join(this.stateDir, item.file)).toString('base64') });
    return { content, structuredContent: record, isError: !['running','completed'].includes(record.status) };
  }
  async cancel(operationId, code = 'CANCELLED') {
    const active = this.active;
    if (!active || active.record.operationId !== operationId) throw new Error('Operation is not running');
    active.record.status = 'uncertain'; active.record.errorCode = code;
    active.record.blocker = 'Worker stopped. An effect may already have occurred; inspect before retrying. Browser must be reopened.';
    const worker = this.worker;
    if (worker) {
      if (process.platform === 'win32') {
        // Give the worker a brief chance to terminate tracked shell trees
        // itself. Force-killing the worker first can race a shell that is
        // spawning its command child and leave that child orphaned. The
        // taskkill below remains the hard fallback for a blocked worker.
        let exited = worker.exitCode !== null;
        if (!exited) {
          const exitSeen = new Promise((resolve) => worker.once('exit', () => { exited = true; resolve(); }));
          try { if (worker.connected) worker.send({ type: 'shutdown' }); } catch { /* fall through to taskkill */ }
          await Promise.race([exitSeen, new Promise((resolve) => setTimeout(resolve, 1500))]);
        }
        if (!exited && worker.pid) {
          await promisify(execFile)('taskkill.exe', ['/PID', String(worker.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
        }
      } else {
        process.kill(-worker.pid, 'SIGKILL');
      }
      this.worker = null;
    }
    active.resolve({ ok: false }); this.save(active.record);
    return this.result(active.record);
  }
  async close() {
    this.closed = true;
    if (this.active) await this.cancel(this.active.record.operationId);
    else if (this.worker) {
      // browser.close releases Playwright's browser process before stopping the worker.
      if (this.catalog?.some(t => t.name === 'browser_close')) {
        await new Promise(resolve => {
          const id = randomUUID(); const timer = setTimeout(resolve, 5000);
          this.worker.on('message', msg => { if (msg.id === id) { clearTimeout(timer); resolve(); } });
          this.worker.send({ id, name: 'browser_close', args: {} });
        });
      }
      this.worker.kill(); this.worker = null;
    }
    if (fs.existsSync(this.lockFile) && fs.readFileSync(this.lockFile, 'utf8') === String(process.pid)) fs.unlinkSync(this.lockFile);
  }
}
