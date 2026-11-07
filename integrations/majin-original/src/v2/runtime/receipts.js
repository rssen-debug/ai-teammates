/**
 * V2 action receipts (master brief section 183/184).
 *
 * Every meaningful action may emit a small machine-readable receipt with a
 * content hash and an explicit `verified` flag. Receipts are the atoms of the
 * evidence graph: goal -> task -> action (receipt) -> observation -> artifact.
 */
import crypto from 'node:crypto';

export const RECEIPT_SCHEMA = 'majin.v2.receipt/v1';

/**
 * Create a receipt. Pure function; the caller supplies facts.
 * `verified` MUST be false unless an independent check (not the executing
 * model's own claim) confirmed the outcome. Callers that have not yet run a
 * verifier should leave the default and flip it later via verify().
 */
export function makeReceipt({
  goalId,
  taskId = null,
  action,
  target = null,
  result,
  evidence = null,
  errorClass = null,
  attempt = 1,
  durationMs = 0,
  at = new Date().toISOString(),
}) {
  if (!goalId) throw new Error('receipt requires goalId');
  if (!action) throw new Error('receipt requires action');
  if (result !== 'success' && result !== 'failure') {
    throw new Error(`receipt result must be 'success' | 'failure', got ${String(result)}`);
  }
  const core = {
    schema: RECEIPT_SCHEMA,
    goalId, taskId, action, target, result, errorClass, attempt, durationMs, at,
  };
  const hash = crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex');
  return Object.freeze({
    ...core,
    id: `rcpt_${hash.slice(0, 16)}`,
    hash,
    verified: false,
    evidence,
  });
}

/**
 * Flip a receipt to verified with the evidence that justifies it.
 * Returns a NEW immutable receipt (original untouched) — evidence chains must
 * be tamper-evident, so verification replaces the hash and keeps `prevHash`.
 */
export function verify(receipt, evidence) {
  if (receipt.verified) return receipt;
  const stamp = new Date().toISOString();
  const core = {
    schema: receipt.schema, goalId: receipt.goalId, taskId: receipt.taskId,
    action: receipt.action, target: receipt.target, result: receipt.result,
    errorClass: receipt.errorClass, attempt: receipt.attempt,
    durationMs: receipt.durationMs, at: receipt.at,
    verified: true, evidence, prevHash: receipt.hash, verifiedAt: stamp,
  };
  const hash = crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex');
  return Object.freeze({ ...receipt, ...core, id: receipt.id, hash });
}
