/**
 * MAJIN V6 — adapter between the supervisor and the existing V5 CodexDriver.
 *
 * The driver owns the operation ledger and the worker process. V6 only adds
 * task-level bookkeeping. No second model runtime is created here.
 */
export class ToolInvocationError extends Error {
  constructor(message, { code = 'TOOL_FAILED', uncertain = false, retryable = true, details = null } = {}) {
    super(message);
    this.name = 'ToolInvocationError';
    this.code = code;
    this.uncertain = uncertain;
    this.retryable = retryable;
    this.details = details;
  }
}

const PERMANENT_CODES = new Set([
  'UNKNOWN_TOOL', 'TOOL_NOT_FOUND', 'PERMISSION_DENIED', 'PATH_DENIED', 'VALIDATION_ERROR', 'INVALID_ARGUMENTS',
]);

export function classifyDriverResult(record) {
  if (!record || typeof record !== 'object') {
    return new ToolInvocationError('Tool driver returned no record', { code: 'TOOL_NO_RECORD' });
  }
  const status = record.status;
  if (status === 'completed') return { ok: true, record, result: record.result ?? null };
  if (status === 'uncertain') {
    return new ToolInvocationError(record.blocker || 'The external outcome is uncertain', {
      code: record.errorCode || 'TOOL_UNCERTAIN', uncertain: true, retryable: false, details: record.details || null,
    });
  }
  if (status === 'running') {
    return new ToolInvocationError('Tool did not finish', { code: 'TOOL_STILL_RUNNING', retryable: false });
  }
  const code = record.errorCode || 'TOOL_FAILED';
  return new ToolInvocationError(record.blocker || `Tool failed (${status || 'unknown'})`, {
    code, retryable: !PERMANENT_CODES.has(code), details: record.details || null,
  });
}

export function createToolInvoker({ driver = null, callToolFn = null, log = null, onCancel = null } = {}) {
  if (!driver && !callToolFn) throw new Error('createToolInvoker requires a driver or a callTool function');
  return async function invoke(name, args = {}, { operationId, signal } = {}) {
    if (!operationId) throw new ToolInvocationError('operationId is required', { code: 'OPERATION_ID_REQUIRED', retryable: false });
    if (signal?.aborted) throw new ToolInvocationError('Cancelled before the tool started', { code: 'CANCELLED', retryable: false });
    const onAbort = () => { driver?.cancel(operationId, 'CANCELLED').catch(() => {}); onCancel?.(operationId); };
    if (signal?.addEventListener) signal.addEventListener('abort', onAbort, { once: true });
    try {
      const response = callToolFn
        ? await callToolFn(name, { ...args, operationId })
        : await driver.call(name, { ...args, operationId });
      const record = response?.structuredContent || response;
      const result = classifyDriverResult(record);
      if (result instanceof Error) throw result;
      return result;
    } catch (error) {
      if (error instanceof ToolInvocationError) throw error;
      throw new ToolInvocationError(String(error?.message || error).slice(0, 400), {
        code: error?.code || 'TOOL_INVOKE_FAILED',
        retryable: !PERMANENT_CODES.has(error?.code),
      });
    } finally {
      signal?.removeEventListener?.('abort', onAbort);
    }
  };
}
