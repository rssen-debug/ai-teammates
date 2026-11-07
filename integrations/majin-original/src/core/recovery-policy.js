/** Deterministic recovery policy: never assume an external side effect happened. */
export function recoveryDecision(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return { action: 'inspect', reason: 'missing-step' };
  // Pending/completed steps without an explicit risk must never auto-resume.
  if (!Object.hasOwn(step, 'risk') || !Object.hasOwn(step, 'status')) return { action: 'inspect', reason: 'missing-metadata' };
  // Never skip a side-effecting step merely because arbitrary text claims evidence.
  // Require explicit verification provenance from a trusted verifier.
  if (step.status === 'verified' && step.risk === 'read' && typeof step.evidence === 'string' && step.evidence.trim() && step.verifiedBy === 'tool-result' && step.verification === 'passed') {
    return { action: 'skip', reason: 'verified-evidence' };
  }
  if (step.status === 'running' || step.status === 'uncertain') {
    return { action: 'inspect', reason: 'outcome-unknown' };
  }
  // A previous approval is not transferable across restart or task identity.
  if (step.risk === 'write' || step.risk === 'destructive' || step.risk === 'external') {
    return { action: 'approval', reason: 'side-effect-risk' };
  }
  if (step.status === 'pending' && step.risk === 'read') {
    return { action: 'resume', reason: 'safe-read' };
  }
  return { action: 'inspect', reason: 'unclassified' };
}
