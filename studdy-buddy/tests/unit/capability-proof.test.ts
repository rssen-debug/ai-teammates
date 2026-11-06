import { describe, expect, it } from 'vitest';
import { calculateCapabilityProof } from '../../packages/core/src/capability-proof.js';

describe('evidence-only Skills meter', () => {
  it('starts at zero without real verified events', () => {
    expect(calculateCapabilityProof([])).toMatchObject({ score: 0, maximum: 100, proofCount: 0 });
  });
  it('counts one successful task per unique proof, never repeated polling or model claims', () => {
    const events = [
      { kind: 'agent.uia.heartbeat', payload: { proof: 'abc', kind: 'OTHER' } },
      { kind: 'agent.uia.heartbeat', payload: { proof: 'abc', kind: 'OTHER' } },
      { kind: 'agent.capability.launch', payload: { proof: '1234567890abcdef1234' } },
      { kind: 'agent.capability.launch', payload: { proof: '1234567890abcdef1234' } },
      { kind: 'ai.claim.success', payload: { proof: 'never-verifiable' } },
    ];
    expect(calculateCapabilityProof(events)).toMatchObject({
      score: 2, observedApps: 1, launchedApps: 1, helpfulInterventions: 0,
    });
  });
  it('caps the displayed scale at 100 without inventing missing capabilities', () => {
    const events = Array.from({ length: 120 }, (_, i) => ({
      kind: 'agent.capability.launch', payload: { proof: i.toString(16).padStart(20, '0') },
    }));
    expect(calculateCapabilityProof(events)).toMatchObject({ score: 100, proofCount: 120 });
  });
});
