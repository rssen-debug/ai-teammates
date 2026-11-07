/**
 * MAJIN W2 RESEARCH — registry tool skin over src/core/research.js.
 * Uses web.search + web.fetch from the tool belt at runtime; the engine itself
 * stays injection-testable (offline fixtures).
 */
import path from 'node:path';
import { def } from './registry.js';
import { run as researchRun } from '../research.js';
import { journal } from '../browser.js';

export const researchTools = [
  def({
    name: 'research.run',
    group: 'research',
    risk: 'read',
    desc: 'Run a full research pipeline (PLAN → SEARCH → FETCH → EXTRACT → CROSS-CHECK → SYNTHESIZE → VERIFY) with a source ledger and contradiction flags. Returns the report markdown plus artifact paths. Never fabricates sources; every claim binds to an actually fetched URL.',
    params: {
      question: 'string: the research question',
      maxSources: 'string: max candidate sources to fetch (optional, default 6)',
      offline: 'string: only "true" — provides forbidden and the run refuses real network (optional)',
    },
    examples: ['research.run({question:"what changed in ollama windows serve 2026"})'],
    async run({ question, maxSources = 6 }, ctx) {
      const session = ctx.session || 'default';
      journal.guard(session, `research.run:${String(question).slice(0, 60)}`);
      const searchFn = async (q, { count = 5 } = {}) => {
        const r = await ctx.registry.exec('web.search', { query: q, count }, { ...ctx, session, step: 1 });
        if (!r.ok) throw new Error(r.error?.message || 'web.search failed');
        const body = String(r.result || '');
        const urls = [...body.matchAll(/\n\s{0,4}(https?:\/\/[^\s)>"]+)/g)].map((m) => m[1]);
        const titles = body.split(/\n/).filter((l) => /^\s*\d+\.\s/.test(l)).map((l) => l.replace(/^\s*\d+\.\s*/, '').trim());
        return urls.slice(0, count).map((u, i) => ({ url: u, title: titles[i] || '', snippet: '' }));
      };
      const fetchFn = async (url, { maxChars = 60000 } = {}) => {
        const r = await ctx.registry.exec('web.fetch', { url, maxChars }, { ...ctx, session, step: 1 });
        if (!r.ok) throw new Error(r.error?.message || `fetch failed`);
        return String(r.meta?.text || r.result || '');
      };
      const artifactsDir = path.join(ctx.cfg.get('workspace') || process.cwd(), 'research', new Date().toISOString().replace(/[:.]/g, '-'));
      const out = await researchRun(String(question || ''), { searchFn, fetchFn, maxSources: Math.max(2, Math.min(10, Number(maxSources) || 6)), artifactsDir });
      if (!out.ok) return { ok: false, error: { code: out.error?.code || 'research_failed', message: out.error?.message || 'pipeline halted' }, meta: { progress: out.progress || [] } };
      const head = out.report.split('\n').slice(0, 6).join('\n');
      return {
        ok: true,
        result: `${out.stats.findings} findings · ${out.stats.conflicted} contradictions · ${out.sources.length} sources\n\n${head}\n…\n\nreport: ${out.paths.report}`,
        meta: out,
        summary: `research ${out.stats.findings} findings/${out.sources.length} sources`,
      };
    },
  }),
];
