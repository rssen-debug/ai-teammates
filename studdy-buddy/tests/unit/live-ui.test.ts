import { describe, expect, it } from 'vitest';
import { liveLines, compactLivePrompt } from '../../packages/cli/src/live-ui.js';
import { dots } from '../../packages/cli/src/theme.js';
import type { LiveStatus } from '@studdy/core';

const base: LiveStatus = {
  state: 'off', observing: false, windowTitle: null, windowId: null,
  elementCount: 0, lastObservedAt: null, activity: 'Observation stoppad', level: 1,
};
const metrics = {
  verifiedSnapshots: 17, verifiedSkills: 2, level: 3,
  memoryFacts: 4, vaultPath: '/tmp/Obsidian-Vault', debuggerPath: '/tmp/Obsidian-Vault/debugger.md',
};

describe('evidence-backed CLI live panel', () => {
  it('never claims active observation merely from previous snapshots', () => {
    const lines = liveLines(base, metrics, { providerConnected: true, issues: 2, now: 200_000 });
    expect(lines.join(' ')).toContain('UI: OFF');
    expect(lines.join(' ')).toContain('UI-element: 0');
    expect(lines.join(' ')).toContain('Verifierade UI-avläsningar: 17');
    expect(lines.join(' ')).toContain('Skills LVL 3/100');
    expect(lines.join(' ')).toContain('inte AI-intelligens');
  });
  it('shows actual measured active window, element count and time', () => {
    const live = { ...base, state: 'active' as const, observing: true,
      windowTitle: 'Browser', elementCount: 42, lastObservedAt: 197_000,
      activity: 'Läser 42 UI-element i Browser' };
    const lines = liveLines(live, metrics, { providerConnected: true, issues: 1, now: 200_000 });
    expect(lines.join(' ')).toContain('UI: AKTIV');
    expect(lines.join(' ')).toContain('UI-element: 42 · senast: 3 s sedan');
    expect(lines.join(' ')).toContain('Fönster: Browser');
  });
  it('renders a compact live prompt that does not depend on the last poll time', () => {
    const now = { ...base, state: 'active' as const, observing: true, windowTitle: 'Webbläsare · AI-chatt', elementCount: 393, lastObservedAt: 1 };
    expect(compactLivePrompt(now, 4)).toBe('● LIVE · Webbläsare · AI-chatt · 393 UI · LVL 4/100');
    expect(compactLivePrompt({ ...now, lastObservedAt: 999 }, 4)).toBe(compactLivePrompt(now, 4));
    expect(compactLivePrompt(base, 1)).toContain('0 UI');
  });
  it('never displays fake all-green dots for idle state', () => {
    expect(dots(false, 100, false)).toBe('○ ○ ○ ○ ○');
    expect(dots(false, 1, true)).toBe('● ○ ○ ○ ○');
    expect(dots(false, 100, true)).toBe('● ● ● ● ●');
  });
});
