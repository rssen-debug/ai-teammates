import { describe, expect, it } from 'vitest';
import { allowedObservationTitle, safeWindowLabel, detectCompanionHint, detectContextHint } from '../../packages/core/src/companion-observer.js';
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
    expect(allowedObservationTitle('Bitwarden Password Manager')).toBe(true);
    expect(safeWindowLabel('Bitwarden Password Manager')).toBe('Privat fönster');
    expect(allowedObservationTitle('ChatGPT - Chrome')).toBe(true);
    expect(safeWindowLabel('ChatGPT - Google Chrome', 'chrome.exe')).toBe('Webbläsare · AI-chatt');
    expect(detectCompanionHint(snapshot('Error: access denied'), 'Bank login')).toBeNull();
    expect(detectCompanionHint(snapshot('No issues here'), 'Packet Tracer')).toBeNull();
  });

  it('does not print intimate browser tab titles or make suggestions about them', () => {
    const title = 'Private video - EroMe - Google Chrome';
    expect(allowedObservationTitle(title)).toBe(true);
    expect(safeWindowLabel(title, 'chrome.exe')).toBe('Privat fönster');
    expect(detectContextHint(snapshot('Video player controls'), title)).toBeNull();
    expect(detectCompanionHint(snapshot('Error occurred'), title)).toBeNull();
  });
  it('can read a ChatGPT tab without intrusive unsolicited suggestions', () => {
    expect(allowedObservationTitle('ChatGPT - Google Chrome')).toBe(true);
    expect(detectContextHint(snapshot('OSI networking quiz'), 'ChatGPT - Google Chrome')).toBeNull();
  });

  it('suggests study help from actual non-private accessibility text', () => {
    const hint = detectContextHint(snapshot('Module 3: OSI and TCP/IP protocols'), 'Cisco Networking Academy');
    expect(hint?.kind).toBe('study');
    expect(hint?.question).toContain('quiz');
    expect(hint?.question).not.toContain('Module 3');
  });
  it('recognizes coding and creative tools with matching accessible UI evidence', () => {
    expect(detectContextHint(snapshot('Problems: TypeScript compilation'), 'VS Code')?.kind).toBe('code');
    expect(detectContextHint(snapshot('CapCut video editing timeline'), 'Editor')?.kind).toBe('creative');
  });
  it('offers a generic, non-pretend suggestion for other readable programs', () => {
    const other = snapshot('A document heading');
    other.elements.push(
      { ...other.elements[0]!, ref: '@s1:e2', name: 'Document body' },
      { ...other.elements[0]!, ref: '@s1:e3', name: 'Toolbar' },
    );
    const hint = detectContextHint(other, 'Desktop document app');
    expect(hint?.kind).toBe('general');
    expect(hint?.question).toContain('vet ännu inte ditt mål');
    expect(hint?.question).not.toContain('Document body');
  });

  it('does not infer intent from only an app name, private window or credential content', () => {
    expect(detectContextHint(snapshot('Welcome'), 'Cisco Packet Tracer')).toBeNull();
    expect(detectContextHint(snapshot('OSI and subnetting'), 'Gmail Inbox')).toBeNull();
    expect(detectContextHint(snapshot('Password: OSI'), 'Notes')).toBeNull();
    expect(detectContextHint({ ...snapshot('OSI'), accessible: false }, 'Cisco')).toBeNull();
  });

  it('does not treat empty accessibility results as evidence', () => {
    expect(detectCompanionHint({ ...snapshot('Error failed'), accessible: false }, 'Packet Tracer')).toBeNull();
  });
});
