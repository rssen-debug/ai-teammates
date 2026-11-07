/**
 * MAJIN V6 — task handlers.
 *
 * A handler receives the durable task and returns a structured outcome. It
 * must not invent success: `ok: true` is a claim the supervisor records, and
 * `receipt` is what the rest of the system treats as evidence.
 */
import { ToolInvocationError } from './tool-invoker.js';

/** General-purpose handler that calls one discovered MAJIN tool. */
export function toolHandler() {
  return async (ctx) => {
    const name = String(ctx.task.payload?.tool || '').trim();
    if (!name) return { ok: false, retryable: false, error: { code: 'TOOL_NAME_REQUIRED' }, summary: 'Task payload has no tool name' };
    const args = ctx.task.payload?.arguments;
    if (args != null && (typeof args !== 'object' || Array.isArray(args))) {
      return { ok: false, retryable: false, error: { code: 'TOOL_ARGUMENTS_INVALID' }, summary: 'arguments must be an object' };
    }
    try {
      const result = await ctx.callTool(name, args || {}, {
        irreversible: ctx.task.irreversible === true,
        progressLabel: `tool ${name} started`,
      });
      const record = result?.record || {};
      const summary = result?.result?.summary ?? result?.result?.result?.summary;
      return {
        ok: true,
        summary: typeof summary === 'string' ? summary.slice(0, 300) : `${name} completed`,
        evidence: {
          tool: name,
          operationId: record.operationId || null,
          finishedAt: record.finishedAt || null,
        },
        receipt: record.operationId ? { kind: 'tool-operation', reference: record.operationId } : null,
      };
    } catch (error) {
      if (error instanceof ToolInvocationError && error.uncertain) {
        return { uncertain: { code: error.code, reason: error.message } };
      }
      return {
        ok: false,
        retryable: error instanceof ToolInvocationError
          ? error.retryable
          : (typeof error?.retryable === 'boolean' ? error.retryable : true),
        error: { code: error?.code || 'TOOL_FAILED', messageClass: 'tool' },
        summary: String(error?.message || error).slice(0, 300),
      };
    }
  };
}

/** Bounded delay used for health probes and deterministic tests. */
export function delayHandler() {
  return async (ctx) => {
    const ms = Math.max(0, Math.min(60000, Number(ctx.task.payload?.ms) || 0));
    await ctx.progress(`delaying ${ms}ms`);
    const step = Math.max(10, Math.min(1000, Math.floor(ms / 4) || 10));
    let waited = 0;
    while (waited < ms) {
      if (ctx.signal.aborted) throw Object.assign(new Error('Cancelled'), { code: 'CANCELLED' });
      await new Promise((resolve) => setTimeout(resolve, Math.min(step, ms - waited)));
      waited += step;
      await ctx.progress(`delayed ${Math.min(waited, ms)}ms`);
    }
    return { ok: true, summary: ctx.task.payload?.summary || `waited ${ms}ms` };
  };
}

/**
 * Build the default handler set. Optional integrations are injected so tests
 * never touch a network, Gmail or a browser unless they explicitly provide it.
 */
export function buildHandlers({ hunter = null, submitAdapter = null, clock = Date.now } = {}) {
  const handlers = {
    'tool': toolHandler(),
    'health.delay': delayHandler(),
  };

  if (hunter) {
    handlers['job.discover'] = async (ctx) => {
      const { candidateId, query, limit } = ctx.task.payload || {};
      const result = await hunter.discover({ candidateId, query, limit, log: ctx.log });
      if (!result.ok) return { ok: false, retryable: result.retryable !== false, error: result.error, summary: result.summary };
      return { ok: true, summary: `Discovered ${result.discovered} jobs (${result.newJobs} new)`, evidence: result.evidence };
    };
    handlers['job.evaluate'] = async (ctx) => {
      const result = await hunter.evaluate({ applicationId: ctx.task.payload?.applicationId, candidateId: ctx.task.payload?.candidateId });
      if (!result.ok) return { ok: false, retryable: result.retryable !== false, error: result.error, summary: result.summary };
      return { ok: true, summary: result.summary, evidence: result.evidence };
    };
    handlers['job.submit'] = async (ctx) => {
      if (!submitAdapter) {
        return {
          blocked: {
            code: 'SUBMISSION_ADAPTER_NOT_CONFIGURED',
            reason: 'No authorized employer-portal submission adapter is configured. Discovery, matching and approval can run, but no application is sent.',
            requiresOwner: true,
          },
        };
      }
      if (ctx.task.irreversible !== true) {
        return { ok: false, retryable: false, error: { code: 'SUBMISSION_NOT_MARKED_IRREVERSIBLE' }, summary: 'Refusing to submit without an irreversible task declaration' };
      }
      return submitAdapter(ctx);
    };
    handlers['gmail.verify'] = async (ctx) => {
      const result = await hunter.checkVerificationEmail({ applicationId: ctx.task.payload?.applicationId });
      if (!result.ok) return { ok: false, retryable: result.retryable !== false, error: result.error, summary: result.summary };
      return { ok: true, summary: result.summary, evidence: result.evidence };
    };
  }
  void clock;
  return handlers;
}
