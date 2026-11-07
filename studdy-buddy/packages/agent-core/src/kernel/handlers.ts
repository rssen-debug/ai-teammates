/**
 * Unified kernel — base task handlers.
 *
 * Ported from MAJIN V6 (`src/v6/handlers.js`). A handler receives the durable
 * task and returns a structured outcome. It must not invent success: `ok: true`
 * is a claim the supervisor records, and `receipt` is what the rest of the
 * system treats as evidence.
 */
import type { Handler, HandlerOutcome } from './supervisor.js';

/** Classifies a thrown value into a durable, retryable outcome. */
export function outcomeFromError(error: unknown): HandlerOutcome {
  const record = (error ?? {}) as { code?: unknown; retryable?: unknown; message?: unknown; uncertain?: unknown };
  const uncertain = record.uncertain as { code?: string; reason?: string } | undefined;
  if (uncertain) return { uncertain: { code: uncertain.code || 'UNCERTAIN', reason: uncertain.reason || 'External outcome unknown' } };
  return {
    ok: false,
    retryable: typeof record.retryable === 'boolean' ? record.retryable : true,
    error: {
      code: typeof record.code === 'string' ? record.code : 'TOOL_FAILED',
      messageClass: 'tool',
    },
    summary: String(record.message ?? error).slice(0, 300),
  };
}

/** General-purpose handler that calls one discovered tool through the invoker. */
export function toolHandler(): Handler {
  return async (context) => {
    const name = String(context.task.payload?.tool || '').trim();
    if (!name) {
      return { ok: false, retryable: false, error: { code: 'TOOL_NAME_REQUIRED' }, summary: 'Task payload has no tool name' };
    }
    const args = context.task.payload?.arguments;
    if (args != null && (typeof args !== 'object' || Array.isArray(args))) {
      return { ok: false, retryable: false, error: { code: 'TOOL_ARGUMENTS_INVALID' }, summary: 'arguments must be an object' };
    }
    try {
      const result = (await context.callTool(name, (args ?? {}) as Record<string, unknown>, {
        irreversible: context.task.irreversible === true,
        progressLabel: `tool ${name} started`,
      })) as { record?: { operationId?: string; finishedAt?: string }; result?: { summary?: string } } | null;
      const record = result?.record ?? {};
      const summary = result?.result?.summary;
      return {
        ok: true,
        summary: typeof summary === 'string' ? summary.slice(0, 300) : `${name} completed`,
        evidence: {
          tool: name,
          operationId: record.operationId ?? null,
          finishedAt: record.finishedAt ?? null,
        },
        receipt: record.operationId ? { kind: 'tool-operation', reference: record.operationId } : null,
      };
    } catch (error) {
      return outcomeFromError(error);
    }
  };
}

/** Bounded delay used for health probes and deterministic tests. */
export function delayHandler(): Handler {
  return async (context) => {
    const ms = Math.max(0, Math.min(60_000, Number(context.task.payload?.ms) || 0));
    await context.progress(`delaying ${ms}ms`);
    const step = Math.max(10, Math.min(1000, Math.floor(ms / 4) || 10));
    let waited = 0;
    while (waited < ms) {
      if (context.signal.aborted) throw Object.assign(new Error('Cancelled'), { code: 'CANCELLED' });
      await new Promise((resolve) => setTimeout(resolve, Math.min(step, ms - waited)));
      waited += step;
      await context.progress(`delayed ${Math.min(waited, ms)}ms`);
    }
    const requested = context.task.payload?.summary;
    return { ok: true, summary: typeof requested === 'string' ? requested : `waited ${ms}ms` };
  };
}

export interface HandlersOptions {
  clock?: () => number;
  extra?: Record<string, Handler>;
}

/**
 * Build the default handler set. Optional integrations are injected so tests
 * never touch a network or a browser unless they explicitly provide it.
 */
export function buildHandlers({ clock = Date.now, extra = {} }: HandlersOptions = {}): Record<string, Handler> {
  void clock;
  return {
    tool: toolHandler(),
    'health.delay': delayHandler(),
    ...extra,
  };
}
