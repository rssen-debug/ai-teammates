/**
 * MAJIN W5 event flows — registry skin over src/core/flows.js.
 */
import path from 'node:path';
import { def } from './registry.js';
import { VERSION, flowId, saveFlow, loadFlow, listFlows, fire, eventHash, recordRun, TriggerHub, pollGithub, newGithubEvents } from '../flows.js';
import { journal } from '../browser.js';

let HUB = null;
function hubDir(ctx) { return ctx.cfg.get('workspace') || process.cwd(); }
/* tests must be able to release the persistent watcher or the process never drains */
export function testStopHub() { const h = HUB; HUB = null; return h ? h.stopAll() : Promise.resolve(); }

export const flowsTools = [
  def({
    name: 'flows.add',
    group: 'flows',
    risk: 'exec',
    desc: 'Register a durable event flow: when (trigger spec) + then (action tool with args template). The action runs through the SAME approval guard as interactive turns. Supported triggers: schedule (reuse scheduler), file (change/add/unlink), webhook (HTTP), github (poll), manual.',
    params: {
      name: 'string: human-readable flow name',
      when: 'object: trigger spec — examples: {type:"file", path:"C:\\\\work\\\\inbox", event:"add"} | {type:"cron", expr:"0 8 * * *"} | {type:"github", owner:"you", repo:"repo"} | {type:"webhook"} | {type:"manual"}',
      then: 'object: action — {tool:"fs.write", args:{path:"flows.log", content:"{{path}}"}}',
      maxFiresPerHour: 'string: rate cap (optional, default 20)',
      requireApproval: 'string: if "true" and action is exec-risk, let guard/approval stop the run (optional)',
    },
    examples: ['flows.add({name:"process new files", when:{type:"file", path:"./inbox", event:"add"}, then:{tool:"fs.write", args:{path:"seen.log", content:"{{path}} arrived"}}})'],
    async run({ name, when, then, maxFiresPerHour }, ctx) {
      const session = ctx.session || 'default';
      journal.guard(session, `flows.add:${String(name).slice(0, 40)}`);
      if (!name || !when || !then?.tool) return { ok: false, error: { code: 'invalid_flow', message: 'needs name + when + then.tool' } };
      const dir = hubDir(ctx);
      const defn = {
        id: flowId(String(name)), name: String(name), when, then,
        enabled: true, maxFiresPerHour: Number(maxFiresPerHour) || 20,
        history: [], createdAt: new Date().toISOString(), version: VERSION,
      };
      saveFlow(dir, defn);
      if (when.type === 'file') {
        HUB = HUB || new TriggerHub(dir, { onEvent: async (flow, ev) => fire(dir, flow, ev, { registry: ctx.registry }) });
        try { await HUB.startFileTrigger(loadFlow(dir, defn.id)); } catch (e) { defn.fileWatchError = e.message; saveFlow(dir, defn); }
      }
      return { ok: true, result: `flow "${name}" registered (id=${defn.id}, trigger=${when.type})`, meta: { id: defn.id, fileWatchError: defn.fileWatchError || null }, summary: `flow ${defn.id} (${when.type})` };
    },
  }),
  def({
    name: 'flows.list',
    group: 'flows',
    risk: 'read',
    desc: 'List registered flows with enabled state, last status and fire count — measured from state.json on disk.',
    params: {},
    examples: ['flows.list({})'],
    async run(_, ctx) {
      const list = listFlows(hubDir(ctx));
      return { ok: true, result: list.length ? list.map((f) => `${f.enabled ? 'on ' : 'off'} ${f.id} ${f.name} — ${f.when.type} · last=${f.lastStatus} · fires=${f.fireCount}`).join('\n') : '(no flows)', meta: { flows: list }, summary: `${list.length} flows` };
    },
  }),
  def({
    name: 'flows.enable',
    group: 'flows',
    risk: 'write',
    desc: 'Enable or disable an existing flow by id — state change persisted.',
    params: { id: 'string: flow id', enabled: 'string: "true"/"false" [true|false]' },
    examples: ['flows.enable({id:"ab12cd34ef56", enabled:"false"})'],
    async run({ id, enabled = 'true' }, ctx) {
      const dir = hubDir(ctx);
      const f = loadFlow(dir, String(id));
      if (!f) return { ok: false, error: { code: 'no_flow', message: `no flow "${id}"` } };
      f.enabled = String(enabled) !== 'false';
      saveFlow(dir, f);
      return { ok: true, result: `flow ${id} ${f.enabled ? 'enabled' : 'disabled'}`, summary: f.enabled ? 'on' : 'off' };
    },
  }),
  def({
    name: 'flows.remove',
    group: 'flows',
    risk: 'write',
    desc: 'Remove a flow; state dir stays on disk (audit trail) but the runtime stops reacting.',
    params: { id: 'string: flow id' },
    examples: ['flows.remove({id:"ab12cd34ef56"})'],
    async run({ id }, ctx) {
      const dir = hubDir(ctx);
      const f = loadFlow(dir, String(id));
      if (!f) return { ok: false, error: { code: 'no_flow', message: `no flow "${id}"` } };
      f.enabled = false; f.removedAt = new Date().toISOString();
      saveFlow(dir, f);
      if (HUB) await HUB.stopFileTrigger(String(id));
      return { ok: true, result: `flow ${id} disabled+removed (state preserved on disk)`, summary: 'removed' };
    },
  }),
  def({
    name: 'flows.trigger',
    group: 'flows',
    risk: 'exec',
    desc: 'Fire a flow manually (when.type=manual flows, or used by the webhook route /api/flows/hook/<id>). Event context becomes {{.*}} bindings.',
    params: { id: 'string: flow id', payload: 'object: event payload (optional)' },
    examples: ['flows.trigger({id:"ab12cd34ef56", payload:{path:"incoming/report.pdf"}})'],
    async run({ id, payload = {} }, ctx) {
      const session = ctx.session || 'default';
      journal.guard(session, `flows.trigger:${id}`);
      const dir = hubDir(ctx);
      const f = loadFlow(dir, String(id));
      if (!f) return { ok: false, error: { code: 'no_flow', message: `no flow "${id}"` } };
      const ev = { eventHash: eventHash(payload), meta: payload };
      const r = await fire(dir, f, ev, { registry: ctx.registry });
      return { ok: r.ok, result: `${id} → ${r.status}${r.error ? ': ' + r.error : ''}`, meta: r, summary: r.status };
    },
  }),
  def({
    name: 'flows.webhook.recorded',
    group: 'flows',
    risk: 'write',
    desc: 'Server-route helper: record a webhook event for a flow (same dedupe/rate-limit semantics as manual fire).',
    params: { id: 'string: flow id', payload: 'object: webhook payload' },
    async run({ id, payload = {} }, ctx) {
      const dir = hubDir(ctx);
      const f = loadFlow(dir, String(id));
      if (!f) return { ok: false, error: { code: 'no_flow', message: `no flow "${id}"` } };
      const ev = { eventHash: eventHash(payload), meta: payload };
      const r = await fire(dir, f, ev, { registry: ctx.registry });
      return { ok: r.ok, meta: r, result: `webhook ${id} → ${r.status}`, summary: r.status };
    },
  }),
];
