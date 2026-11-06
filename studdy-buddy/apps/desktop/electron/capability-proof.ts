/**
 * Evidence-based task coverage, not an IQ estimate or model intelligence score.
 * One point = one DISTINCT, locally verified successful task signature.
 * Repeating the same app launch or polling the same application never levels up.
 * Missing evidence starts at zero. A hundred is a reporting cap, not a promise.
 */
export type ProofEvent = { kind: string; payload: unknown; createdAt?: string };
export interface CapabilityProof { score: number; maximum: 100; proofCount: number; observedApps: number; launchedApps: number; helpfulInterventions: number };

export function calculateCapabilityProof(events: ProofEvent[]): CapabilityProof {
  const observed = new Set<string>();
  const launched = new Set<string>();
  const helped = new Set<string>();
  for (const event of events) {
    const payload = event.payload && typeof event.payload === 'object'
      ? event.payload as Record<string, unknown> : {};
    if (event.kind === 'agent.uia.heartbeat') {
      // Historical events contain kind only; count it once per distinct kind.
      const signature = typeof payload.proof === 'string' ? payload.proof : typeof payload.kind === 'string' ? payload.kind : '';
      if (signature && signature.length <= 100) observed.add(signature);
    }
    if (event.kind === 'agent.capability.launch' && typeof payload.proof === 'string' && /^[0-9a-f]{20}$/.test(payload.proof)) launched.add(payload.proof);
    if (event.kind === 'agent.capability.intervention' && typeof payload.proof === 'string' && /^[0-9a-f]{20}$/.test(payload.proof)) helped.add(payload.proof);
  }
  const proofCount = observed.size + launched.size + helped.size;
  return {
    score: Math.min(100, proofCount), maximum: 100, proofCount,
    observedApps: observed.size, launchedApps: launched.size,
    helpfulInterventions: helped.size,
  };
}
