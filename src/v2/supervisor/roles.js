/**
 * V2 role seats (master brief section 7): supervisor assigns a ROLE sticker to
 * every DAG task — planner, researcher, executor, verifier, qa. A role call
 * hits the shared capable model through a bounded, role-scoped chat. Outputs
 * are zod-gated per role; there is no role that outsources its gate.
 *
 * The supervisor stays in charge of ORDER + PARALLELISM (TaskGraph). Roles
 * only produce CONTENT within scope.
 */
import { z } from 'zod';
import { chatValidated, ModelError } from '../model/provider.js';
import { pack } from '../context/engine.js';

export const ROLES = Object.freeze(['planner', 'researcher', 'executor', 'verifier', 'qa']);

export const ROLE_OUTPUT_SCHEMAS = {
  planner: z.object({
    subtasks: z.array(z.object({
      action: z.string().min(2).max(120),
      role: z.enum(ROLES),
      deps: z.array(z.string()).default([]),
    })).min(1).max(20),
    notes: z.string().max(1000).default(''),
  }),
  researcher: z.object({
    facts: z.array(z.object({ claim: z.string().max(500), confidence: z.enum(['low', 'medium', 'high']) })).max(30),
    sources: z.array(z.string().max(300)).max(30),
    summary: z.string().max(2000),
  }),
  executor: z.object({ plan: z.string().max(3000), filesExpected: z.array(z.string()).max(30) }),
  verifier: z.object({ verdict: z.enum(['verified', 'mismatch', 'inconclusive']), notes: z.string().max(1000) }),
  qa: z.object({ checks: z.array(z.object({ id: z.string(), pass: z.boolean() })).max(50), notes: z.string().max(1000) }),
};

/** system prompt per role (kept small, honest about limits) */
function rolePrompt(role) {
  const base = 'You are the ' + role + ' role inside MAJIN V2. Answer with EXACTLY one JSON object matching the requested keys. No prose, no markdown fences.';
  const extra = {
    planner: 'Split the objective into subtasks (action short string, role from planner/researcher/executor/verifier/qa, deps array of action-strings). Never include a verification subtask that depends on itself.',
    researcher: 'Produce facts+cites. Never present guesses as facts: use confidence honestly.',
    executor: 'Produce an execution plan and expected file paths. You never claim to have run anything — describing is not doing.',
    verifier: 'Return a verdict on the presented evidence only. Never trust the executor claims.',
    qa: 'List the checks with pass booleans for the present state only.',
  };
  return `${base}\n${extra[role] || ''}`;
}

/**
 * roleCall(role, userText, provider, {schema?}) -> value
 * Errors surface via ModelError classes; schema mismatch -> INVALID_TOOL_OUTPUT.
 */
/**
 * roleCall(role, userText, provider, {context}) — optional context: engine.pack()
 * sections (goal/acceptance/receipt summaries). When present the packed context
 * is prepended to the system prompt, with the locked token budget and any
 * truncate-markers preserved (never silently dropped).
 */
export async function roleCall(role, userText, provider, { timeoutMs = 60_000, contextSections = null, contextBudget = 2000 } = {}) {
  if (!ROLES.includes(role)) throw new ModelError('INVALID_TOOL_OUTPUT', `unknown role: ${role}`);
  const schema = ROLE_OUTPUT_SCHEMAS[role];
  let system = `${rolePrompt(role)}\nReturn keys: ${Object.keys(schema.shape).join(', ')}`;
  if (Array.isArray(contextSections) && contextSections.length) {
    const packed = pack({ budgetTokens: contextBudget, sections: contextSections });
    system += `\n\nCONTEXT:\n${packed.context}`;
  }
  const res = await chatValidated(provider, [
    { role: 'system', content: system },
    { role: 'user', content: userText },
  ], { schema, timeoutMs });
  return { role, value: res.value, meta: { model: res.model, elapsedMs: res.elapsedMs, provider: provider.name } };
}
