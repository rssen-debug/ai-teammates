import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Scheduler } from '../core/schedule.js';
import { jsonSchemaFor } from '../v4/schema.js';

// Reuse the durable core scheduler; all execution goes through the V5 agent.
export class V5Schedule {
  constructor({ dataDir, execute, isBusy, isAllowed, now = Date.now }) {
    this.dataDir = dataDir; this.execute = execute; this.isBusy = isBusy;
    this.isAllowed = isAllowed; this.now = now;
    this.scheduler = null; this.timer = null; this.error = null; this.inFlight = null;
    this.lockFile = path.join(dataDir, 'v5-schedule.lock');
  }
  start() {
    if (this.scheduler) return;
    let fd;
    try {
      fd = fs.openSync(this.lockFile, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      this.ownsLock = true;
      this.scheduler = new Scheduler({ get: key => key === 'schedule.enabled' ? false : undefined }, {
        file: path.join(this.dataDir, 'v5-schedule.json'), now: this.now,
        runTask: async ({ input, jobId, runId }) => {
          const goal = await this.execute({ goalText: input });
          const job = this.scheduler.jobs.find(j => j.id === jobId);
          if (job) {
            job.metadata = { ...job.metadata, goalId: goal.goal_id, runId };
            // A partial/uncertain external effect must not be retried by a timer.
            if (goal.status !== 'COMPLETED') job.paused = true;
          }
          return { status: goal.status, text: goal.final || goal.summary || goal.blocker || '', goalId: goal.goal_id };
        },
      });
      this.error = null;
      this.timer = setInterval(() => { void this.tick().catch(error => { this.error = error.message; clearInterval(this.timer); }); }, 1000);
      this.timer.unref?.();
    } catch (error) {
      this.error = error.code === 'EEXIST'
        ? `Scheduler lock exists at ${this.lockFile}; another host may own it. After an unclean exit, confirm its recorded process has stopped before removing the lock.`
        : error.message;
      if (this.ownsLock) { fs.rmSync(this.lockFile, { force: true }); this.ownsLock = false; }
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  status() {
    return { running: Boolean(this.scheduler && this.timer && !this.error), error: this.error,
      hostMustStayRunning: true, verificationUrl: this.verificationUrl || null, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      model: 'current saved V5 model at execution time', jobs: this.scheduler?.list() || [] };
  }
  tick() {
    if (!this.scheduler || this.error || this.inFlight || this.isBusy() || !this.isAllowed()) return Promise.resolve();
    // Scheduler remains timer-disabled: this guard is the only dispatch path.
    const due = this.scheduler.jobs.find(job => !job.paused && job.nextRun && job.nextRun <= this.now());
    if (!due) return Promise.resolve();
    this.inFlight = this.scheduler.fire(due).then(result => {
      if (result?.error) { due.paused = true; this.scheduler.save(); }
      return result;
    }).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  async stop() {
    clearInterval(this.timer); this.timer = null;
    this.scheduler?.stop();
    await this.inFlight;
    this.scheduler = null;
    if (this.ownsLock) { fs.rmSync(this.lockFile, { force: true }); this.ownsLock = false; }
  }
  manage(input) {
    const data = scheduleSchema.parse(input);
    if (data.action === 'list') return this.status();
    if (!this.scheduler || this.error) throw new Error(this.error || 'Scheduler host is not running');
    if (['add', 'resume'].includes(data.action) && !this.isAllowed()) throw new Error('Owner sys lane and an active provider model are required');
    if (data.action === 'add') {
      if (!data.when || !data.task) throw new Error('when and task are required');
      if (this.scheduler.jobs.length >= 100) throw new Error('Schedule limit reached (100)');
      const job = this.scheduler.add({ name: data.name, when: data.when, task: data.task, maxRuns: data.maxRuns ?? 1 });
      if (job.nextRun === null) { this.scheduler.remove(job.id); throw new Error('Schedule has no future execution time'); }
      return { job, hostMustStayRunning: true, verificationUrl: this.verificationUrl || null };
    }
    if (!data.id || !this.scheduler.jobs.some(j => j.id === data.id)) throw new Error('Unknown schedule id');
    if (this.scheduler.running.has(data.id)) throw new Error('Schedule is executing; stop the active goal before editing it');
    if (data.action === 'remove') return { removed: this.scheduler.remove(data.id) };
    return { changed: this.scheduler.setPaused(data.id, data.action === 'pause') };
  }
}
const scheduleSchema = z.object({
  action: z.enum(['list', 'add', 'pause', 'resume', 'remove']).default('list'),
  id: z.string().max(100).optional(), name: z.string().max(100).optional(),
  when: z.string().max(500).optional(), task: z.string().min(1).max(20000).optional(),
  maxRuns: z.number().int().min(1).max(10000).optional(),
}).strict();
export function createScheduleTool(service) {
  return { name: 'majin_schedule', description: 'Schedule owner-requested future work using the saved V5 model and grants. Host must stay open. Times use the host timezone. Actions: list/add/pause/resume/remove. Set maxRuns explicitly for recurring work (default one run). Unverified runs pause, never silently replay. The add result gives a verificationUrl: register an http goal criterion for that URL containing the returned job.id to verify creation. No separate delivery or model route is implied.',
    inputSchema: jsonSchemaFor(scheduleSchema), run: input => service.manage(input) };
}
