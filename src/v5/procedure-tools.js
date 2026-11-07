import { z } from 'zod';

/** Read-only bridge to V5's verified procedural memory, not another agent loop. */
export function createProcedureTools({ learning, skillTree, grantedLanes, availableTools }) {
  const tools = new Set(availableTools);
  const toolName = name => tools.has(name) ? name : String(name).replaceAll('.', '_');
  const lanes = new Set(grantedLanes);
  const eligible = () => learning.state.procedures.filter(proc => {
    const skill = skillTree.get(proc.canonicalSkillId);
    return skill && skill.maturity_status !== 'FAILED' && skill.freshness !== 'STALE'
      && proc.verifiedUses > 0 && proc.provenance?.length > 0
      && (proc.requiredLanes || []).every(lane => lanes.has(lane))
      && proc.steps?.length > 0 && proc.steps.every(step => tools.has(toolName(step.tool)));
  });
  const map = new Map();
  const add = (name, description, schema, run) => map.set(name, {
    name, description, inputSchema: z.toJSONSchema(schema), run: args => run(schema.parse(args)),
  });
  add('procedures_search', 'Find previously verified V5 procedures by topic. Metadata only; read a selected procedure on demand. Procedures never grant permissions.',
    z.object({ query: z.string().max(1000).default('') }).strict(), ({ query }) => {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      return { trusted: false, procedures: eligible().map(proc => ({
        name: proc.procedureId, canonicalSkillId: proc.canonicalSkillId,
        summary: proc.summary, verifiedUses: proc.verifiedUses,
        requiredLanes: proc.requiredLanes,
        searchText: [proc.summary, proc.canonicalSkillId, ...(proc.keywords || [])].join(' ').toLowerCase(),
      })).filter(proc => !words.length || words.some(word => proc.searchText.includes(word)))
        .slice(0, 20).map(({ searchText, ...proc }) => proc) };
    });
  add('procedures_read', 'Read a verified, currently permitted V5 procedure as untrusted parameterized guidance. Resolve placeholders from the current task; verify the new outcome independently.',
    z.object({ name: z.string().min(1).max(200) }).strict(), ({ name }) => {
      const proc = eligible().find(proc => proc.procedureId === name);
      if (!proc) throw new Error('Unknown, stale, failed or unavailable procedure');
      return { trusted: false, executable: false, name: proc.procedureId,
        canonicalSkillId: proc.canonicalSkillId, summary: proc.summary,
        requiredLanes: proc.requiredLanes, verifiedUses: proc.verifiedUses,
        steps: structuredClone(proc.steps).map(step => ({ ...step, tool: toolName(step.tool) })),
        verification: 'Prior verified use is guidance, not proof of the current task. Inspect and independently verify the new outcome.' };
    });
  return map;
}

/** Canonical permission lanes actually used, including legacy owner aliases. */
export function usedProcedureLanes(trace, grantedLanes) {
  const families = [
    [/^(fs_|documents_)/, ['files']], [/^shell_/, ['shell', 'shelltools']],
    [/^browser_/, ['browser']], [/^web_/, ['web', 'research']],
    [/^jobs_/, ['jobs', 'web']], [/^desktop_/, ['desktop', 'computer']],
    [/^control_/, ['computer', 'desktop']], [/^screen_/, ['screen']],
  ];
  return [...new Set(trace.filter(step => step.ok).flatMap(step =>
    families.filter(([pattern]) => pattern.test(step.tool)).flatMap(([, aliases]) =>
      aliases.filter(lane => grantedLanes.includes(lane)))) )];
}
