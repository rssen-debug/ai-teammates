/**
 * MAJIN — meta tools: tools that describe the system itself.
 */
import { def } from './registry.js';

export const metaTools = [
  def({
    name: 'tools.search',
    group: 'meta',
    risk: 'read',
    desc: 'find the right capability before guessing a tool name — deterministic zero-LLM search over every registered tool: give it a plain-words goal, get back the matching tools with their side-effect class and parameters',
    params: { q: 's: what you want to do, in plain words — verbs and nouns help most', limit: 'n? max matches, optional (default: 6)' },
    required: ['q'],
    examples: ['tools.search q:"fill a form in the browser"', 'tools.search q:"record screen and convert to gif" limit:3'],
    run: async ({ q, limit }, ctx) => {
      const hits = ctx.registry.search(q, { limit });
      if (!hits.length) {
        return { ok: true, count: 0, matches: [], hint: `no tool matches "${String(q).slice(0, 60)}" — answer in plain words, or rephrase the goal with different nouns` };
      }
      return {
        ok: true,
        count: hits.length,
        matches: hits.map((h) => ({
          name: h.id,
          desc: h.desc,
          sideEffects: h.sideEffects,
          tags: h.tags.slice(0, 6),
          params: Object.keys(h.inputs.properties || {}),
        })),
      };
    },
  }),
];
