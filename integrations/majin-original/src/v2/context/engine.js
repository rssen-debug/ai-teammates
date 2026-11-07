/**
 * V2 context engine (master brief section 27).
 *
 * The model must receive the SMALLEST context sufficient for the current
 * step. Sources get priorities; packing is budget-aware (rough token estimate:
 * chars/4), duplicates are dropped, large sections are cut from the tail with
 * an explicit marker the model can see (truncated, never silently missing).
 */

/** crude-but-documented estimator; 4 chars/token is the deliberately conservative rule of thumb */
export const estimateTokens = (s) => Math.ceil(String(s || '').length / 4);

export const PRIORITIES = Object.freeze({
  goal: 100,           // the objective itself always ships
  task: 90,            // current task contract
  evidence: 80,        // receipts/verifications from this run
  memory_relevant: 70, // search hits for current step
  project_summary: 50, // compact repo/project description
  file_excerpt: 40,    // targeted reads (never whole files by default)
  conversation_summary: 30,
});

/**
 * pack({budgetTokens, sections}) -> { context, tokens, dropped, truncated }
 * sections: [{ name, priority, text, essential? }] — essential sections
 * prioritize over budget (they are never dropped, only tail-truncated).
 */
export function pack({ budgetTokens = 8000, sections = [] } = {}) {
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) throw new Error('pack requires a positive budgetTokens');
  const sorted = [...sections].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  const kept = [];
  const dropped = [];
  const truncated = [];
  let used = 0;

  for (const s of sorted) {
    const text = s.text == null ? '' : String(s.text);
    if (!text) continue;
    const tokens = estimateTokens(text);
    if (used + tokens <= budgetTokens) {
      kept.push({ name: s.name, text });
      used += tokens;
      continue;
    }
    if (s.essential) {
      const remaining = Math.max(0, budgetTokens - used);
      const head = text.slice(0, remaining * 4);
      kept.push({ name: s.name, text: head ? `${head}\n[truncated: ${text.length - head.length} chars elided]` : '' });
      truncated.push(s.name);
      used = budgetTokens;
      continue;
    }
    dropped.push(s.name);
  }

  const context = kept.map((k) => `## ${k.name}\n${k.text}`).join('\n\n');
  return { context, tokens: estimateTokens(context), dropped, truncated };
}

/**
 * buildTaskContext — assemble per-step context from goal + DAG task + memory.
 * Pure assembly; callers pass already-retrieved memory hits so this stays a
 * pure function (testable without I/O).
 */
export function buildTaskContext({ goal, task = null, acceptance = null, receipts = [], memoryHits = [], projectSummary = null, budgetTokens = 8000 }) {
  if (!goal) throw new Error('buildTaskContext requires a goal');
  const sections = [
    { name: 'goal', priority: PRIORITIES.goal, essential: true, text: goal.objective },
  ];
  if (task) sections.push({ name: 'task', priority: PRIORITIES.task, essential: true, text: JSON.stringify({ id: task.id, action: task.action }) });
  if (acceptance && acceptance.length) {
    sections.push({ name: 'acceptance', priority: PRIORITIES.goal - 1, essential: true, text: acceptance.map((a) => `- ${a.id}: ${a.description}`).join('\n') });
  }
  if (receipts.length) {
    sections.push({ name: 'evidence', priority: PRIORITIES.evidence, text: receipts.map((r) => `[${r.verified ? 'V' : ' '}] ${r.action} ${r.target || ''} -> ${r.result}`).join('\n') });
  }
  for (const m of memoryHits) {
    sections.push({ name: `memory:${m.key}`, priority: PRIORITIES.memory_relevant, text: m.text });
  }
  if (projectSummary) sections.push({ name: 'project_summary', priority: PRIORITIES.project_summary, text: projectSummary });
  return pack({ budgetTokens, sections });
}
