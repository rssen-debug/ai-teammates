/**
 * V2 compiler router (master brief 4.2/20/59): chooses where a structured
 * goal comes from. Deterministic compiler is the zero-dependency default.
 * When a model provider is supplied, the model may author the goal — but the
 * output passes the SAME zod schema, permission allowlist and risk enums,
 * and the router stamps source itself (never trusts the model's claims).
 * Failed model attempts fall back to deterministic — loudly, with the
 * failure classification recorded on the goal, never silently.
 */
import { compileDeterministic, compileWithModel, CompiledGoalSchema, InvalidCompilation, COMPILER_SCHEMA } from './goal-compiler.js';
import { chatValidated, ModelError } from '../model/provider.js';
import { z } from 'zod';

/** hard allowlist: the model may request permissions ONLY from this vocabulary */
export const KNOWN_PERMISSIONS = Object.freeze([
  'workspace_write', 'process_launch', 'browser_preview',
  'web_codeget', 'execute_tools', 'ask_for_consent',
]);

/** sanitize raw model goal: clamp permissions to known vocabulary, stamp provenance fields ourselves */
function sanitizeModelGoal(raw) {
  const permissions = (raw.permissions || []).filter((p) => KNOWN_PERMISSIONS.includes(p));
  return { ...raw, schema: COMPILER_SCHEMA, permissions, source: 'model' };
}

const MODEL_PROMPT = (text) => [
  { role: 'system', content:
    'Compile the user objective into EXACTLY one JSON object with keys: objective (string), deliverables (array of short strings), acceptance (array of {id, description, verify:{kind one of file|json|http|pixel|dom, spec object}, inferred boolean}), risk (low|medium|high) and permissions from this allowlist only: workspace_write, process_launch, browser_preview, web_codeget, execute_tools, ask_for_consent. No prose. JSON only.' },
  { role: 'user', content: text },
];

/**
 * compileGoal(text, { provider = null, allowModel = true }) -> { goal, meta }
 * meta: { source: 'model'|'deterministic', fallbackFrom?: <class>, elapsedMs }
 */
export async function compileGoal(objective, { provider = null, allowModel = true } = {}) {
  if (provider && allowModel) {
    const t0 = Date.now();
    try {
      const res = await chatValidated(provider, MODEL_PROMPT(objective), { schema: z.object({}).passthrough() });
      const goal = compileWithModel(sanitizeModelGoal(res.value));
      return { goal, meta: { source: 'model', elapsedMs: res.elapsedMs, provider: provider.name } };
    } catch (err) {
      const cls = err instanceof ModelError ? err.cls : (err instanceof InvalidCompilation ? 'INVALID_TOOL_OUTPUT' : 'MODEL_FAILURE');
      const goal = compileDeterministic(objective);
      return { goal, meta: { source: 'deterministic', fallbackFrom: cls, elapsedMs: Date.now() - t0 } };
    }
  }
  const goal = compileDeterministic(objective);
  return { goal, meta: { source: 'deterministic', elapsedMs: 0 } };
}
