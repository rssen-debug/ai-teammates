/**
 * MAJIN V5 — Programmatic Capability Inventory & V1–V4 Reuse Adapter (Section 1 & 2).
 *
 * Keeps V1–V4 files 100% protected and untouched while exposing:
 *  - `V5_REUSE_MATRIX`: machine-readable reuse matrix (`capability -> repo/ref/SHA -> file/symbol -> tests -> environment -> decision`)
 *  - `EXTERNAL_RESEARCH_DECISIONS`: machine-readable research records with commit SHA, license, pros/cons, and single-runtime decision
 *  - `adaptV1ToolForV5`: V5 adapter over `src/v4/tools/host.js` with `.passthrough()` on outputSchema so `jobs.search` and `jobs.list` retain `total`, `seenBefore`, `applications`, `counts`, and `rows` (porting the fix from `v4/main` commit `a5d7a99b59b0b7feac8152e65cffba6215428e0f` without modifying V4).
 */
import { z } from 'zod';
import { V1_MODULE_DECISIONS } from '../v4/inventory.js';
import { V1_LANES, adaptV1Tool } from '../v4/tools/host.js';

export const PROTECTED_REFS = Object.freeze({
  v1_main: 'e84b716e79ac4fc3cb443280e56d3f12553c8fc2',
  v2_main: '1ef253fb1f44406c262a290e170902403f68cceb',
  v3_main: 'df678b21dfb784233da8cea25bdc54722a61236a',
  v4_origin_main: 'e59794988795b97b40ec5a90d71e8d1fa71f0d69',
  v4_main_unmerged_fix: 'a5d7a99b59b0b7feac8152e65cffba6215428e0f',
  grand_architect_2c: '89d4c10574eb371a269a0d26fa37bb917e3c6b53',
  grand_architect_swarm: '514ee13d2f2b749e1d20b67e1f710d1b04ffdd74',
});

export const V5_REUSE_MATRIX = Object.freeze([
  {
    capability: 'Provider catalog & chat completions (OpenCode Go, OpenAI, Anthropic, xAI, Ollama)',
    repoRefSha: `rssen-debug/MAJINCLI @ ${PROTECTED_REFS.v4_origin_main}`,
    fileSymbol: 'src/core/provider/{catalog.js,chat.js} -> src/v5/providers.js (ProviderManager)',
    tests: 'test/v5/providers-files-ops.test.js',
    environment: 'Node 22 + HTTPS fetch',
    decision: 'adapt',
  },
  {
    capability: '144 V1 tools across 26 modules &Platsbanken/JobTech search',
    repoRefSha: `rssen-debug/MAJINCLI @ ${PROTECTED_REFS.v4_origin_main} + ${PROTECTED_REFS.v4_main_unmerged_fix}`,
    fileSymbol: 'src/core/tools/jobs.js, src/core/jobs/platsbanken.js -> src/v5/inventory.js (adaptV1ToolForV5)',
    tests: 'test/v5/job-workflow.test.js',
    environment: 'Node 22 + local SQLite/JSON',
    decision: 'adapt',
  },
  {
    capability: 'Goal state machine, TaskGraph DAG, scheduler, receipts & independent verifiers',
    repoRefSha: `rssen-debug/MAJINCLI @ ${PROTECTED_REFS.v2_main}`,
    fileSymbol: 'src/v2/runtime/{goal.js,states.js,dag.js,scheduler.js,receipts.js,verifiers.js}',
    tests: 'test/v5/architect.test.js',
    environment: 'Node 22',
    decision: 'reuse',
  },
  {
    capability: 'User & project memory store (kept separate from procedural skills)',
    repoRefSha: `rssen-debug/MAJINCLI @ ${PROTECTED_REFS.v2_main}`,
    fileSymbol: 'src/v2/memory/store.js (MemoryStore)',
    tests: 'test/v5/learning-engine.test.js',
    environment: 'Node 22 JSON store',
    decision: 'reuse',
  },
  {
    capability: 'Voice STT/TTS capabilities, barge-in & measured latency telemetry',
    repoRefSha: `rssen-debug/MAJINCLI @ ${PROTECTED_REFS.v4_origin_main}`,
    fileSymbol: 'src/v2/voice/*, src/v4/voice.js -> src/v5/voice-controller.js (VoiceController)',
    tests: 'test/v5/providers-files-ops.test.js',
    environment: 'Browser Web Speech + local binary adapters',
    decision: 'adapt',
  },
  {
    capability: 'Procedural learning lifecycle (EXPERIMENTAL -> VERIFIED -> REUSABLE / STALE / FAILED)',
    repoRefSha: `rssen-debug/MAJINCLI @ ${PROTECTED_REFS.v4_origin_main}`,
    fileSymbol: 'src/v4/learning.js -> src/v5/learning-engine.js (LearningEngine)',
    tests: 'test/v5/learning-engine.test.js',
    environment: 'Node 22',
    decision: 'adapt',
  },
  {
    capability: 'File uploads (PDF/DOCX/XLSX/images), streaming >6 MB & portal upload verification',
    repoRefSha: `rssen-debug/MAJINCLI @ ${PROTECTED_REFS.v4_origin_main}`,
    fileSymbol: 'src/v4/uploads.js -> src/v5/files-access.js (FileAndAccessController)',
    tests: 'test/v5/providers-files-ops.test.js',
    environment: 'Node 22',
    decision: 'adapt',
  },
  {
    capability: 'Owner Mode permissions, path policy & untrusted data escalation guard',
    repoRefSha: `rssen-debug/MAJINCLI @ ${PROTECTED_REFS.v4_origin_main}`,
    fileSymbol: 'src/v4/{owner-mode.js,path-access.js} -> src/v5/files-access.js',
    tests: 'test/v5/providers-files-ops.test.js',
    environment: 'Windows 11 / Linux Node 22',
    decision: 'adapt',
  },
  {
    capability: 'Supervisor health checks, failure diagnosis, atomic backup & update rollback',
    repoRefSha: `rssen-debug/MAJINCLI @ ${PROTECTED_REFS.v4_origin_main}`,
    fileSymbol: 'src/v4/{supervisor.js,autonomous-diagnosis.js} -> src/v5/ops.js (V5OpsManager)',
    tests: 'test/v5/providers-files-ops.test.js',
    environment: 'Node 22',
    decision: 'adapt',
  },
  {
    capability: 'Grand Architect clarify-before-touch, replan on failure & hard mission budgets',
    repoRefSha: `rssen-debug/MAJINCLI @ ${PROTECTED_REFS.grand_architect_2c}`,
    fileSymbol: 'feature/grand-architect-2c -> src/v5/architect.js (GrandArchitect)',
    tests: 'test/v5/architect.test.js',
    environment: 'Node 22',
    decision: 'adapt',
  },
  {
    capability: 'Skill Tree (Tool/Skill/Domain/Workflow), autonomous Python/Node SkillBuilder & XP 1–99',
    repoRefSha: `rssen-debug/MAJINCLI @ ${PROTECTED_REFS.v4_origin_main}`,
    fileSymbol: 'src/v5/{xp-engine.js,skill-tree.js,skill-builder.js}',
    tests: 'test/v5/{xp-engine.test.js,skill-tree.test.js}',
    environment: 'Node 22 + Python 3.11',
    decision: 'replace',
  },
  {
    capability: 'Black Box UI, Majin logo & 99-dot matrix progression',
    repoRefSha: `rssen-debug/MAJINCLI @ ${PROTECTED_REFS.v4_origin_main}`,
    fileSymbol: 'src/v5/ui/{index.html,app.css,app.js,dot-matrix.js,strings.js}',
    tests: 'test/v5/ui-blackbox.test.js',
    environment: 'Browser / Electron / Mobile PWA',
    decision: 'replace',
  },
  {
    capability: 'External rssen-debug/majin2026 & rssen-debug/majin2027 repositories',
    repoRefSha: 'rssen-debug/majin2026, rssen-debug/majin2027 (HTTP 403/404 outside token scope)',
    fileSymbol: 'N/A',
    tests: 'test/v5/architect.test.js',
    environment: 'Inaccessible',
    decision: 'exclude',
  },
]);

export const EXTERNAL_RESEARCH_DECISIONS = Object.freeze({
  primaryRuntime: 'MAJIN V5 GrandArchitect over V2 Goal/DAG/Verifiers + V4 Tool Host/Learning (single runtime loop; never stacked with Hermes or DeepSeek loops)',
  sources: [
    {
      name: 'NousResearch/hermes-agent',
      commitSha: '930e5ed557edb25b4b0b8ca3f51679dde3c92eb6',
      license: 'MIT',
      adoptedIdea: 'Closed-loop procedural skill synthesis, self-test, and trajectory sanitization in src/v5/skill-builder.js and src/v5/learning-engine.js',
      runtimeStacked: false,
    },
    {
      name: 'deepseek-ai/deepseek-harness',
      commitSha: '22ddee3792402c3e70ec5f86a63c3e3e895a2f60',
      license: 'MIT',
      adoptedIdea: 'Capability seams, twin LLM adapters (OpenAI/Anthropic), and guardrails in src/v5/providers.js and src/v5/skill-tree.js',
      runtimeStacked: false,
    },
    {
      name: 'OpenCode Go (opencode.ai/docs/go/)',
      commitSha: 'v2-docs-2026-10-25',
      license: 'Commercial API service',
      adoptedIdea: 'First-class OpenCode Go provider with User-Agent: majin-v5/5.0.0, x-opencode-session, and live + fallback model catalog',
      runtimeStacked: false,
    },
    {
      name: 'Agent Skills (agentskills.io)',
      commitSha: 'spec-1.0-2026-10',
      license: 'Apache-2.0 / CC-BY-4.0',
      adoptedIdea: 'SKILL.md frontmatter + 3-stage progressive disclosure (discovery -> activation -> execution) in src/v5/skill-tree.js and src/v5/skill-builder.js',
      runtimeStacked: false,
    },
    {
      name: 'Grok Bot UX (docs.x.ai/grok-bot/*)',
      commitSha: 'docs-2026-10',
      license: 'Reference documentation',
      adoptedIdea: 'Single unified composer (text, voice, attachments), inline previews, and mid-flight steering in src/v5/ui/ and src/v5/architect.js',
      runtimeStacked: false,
    },
  ],
});

/**
 * V5 wrapper around V4's `adaptV1Tool` that preserves extra domain fields
 * (`total`, `seenBefore`, `applications`, `counts`, `rows`) via `.passthrough()`
 * without modifying `src/v4/tools/host.js`.
 */
export function adaptV1ToolForV5(v1Tool, options = {}) {
  const adapted = adaptV1Tool(v1Tool, options);
  const outputSchema = z.object({
    ok: z.boolean(),
    result: z.unknown().optional(),
    output: z.string().optional(),
    error: z.string().optional(),
    meta: z.record(z.string(), z.unknown()).nullable().optional(),
    artifacts: z.array(z.unknown()).optional(),
  }).passthrough();

  return {
    ...adapted,
    outputSchema,
    execute: async (input = {}, execOpts = {}) => {
      const base = await adapted.execute(input, execOpts);
      const raw = await v1Tool.run(input, options.ctx || null);
      return {
        ...raw,
        ...base,
      };
    },
  };
}

export function getV5InventorySummary() {
  return {
    protectedRefs: PROTECTED_REFS,
    v1ModuleDecisionsCount: Object.keys(V1_MODULE_DECISIONS).length,
    v1LanesCount: Object.keys(V1_LANES).length,
    v5ReuseEntriesCount: V5_REUSE_MATRIX.length,
    externalResearch: EXTERNAL_RESEARCH_DECISIONS,
  };
}
