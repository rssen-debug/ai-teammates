/**
 * MAJIN — agentverktyg: plan, delegering, manuell MOA.
 * Delegering = en isolerad subagent med eget stegbudschet och egen kontext.
 */
import { def } from './registry.js';
import { run } from '../subagent.js';

export const agentTools = [
  def({
    name: 'agent.plan',
    group: 'agent',
    risk: 'read',
    desc: 'Write and update the visible work list for the session. Use it for more than 3 steps; the UI shows it live.',
    params: {
      items: 'array: [{"text":"do this","status":"todo|doing|done|blocked"}] (optional)',
      mode: 'string: replace | merge [replace|merge] (optional)',
      note: 'string: briefly why the plan looks like this (optional)',
    },
    async run({ items = [], mode = 'replace', note }, ctx) {
      const prev = mode === 'merge' ? ctx.plan || ctx.getPlan?.() || [] : [];
      const norm = items.map((it, i) => ({
        id: it.id || `t${prev.length + i + 1}`,
        text: String(it.text || it.title || '').slice(0, 300),
        status: ['todo', 'doing', 'done', 'blocked'].includes(it.status) ? it.status : 'todo',
      }));
      let plan = [...prev, ...norm];
      const seen = new Set();
      plan = plan.filter((p) => !seen.has(p.id) && seen.add(p.id));
      ctx.plan = plan;
      ctx.setPlan?.(plan, note);
      const done = plan.filter((p) => p.status === 'done').length;
      return { result: `plan (${done}/${plan.length} done)${note ? ` — ${note}` : ''}\n${plan.map((p) => `[${p.status === 'done' ? 'x' : p.status === 'doing' ? '~' : p.status === 'blocked' ? '!' : ' '}] ${p.text}`).join('\n')}`, meta: { plan }, summary: `plan ${done}/${plan.length} done` };
    },
  }),

  def({
    name: 'agent.delegate',
    group: 'agent',
    risk: 'read',
    desc: 'Send a sub-problem to a subagent with its own step budget (it sees your tools but not your history). Use it for parallel digging — e.g. "analyse these 3 files".',
    params: {
      tasks: 'array: [{"task":"beskriv uppgiften","job":"code|re|tasks|research","maxSteps":12}] (optional)',
      parallel: 'boolean: run them all at once (default true) (optional)',
    },
    examples: ['agent.delegate({tasks:[{task:"triage a.exe",job:"re"},{task:"triage b.exe",job:"re"}]})'],
    async run({ tasks = [], parallel = true }, ctx) {
      const max = ctx.cfg.get('agent.subagents.maxParallel') || 3;
      const list = (Array.isArray(tasks) ? tasks : [tasks]).slice(0, Math.max(1, max)).map((t) => (typeof t === 'string' ? { task: t } : t));
      if (!list.length) throw new Error('tomma tasks');
      const exec = async (t) => {
        const t0 = Date.now();
        try {
          const res = await run({ cfg: ctx.cfg, task: String(t.task).slice(0, 4000), job: t.job, maxSteps: Number(t.maxSteps) || Number(ctx.cfg.get('agent.subagents.maxSteps')) || 14, registry: ctx.registry, session: `${ctx.session}-sub-${Math.random().toString(36).slice(2, 6)}`, emit: ctx.emit, memory: ctx.memory });
          const ok = !res.error && !res.incomplete && !res.blocked && String(res.text || '').trim().length > 0;
          return { task: t.task, ok, answer: res.text, error: ok ? null : res.error || res.blocked || res.stopReason || 'subagent incomplete',
            incomplete: Boolean(res.incomplete), steps: res.steps, ms: Date.now() - t0, tools: res.tools };
        } catch (err) {
          return { task: t.task, ok: false, error: err.message, ms: Date.now() - t0 };
        }
      };
      const out = parallel ? await Promise.all(list.map(exec)) : [];
      if (!parallel) for (const t of list) out.push(await exec(t));
      const body = out.map((r, i) => `--- subagent ${i + 1}: ${r.task.slice(0, 90)}\n${r.ok ? r.answer : `FEL: ${r.error}`}\n(${r.steps || 0} steg, ${((r.ms || 0) / 1000).toFixed(1)}s)`).join('\n\n');
      return { result: `${out.length} subagenter:\n\n${body}`, meta: { count: out.length, failed: out.filter((x) => !x.ok).length }, summary: `${out.length} subagenter klara` };
    },
  }),

  def({
    name: 'agent.moa',
    group: 'agent',
    risk: 'read',
    desc: 'Run an extra Mixture-of-Agents round on a sub-problem (several models in parallel + an aggregator). Use for hard decisions, not for everything.',
    params: { question: 'string: the sub-question', context: 'string: the background it needs (optional)', width: 'number: how many references (default: config)' },
    async run({ question, context, width }, ctx) {
      const { run: moaRun } = await import('../moa.js');
      const res = await moaRun({ cfg: ctx.cfg, question: String(question), context: context ? [{ role: 'system', content: String(context).slice(0, 6000) }] : [], job: ctx.cfg.get('routing.auto') === false ? 'analysis' : 'analysis', forceWidth: width ? Number(width) : undefined, emit: ctx.emit });
      return {
        result: `MOA (enighet ${res.agreement?.score ?? '-'}${res.escalated ? ', eskalerade' : ''}):\n${res.answer}\n\nReferenser: ${res.refs.map((r) => `${r.ref}${r.error ? ' ✗' : ` ${r.text.length}t`}`).join(', ')}`,
        meta: { agreement: res.agreement, escalated: res.escalated, ms: res.elapsedMs },
        summary: `MOA answer (agreement ${res.agreement?.score ?? '?'})`,
      };
    },
  }),

  def({
    name: 'agent.approve',
    group: 'agent',
    risk: 'read',
    desc: 'Answer a pending confirmation in the UI (approve/deny). Only when the user explicitly told you to.',
    params: { id: 'string: approval id', approved: 'boolean: approve?', note: 'string: why (optional)' },
    async run({ id, approved, note }, ctx) {
      const { approvals } = await import('../guard.js');
      const ok = approvals.respond(String(id), Boolean(approved), note);
      return { ok, result: ok ? `${approved ? 'approved' : 'declined'} ${id}` : `no pending request with id ${id} (maybe already answered)`, meta: { pending: approvals.list().map((p) => p.id) } };
    },
  }),
];
