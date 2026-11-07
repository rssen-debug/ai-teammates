/** Structural integrity of the private durable model-loop checkpoint. */
export function hasApprovalContinuation(pending) {
  const c = pending?.continuation;
  if (c?.v !== 1 || !Array.isArray(c.modelMessages) || !Array.isArray(c.response?.toolCalls) || !Array.isArray(c.toolMessages) || !Array.isArray(c.exposed)) return false;
  if (!Number.isSafeInteger(c.startAt) || c.startAt < 0 || c.startAt >= c.response.toolCalls.length || c.toolMessages.length !== c.startAt) return false;
  if (!Number.isSafeInteger(c.rounds) || c.rounds < 1 || !Number.isSafeInteger(c.toolCallsUsed) || c.toolCallsUsed < 0 || typeof c.finalText !== 'string') return false;
  const call = c.response.toolCalls[c.startAt];
  if (call.id !== pending.callId || call.name !== pending.tool) return false;
  try { return JSON.stringify(JSON.parse(call.argsJson || '{}')) === JSON.stringify(pending.input); }
  catch { return false; }
}
