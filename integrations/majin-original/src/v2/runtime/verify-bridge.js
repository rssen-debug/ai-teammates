/**
 * V2 bridge: verifier registry -> goal receipts.
 *
 * The executor never flips its own receipts to verified. This bridge does:
 * it runs an independent verifier, registers a receipt tied to the goal's
 * acceptance item, and only marks verified when the check actually passed.
 * Either way the result is receipted — a failure receipt IS evidence too.
 */
import { runVerifier } from './verifiers.js';

/**
 * @param {Goal} goal
 * @param {object} o
 * @param {string} o.acceptanceId  which acceptance item this proves
 * @param {string} o.kind          verifier kind ('file'|'json'|'http'|'pixel'|'dom'|'memory')
 * @param {object} o.spec          verifier spec
 * @param {string} [o.taskId]      DAG task this proof belongs to
 * @param {number} [o.attempt]
 */
export async function verifyAcceptance(goal, { acceptanceId, kind, spec, taskId = null, attempt = 1 }) {
  if (!goal) throw new Error('verifyAcceptance requires a goal');
  if (!kind) throw new Error('verifyAcceptance requires kind');
  const outcome = await runVerifier(kind, spec);
  const receipt = goal.addReceipt({
    taskId,
    action: `verify:${kind}`,
    target: spec.path || spec.pngPath || spec.url || null,
    result: outcome.verified ? 'success' : 'failure',
    evidence: outcome.evidence || null,
    errorClass: outcome.error ? outcome.error.cls : null,
    attempt,
    acceptanceId: acceptanceId || undefined,
  });
  if (!outcome.verified) {
    return { verified: false, receipt, error: outcome.error };
  }
  const verified = goal.verifyReceipt(receipt.id, outcome.evidence);
  return { verified: true, receipt: verified };
}
