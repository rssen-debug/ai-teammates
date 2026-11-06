import { describe, expect, it } from 'vitest';
import { allowedObservationTitle, detectCompanionHint } from '../../apps/desktop/electron/companion-observer.js';
import type { UiSnapshot } from '@studdy/shared';

function snapshot(text: string): UiSnapshot {
  return {
    windowId: '42',
    takenAt: '2026-11-06T00:00:00Z',
    elements: [{ ref: '@s1:e1', name: text, value: null, role: 'text', bounds: null, enabled: true, stale: false }],
    accessible: true,
    note: null,
  };
}

describe('proactive companion guardrails', () => {
  it('detects a real error without requiring a user chat message', () => {
    const hint = detectCompanionHint(snapshot('Destination host unreachable'), 'Cisco Packet Tracer');
    expect(hint?.label).toContain('fel');
    expect(hint?.question).toContain('Destination host unreachable');
    expect(hint?.signature).toMatch(/^[a-f0-9]{20}$/);
  });

  it('ignores sensitive and private windows', () => {
    expect(allowedObservationTitle('Bitwarden Password Manager')).toBe(false);
    expect(allowedObservationTitle('ChatGPT - Chrome')).toBe(false);
    expect(detectCompanionHint(snapshot('Error: access denied'), 'Bank login')).toBeNull();
    expect(detectCompanionHint(snapshot('No issues here'), 'Packet Tracer')).toBeNull();
  });

  it('does not treat empty accessibility results as evidence', () => {
    expect(detectCompanionHint({ ...snapshot('Error failed'), accessible: false }, 'Packet Tracer')).toBeNull();
  });
});
