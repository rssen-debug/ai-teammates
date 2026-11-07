/**
 * V2 tool runner (master brief sections 110-116 + 4.2): the enforced path
 * for every tool invocation.
 *
 * order: locate -> input validate -> policy decision -> consent if held ->
 * execute (timeout) -> output validate -> receipt. Failures surface as
 * kernel-classified ToolError, never as raw messages.
 */
import { ToolError, ToolCall } from './registry.js';

const TIER_DEFAULT = { read: 'ok', write: 'hold', process: 'hold', browser: 'hold', external: 'hold' };

export async function runTool(callRaw, { registry, approvals, mode = 'balanced', timeoutMs = 60_000, telemetry = null, events = null } = {}) {
  const call = ToolCall.parse(callRaw);
  const def = registry.get(call.tool);
  if (!def) throw new ToolError('INVALID_TOOL_OUTPUT', `unknown tool: ${call.tool}`);

  const inResult = def.inputSchema.safeParse(call.input);
  if (!inResult.success) {
    const issue = inResult.error.issues[0];
    const field = issue?.path?.join('.') || '(arguments)';
    throw new ToolError('INVALID_TOOL_INPUT:MAJIN', `tool ${call.tool} input failed schema at ${field}: ${issue?.message}. Correct the named argument using the tool schema.`, { tool: call.tool });
  }

  const tier = TIER_DEFAULT[def.tier] || 'hold';
  const scope = `tool:${call.tool}`;
  if (tier === 'hold') {
    const c = approvals.check(scope, { preflightReason: `tool tier ${def.tier}` });
    if (c.decision !== 'allow') {
      telemetry?.append('consent', { scope, decision: 'waiting', mode });
      return { ok: false, decision: 'waiting', pendingScope: scope, reason: c.note || 'consent pending', tool: call.tool };
    }
    telemetry?.append('consent', { scope, decision: 'used', mode });
  }

  const t0 = Date.now();
  const timedOut = Symbol('timeout');
  let out, timer;
  try {
    out = await Promise.race([
      def.execute(inResult.data),
      new Promise((_, rej) => { timer = setTimeout(() => rej(timedOut), timeoutMs); }),
    ]);
  } catch (err) {
    const cls = err === timedOut ? 'TIMEOUT' : (err.cls || 'UNKNOWN');
    telemetry?.append('task.result', { taskId: call.tool, action: `tool:${call.tool}`, durationMs: Date.now() - t0, result: 'failure', errorCls: cls, attempt: 1 });
    if (err === timedOut) throw new ToolError('TIMEOUT', `tool ${call.tool} exceeded ${timeoutMs}ms`, { tool: call.tool });
    throw err instanceof ToolError ? err : new ToolError(cls, String(err.message || err), { tool: call.tool });
  } finally { clearTimeout(timer); }

  const outResult = def.outputSchema.safeParse(out);
  if (!outResult.success) throw new ToolError('INVALID_TOOL_OUTPUT', `tool ${call.tool} produced schema-mismatching output: ${outResult.error.issues[0]?.message}`, { tool: call.tool });

  telemetry?.append('task.result', { taskId: call.tool, action: `tool:${call.tool}`, durationMs: Date.now() - t0, result: 'success', attempt: 1 });
  events?.emit('task.updated', { taskId: call.tool, to: 'done', durationMs: Date.now() - t0 });
  return { ok: true, decision: 'done', data: outResult.data, durationMs: Date.now() - t0, tool: call.tool };
}
