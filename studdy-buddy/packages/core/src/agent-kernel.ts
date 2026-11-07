/**
 * Unified autonomous agent.
 *
 * This is the single entry point that replaces three separate loops:
 *
 *  - **MAJIN V6** supplied the durable queue + supervisor (work survives a
 *    crash, budgets are enforced, effects are single-owner).
 *  - **Omega** supplied the rule that a claim without evidence is not success.
 *  - **Legacy Buddy** supplied the real tools and permissions.
 *
 * The agent itself is intentionally boring: it plans once, enqueues, and lets
 * the supervisor execute. There is no unbounded model loop. Every step has a
 * timeout, a bounded attempt count and a verification gate.
 */
import { randomUUID } from 'node:crypto';
import type { ProviderConfig } from '@studdy/shared';
import type { AiRouter } from '@studdy/ai-router';
import { buildHandlers, verifyClaim, type Evidence, type Handler, type Supervisor, type TaskState } from '@studdy/agent-core';
import type { KernelInvoker } from './kernel-runtime.js';

export interface AgentPlanStep {
  /** Tool name from the real catalog. */
  tool: string;
  arguments: Record<string, unknown>;
  /** What the step is supposed to achieve, in the planner's own words. */
  claim: string;
  /**
   * How to prove the step worked. `readbackContains` and `pathExists` are
   * checked against real state; when absent, the tool operation id is the
   * evidence, which proves the tool ran but not that it achieved the claim.
   */
  expect?: { pathExists?: string; readbackContains?: string } | null;
}

export interface AgentPlan {
  goal: string;
  steps: AgentPlanStep[];
  /** How the plan was produced. Never pretends a model ran when it did not. */
  source: 'model' | 'deterministic';
  /** Honest note when the model planner was unavailable. */
  note: string | null;
}

export interface AgentStepResult {
  index: number;
  tool: string;
  claim: string;
  state: TaskState | 'NOT_RUN';
  taskId: string | null;
  operationId: string | null;
  verification: ReturnType<typeof verifyClaim> | null;
  detail: string;
}

export interface AgentRunResult {
  goal: string;
  plan: AgentPlan;
  steps: AgentStepResult[];
  /** True only when every planned step was verified. */
  achieved: boolean;
  reason: string;
  workerId: string;
}

export interface AgentOptions {
  router?: AiRouter | null;
  provider?: ProviderConfig | null;
  invoker: KernelInvoker;
  supervisor: Supervisor;
  /** Reflect the whole run in the durable event log. */
  onStep?: (result: AgentStepResult) => void;
  /** Bounds model planning. */
  planTimeoutMs?: number;
}

/** A goal that needs no model: the user named exactly what to do. */
const DIRECT_GOAL = /^(?:kör|run|prova|testa|check|mät)\s+([a-z][a-z0-9_.-]{2,60})\s*$/i;

const PLANNER_SYSTEM = `You plan discrete tool calls for a desktop agent.

Answer with JSON only:
{"steps":[{"tool":"name.from.catalog","arguments":{},"claim":"what this achieves","expect":{"pathExists":"optional absolute path","readbackContains":"optional text that must be read back"}}]}

Rules:
- use ONLY tools from the catalog
- prefer read-only tools; never invent a tool
- 1-4 steps; each step must be independently verifiable
- if the goal cannot be served by the catalog, answer {"steps":[]}`;

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* try the next shape */
    }
  }
  return null;
}

function isPlanStep(value: unknown): value is AgentPlanStep {
  if (!value || typeof value !== 'object') return false;
  const step = value as Record<string, unknown>;
  if (typeof step.tool !== 'string' || !step.tool.trim()) return false;
  if (step.arguments != null && (typeof step.arguments !== 'object' || Array.isArray(step.arguments))) return false;
  return true;
}

/**
 * Validates a model-produced plan against the real catalog.
 *
 * A model that names a tool which does not exist is not "mostly right"; the
 * step is dropped and the caller is told why, because executing a hallucinated
 * tool is exactly the failure mode this project refuses to ship.
 */
export function validatePlan(raw: unknown, catalog: { name: string }[], goal: string): { plan: AgentPlan; dropped: string[] } {
  const dropped: string[] = [];
  const known = new Set(catalog.map((entry) => entry.name));
  const container = raw as { steps?: unknown } | null;
  const steps = Array.isArray(container?.steps) ? container.steps : [];
  const accepted: AgentPlanStep[] = [];
  for (const step of steps.slice(0, 6)) {
    if (!isPlanStep(step)) {
      dropped.push('malformed step');
      continue;
    }
    if (!known.has(step.tool)) {
      dropped.push(`unknown tool: ${step.tool}`);
      continue;
    }
    accepted.push({
      tool: step.tool,
      arguments: step.arguments ?? {},
      claim: typeof step.claim === 'string' && step.claim.trim() ? step.claim.slice(0, 300) : `run ${step.tool}`,
      expect: step.expect && typeof step.expect === 'object' ? step.expect : null,
    });
  }
  return {
    plan: {
      goal,
      steps: accepted,
      source: 'model',
      note: dropped.length ? `${dropped.length} step(s) rejected: ${dropped.join('; ')}` : null,
    },
    dropped,
  };
}

/**
 * Plans a goal.
 *
 * When a provider is configured the model plans; when it is not, or the model
 * fails, a deterministic planner handles the cases that need no model. The
 * `source` field always tells the truth about which happened.
 */
export async function planGoal(goal: string, options: AgentOptions, catalog: { name: string }[]): Promise<AgentPlan> {
  const text = goal.trim();
  if (!text) return { goal: '', steps: [], source: 'deterministic', note: 'empty goal' };

  // A direct instruction does not need a model and must not cost a request.
  const direct = DIRECT_GOAL.exec(text);
  if (direct?.[1]) {
    const tool = direct[1].toLowerCase();
    if (catalog.some((entry) => entry.name === tool)) {
      return {
        goal: text,
        steps: [{ tool, arguments: {}, claim: `run ${tool}`, expect: null }],
        source: 'deterministic',
        note: 'the goal named a real tool directly',
      };
    }
    return { goal: text, steps: [], source: 'deterministic', note: `no such tool: ${tool}` };
  }

  if (options.router && options.provider) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.planTimeoutMs ?? 45_000);
    try {
      const response = await options.router.complete(options.provider, {
        task: 'cheap',
        maxTokens: 700,
        temperature: 0,
        jsonMode: true,
        cacheable: false,
        signal: controller.signal,
        messages: [
          { role: 'system', content: PLANNER_SYSTEM },
          {
            role: 'user',
            content: `Goal: ${text}\n\nCatalog:\n${catalog.map((entry) => `- ${entry.name}`).join('\n')}`,
          },
        ],
      });
      const parsed = extractJson(response.text ?? '');
      if (parsed) {
        const { plan } = validatePlan(parsed, catalog, text);
        if (plan.steps.length) return plan;
        return { ...plan, note: plan.note ?? 'the model proposed no usable steps' };
      }
      return {
        goal: text,
        steps: [],
        source: 'deterministic',
        note: 'the model did not return parseable JSON; no work was queued',
      };
    } catch (error) {
      return {
        goal: text,
        steps: [],
        source: 'deterministic',
        note: `model planning failed (${error instanceof Error ? error.message.slice(0, 160) : String(error)}); no work was queued`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    goal: text,
    steps: [],
    source: 'deterministic',
    note: 'no provider is configured, so only direct instructions (e.g. "run time.now") can be planned',
  };
}

/**
 * Handler that runs one planned step through the real tool invoker and then
 * subjects the result to the verification gate.
 *
 * The outcome contract is the important part: `ok:true` is only returned when
 * verification passes. A step whose tool ran but whose claim could not be
 * proven is reported as a verification failure, not as success.
 */
export function createStepHandler(): Handler {
  return async (context) => {
    const step = context.task.payload?.step as AgentPlanStep | undefined;
    const tool = String(context.task.payload?.tool || step?.tool || '').trim();
    if (!tool) {
      return { ok: false, retryable: false, error: { code: 'STEP_TOOL_REQUIRED' }, summary: 'planned step has no tool' };
    }
    const args = (context.task.payload?.arguments ?? step?.arguments ?? {}) as Record<string, unknown>;
    interface ToolEnvelope { record?: { operationId?: string; finishedAt?: string }; result?: Record<string, unknown> }
    let result: ToolEnvelope | null = null;
    try {
      result = (await context.callTool(tool, args, {
        irreversible: context.task.irreversible === true,
        progressLabel: `agent step ${tool}`,
      })) as ToolEnvelope;
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      return {
        ok: false,
        retryable: (error as { retryable?: boolean } | null)?.retryable !== false,
        error: { code: code || 'TOOL_FAILED', messageClass: 'tool' },
        summary: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      };
    }

    const operationId = result?.record?.operationId ?? null;
    const payload = result?.result ?? {};
    // Evidence preference: a concrete read-back beats an operation receipt,
    // because a receipt only proves the tool ran.
    const evidence: Evidence | null = (() => {
      if (step?.expect?.pathExists) return { kind: 'file', path: step.expect.pathExists, operationId };
      const readback = typeof payload.readback === 'string' ? payload.readback : null;
      if (readback != null) return { kind: 'readback', readback, operationId };
      if (operationId) return { kind: 'tool-operation', operationId };
      return null;
    })();

    const claim = { statement: step?.claim ?? `run ${tool}`, expect: step?.expect ?? null };
    const verification = verifyClaim(claim, evidence);
    if (!verification.verified) {
      return {
        ok: false,
        retryable: verification.state === 'unverified',
        error: { code: verification.state === 'blocked' ? 'VERIFICATION_BLOCKED' : 'VERIFICATION_FAILED', messageClass: 'verification' },
        summary: `${claim.statement} — ${verification.state}: ${verification.reasons.join(' ')}`.slice(0, 400),
        evidence: { verification: verification.state, operationId },
      };
    }
    return {
      ok: true,
      summary: `${claim.statement} (verified: ${verification.evidenceKind})`,
      receipt: { kind: 'verified-step', reference: operationId ?? verification.evidenceKind },
      evidence: { verification: verification.state, operationId, evidenceKind: verification.evidenceKind },
    };
  };
}

/**
 * Runs one goal end to end: plan -> enqueue -> supervised execution -> verify.
 *
 * The returned `achieved` flag is true only when every planned step completed
 * *and* was verified. Anything else is reported with the real reason.
 */
export async function runGoal(goal: string, options: AgentOptions): Promise<AgentRunResult> {
  const catalog = options.invoker.catalog();
  const plan = await planGoal(goal, options, catalog);
  const workerId = options.supervisor.workerId;

  if (!plan.steps.length) {
    return {
      goal,
      plan,
      steps: [],
      achieved: false,
      reason: plan.note ?? 'no plan could be produced',
      workerId,
    };
  }

  const queue = options.supervisor.queue;
  const taskIds: string[] = [];
  for (const [index, step] of plan.steps.entries()) {
    const tool = options.invoker.tools.get(step.tool);
    const { task } = await queue.add({
      kind: 'agent.step',
      title: `step ${index + 1}: ${step.tool}`,
      payload: { step, tool: step.tool, arguments: step.arguments },
      priority: plan.steps.length - index,
      irreversible: tool?.irreversible === true,
      dedupeKey: null,
    });
    taskIds.push(task.id);
  }

  // Register the step handler for this run without mutating the shared set.
  const handlers = buildHandlers();
  handlers['agent.step'] = createStepHandler();
  for (const [kind, handler] of Object.entries(handlers)) options.supervisor.handlers.set(kind, handler);

  const runSummary = await options.supervisor.run({
    maxTasks: Math.max(plan.steps.length, 1),
    maxRuntimeMs: Math.max(60_000, plan.steps.length * 120_000),
  });

  const results: AgentStepResult[] = [];
  for (const [index, taskId] of taskIds.entries()) {
    const step = plan.steps[index] as AgentPlanStep;
    const task = await queue.get(taskId);
    const operationId = (() => {
      const evidence = task?.result?.evidence as { operationId?: string } | undefined;
      return evidence?.operationId ?? null;
    })();
    const verification = task?.state === 'COMPLETED'
      ? verifyClaim(
        { statement: step.claim, expect: step.expect ?? null },
        operationId ? { kind: 'tool-operation', operationId } : null,
      )
      : null;
    const result: AgentStepResult = {
      index,
      tool: step.tool,
      claim: step.claim,
      state: task?.state ?? 'NOT_RUN',
      taskId,
      operationId,
      verification,
      detail: task?.result?.summary ?? task?.blocked?.reason ?? task?.lastError?.code ?? 'no record',
    };
    results.push(result);
    options.onStep?.(result);
  }

  const allCompleted = results.every((result) => result.state === 'COMPLETED');
  const reason = allCompleted
    ? `all ${results.length} step(s) completed`
    : `stopped: ${runSummary.reason}; ${results.filter((r) => r.state !== 'COMPLETED').length} step(s) did not complete`;
  return { goal, plan, steps: results, achieved: allCompleted, reason, workerId };
}

export function newAgentRunId(): string {
  return `run_${randomUUID().slice(0, 8)}`;
}
