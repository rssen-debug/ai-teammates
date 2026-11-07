import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Heartbeat } from '../core/heartbeat.js';
import { atomicWriteJson } from './ops.js';
import { jsonSchemaFor } from '../v4/schema.js';

const MESSAGES = {
  WAITING_USER: 'An operation needs owner input. Inspect the saved goal and retained browser.',
  BLOCKED: 'An operation is blocked. Inspect its saved trace before resuming.',
  FAILED: 'An operation failed. Inspect its saved evidence before retrying.',
  PAUSED: 'An operation is paused; its checkpoint is retained.',
};
export class V5Heartbeat {
  constructor({ dataDir, now = Date.now, tickMs = 60000, minGapMs = 300000 }) {
    this.dataDir = dataDir; this.now = now; this.tickMs = tickMs; this.minGapMs = minGapMs;
    this.configFile = path.join(dataDir, 'v5-heartbeat-config.json');
    this.inboxFile = path.join(dataDir, 'v5-heartbeat-inbox.json');
    this.engine = null; this.error = null; this.enabled = true; this.inbox = [];
  }
  start({ ownsHost = false } = {}) {
    if (this.engine) return;
    if (!ownsHost) { this.error = 'Heartbeat requires exclusive V5 host ownership; inspect scheduler lock status.'; return; }
    try {
      try {
        const config = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
        if (typeof config.enabled !== 'boolean') throw new Error('Invalid heartbeat configuration');
        this.enabled = config.enabled;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try {
        const inbox = JSON.parse(fs.readFileSync(this.inboxFile, 'utf8'));
        if (!Array.isArray(inbox) || inbox.length > 100 || inbox.some(x => typeof x.id !== 'string' || typeof x.text !== 'string')) throw new Error('Invalid heartbeat inbox');
        this.inbox = inbox;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      this.engine = new Heartbeat({
        workspaceDir: path.join(this.dataDir, 'v5-heartbeat'), now: this.now,
        tickMs: this.tickMs, minGapMs: this.minGapMs,
        bus: { sub: () => () => {}, info: () => {} },
        deliverFn: async (text, { digestId, entries }) => {
          if (!this.inbox.some(item => item.id === digestId)) {
            const next = [...this.inbox, { id: digestId, at: new Date(this.now()).toISOString(), text,
              goals: [...new Set(entries.map(e => e.detail.goalId).filter(Boolean))] }].slice(-100);
            atomicWriteJson(this.inboxFile, next);
            this.inbox = next;
          }
          return { ok: true, channels: 'local-cli-inbox' };
        },
      });
      this.error = null;
      if (this.enabled) this.engine.start();
    } catch (error) { this.error = error.message; this.engine?.stop(); this.engine = null; }
  }
  stop() { this.engine?.stop(); this.engine = null; }
  observe(goal, phase = 'finished') {
    if (!this.engine || !goal?.goal_id) return;
    try {
      // Host-generated metadata only: provider text, URLs, CV data and keys are not copied.
      this.engine.discard(entry => entry.detail?.goalId === goal.goal_id && (phase !== 'finished' || entry.detail?.status !== goal.status));
      if (phase === 'finished' && this.enabled && MESSAGES[goal.status]) {
        this.engine.ingest(`goal.${goal.status.toLowerCase()}`, { goalId: goal.goal_id, status: goal.status, message: MESSAGES[goal.status] });
      }
      this.error = null;
    } catch { this.error = 'Heartbeat could not persist a goal event; inspect host storage.'; }
  }
  view() {
    const state = this.engine?.status();
    const { persisted, ...publicState } = state || {};
    return { ...publicState, running: Boolean(state?.running), enabled: this.enabled,
      error: this.error, delivery: 'local-cli-inbox', hostMustStayRunning: true,
      notifications: structuredClone(this.inbox), externalDelivery: false };
  }
  async manage(input = {}) {
    const { action } = schema.parse(input);
    if (action === 'status') return this.view();
    if (!this.engine) throw new Error(this.error || 'Heartbeat host is not running');
    if (action === 'preview') return this.engine.tick({ dryRun: true });
    if (action === 'tick') {
      if (!this.enabled) return { ok: true, sent: false, reason: 'Heartbeat is disabled' };
      return this.engine.tick();
    }
    const enabled = action === 'enable';
    atomicWriteJson(this.configFile, { enabled });
    this.enabled = enabled;
    if (enabled) this.engine.resume(); else this.engine.stop();
    return this.view();
  }
}
const schema = z.object({ action: z.enum(['status', 'enable', 'disable', 'preview', 'tick']).default('status') }).strict();
export function createHeartbeatTool(service) {
  return { name: 'majin_heartbeat', description: 'Inspect or control the durable local V5 heartbeat. It reports real blocked, failed, paused or owner-waiting goals; it never invents events or sends external messages. status/enable/disable/preview/tick. Tick respects the quiet interval; preview does not deliver.',
    inputSchema: jsonSchemaFor(schema), run: input => service.manage(input) };
}
