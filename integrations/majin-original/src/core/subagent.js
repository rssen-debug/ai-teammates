/**
 * MAJIN — subagent.
 * Eget huvud, egna verktyg, ingen historik, litet stegbudschet. Används för
 * parallellt gräv (triagea tre filer, kolla två hypoteser) utan att förorena main.
 */
import { loop } from './loop.js';
import { routeFor } from './router.js';

export async function run({ cfg, task, job = 'tasks', maxSteps, registry, session, emit, memory, providerErrorCap = 4, providerRetries = null }) {
  maxSteps = Number(maxSteps) || Number(cfg.get('agent.subagents.maxSteps')) || 14;
  const route = routeFor(cfg, job);
  const messages = [
    {
      role: 'system',
      content: [
        `You are a subagent inside ${cfg.get('name')}. You get one bounded task and must return a concise, factual result with evidence.`,
        `Tools: ${registry.list().length} available. Job: ${job}, model: ${route?.ref || 'default'}.`,
        'Do the task rather than only describing how to do it. Use tools, verify important findings, recover from errors with a changed approach, and clearly separate facts from uncertainty. Never repeat an identical failed tool call.',
        'Return 3-12 lines: outcome, evidence or paths/values, remaining uncertainty or blocker.',
        memory?.digest?.() ? `Context from memory:\n${memory.digest().slice(0, 900)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
    { role: 'user', content: String(task).slice(0, 6000) },
  ];
  const res = await loop({
    cfg,
    registry,
    messages,
    job,
    maxSteps,
    usage: null,
    ctx: { session: `${session}:sub`, emit: (e) => emit?.({ ...e, sub: true }) },
    onEvent: (e) => emit?.({ ...e, sub: true }),
    label: 'sub',
    providerErrorCap,
    providerRetries,
  });
  return { text: res.text, steps: res.steps, tools: res.toolLog.map((t) => t.tool), usage: res.usage,
    error: res.error, errorKind: res.errorKind, incomplete: Boolean(res.incomplete || res.blocked || res.aborted || res.fatal),
    blocked: res.blocked || null, stopReason: res.stopReason || (res.incomplete ? 'step_limit' : null) };
}
