/**
 * V2 goal compiler (master brief section 20).
 *
 * Turns a natural-language objective into a validated structured goal. Two
 * compilers live here: a deterministic one (safe, offline, covers the common
 * objective shapes) and a model adapter that validates model output against
 * the same zod schema before ANYTHING else uses it (brief 112/59: model text
 * is data until proven shape).
 * Assumptions are always marked with inferred:true, never silently confident.
 */
import { z } from 'zod';

export const COMPILER_SCHEMA = 'majin.v2.compiled-goal/v1';

const acceptanceItem = z.object({
  id: z.string().min(1).max(80),
  description: z.string().min(1).max(300),
  verify: z.object({
    kind: z.enum(['file', 'json', 'http', 'pixel', 'dom', 'memory']),
    // spec kept loose here; each verifier enforces its own required fields
    spec: z.object({}).passthrough(),
  }),
  inferred: z.boolean().optional(),
});

export const CompiledGoalSchema = z.object({
  schema: z.literal(COMPILER_SCHEMA),
  objective: z.string().min(1).max(2000),
  deliverables: z.array(z.string().min(1)).max(20),
  acceptance: z.array(acceptanceItem).min(1).max(20),
  risk: z.enum(['low', 'medium', 'high']),
  permissions: z.array(z.string().min(1)).max(20),
  source: z.enum(['deterministic', 'model']),
});

export class InvalidCompilation extends Error {
  constructor(message, issues = []) { super(message); this.name = 'InvalidCompilation'; this.issues = issues; }
}

/** deterministic pattern: "build/create/make ... website/webbplats/portfolio/site" */
export function compileDeterministic(objective) {
  if (typeof objective !== 'string' || !objective.trim()) throw new InvalidCompilation('empty objective');
  const text = objective.trim();
  const lc = text.toLowerCase();

  if (/(build|create|make|bygg|skapa|gör).{0,40}(website|webbplats|web site|site|portfolio|landing|hemsida)/.test(lc)) {
    return CompiledGoalSchema.parse({
      schema: COMPILER_SCHEMA,
      objective: text,
      deliverables: ['runnable website project', 'http preview'],
      acceptance: [
        { id: 'files', description: 'index.html exists in the project', verify: { kind: 'file', spec: { path: 'index.html', contains: '<html' } }, inferred: true },
        { id: 'preview', description: 'http preview responds 200', verify: { kind: 'http', spec: { url: 'http://127.0.0.1:<port>/', status: 200 } }, inferred: true },
      ],
      risk: 'low',
      permissions: ['workspace_write', 'process_launch', 'browser_preview'],
      source: 'deterministic',
    });
  }

  if (/(research|researcha|undersök|search).{0,40}|(sammanställ|report|rapport)/.test(lc)) {
    return CompiledGoalSchema.parse({
      schema: COMPILER_SCHEMA,
      objective: text,
      deliverables: ['research report (markdown)'],
      acceptance: [
        { id: 'report', description: 'report.md exists with sources section', verify: { kind: 'file', spec: { path: 'report.md', contains: '## ' } }, inferred: true },
      ],
      risk: 'low',
      permissions: ['workspace_write', 'web_codeget'],
      source: 'deterministic',
    });
  }

  if (/(blender|3d|render|animation)/.test(lc)) {
    return CompiledGoalSchema.parse({
      schema: COMPILER_SCHEMA,
      objective: text,
      deliverables: ['blender scene/script', 'rendered output'],
      acceptance: [
        { id: 'scene', description: 'scene/script file exists', verify: { kind: 'file', spec: { path: 'scene.py', minBytes: 100 } }, inferred: true },
        { id: 'render', description: 'render output exists (png or mp4)', verify: { kind: 'file', spec: { path: 'output.png', minBytes: 1000 } }, inferred: true },
      ],
      risk: 'medium',
      permissions: ['workspace_write', 'process_launch'],
      source: 'deterministic',
    });
  }

  if (/(jobb|job|ansökan|application|cv)/.test(lc)) {
    return CompiledGoalSchema.parse({
      schema: COMPILER_SCHEMA,
      objective: text,
      deliverables: ['shortlisted openings', 'tailored application drafts'],
      acceptance: [
        { id: 'drafts', description: 'application draft file exists for review', verify: { kind: 'file', spec: { path: 'application-draft.md', minBytes: 200 } }, inferred: true },
      ],
      risk: 'medium',
      permissions: ['workspace_write', 'web_codeget'],
      source: 'deterministic',
    });
  }

  // Fallback: honest, low-confidence generic goal. Never pretend we know the acceptance.
  return CompiledGoalSchema.parse({
    schema: COMPILER_SCHEMA,
    objective: text,
    deliverables: ['matched artifact (determine shape during planning)'],
    acceptance: [
      { id: 'planned', description: 'planning clarifies acceptance before execution (flag: needs plan pass)', verify: { kind: 'file', spec: { path: 'PLAN.md', contains: 'acceptance' } }, inferred: true },
    ],
    risk: 'medium',
    permissions: ['workspace_write'],
    source: 'deterministic',
  });
}

/**
 * compileWithModel(text, modelFn) — modelFn MUST return the compiled JSON object.
 * We validate with the SAME schema; unknown fields are stripped by zod default
 * (strict parse), malformed output throws InvalidCompilation — never repaired
 * into something carrying different intent (brief 4.2 anti-repair rule).
 */
export function compileWithModel(modelJson) {
  const res = CompiledGoalSchema.safeParse(modelJson);
  if (!res.success) throw new InvalidCompilation('model output failed goal schema validation', res.error.issues);
  return res.data;
}
