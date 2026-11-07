import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { proveLive, type StuddyRuntime } from '@studdy/core';
import type { UiSnapshot, WindowInfo } from '@studdy/shared';

const window: WindowInfo = {
  id: 'w1', title: 'Namnlös - Anteckningar', processName: 'notepad.exe', appKind: 'OTHER',
  bounds: { x: 0, y: 0, width: 800, height: 600 }, displayId: null, minimized: false, focused: true,
};
const snapshot = (text = ''): UiSnapshot => ({
  windowId: 'w1', takenAt: new Date().toISOString(), accessible: true, note: null,
  elements: [{ ref: '@s1:e1', role: 'edit', name: 'Textredigerare', value: text, bounds: null, enabled: true, stale: false }],
});

/** Stub runtime: only the tool answers are fake, the proof logic is the real one. */
function runtimeStub(over: {
  available?: boolean; granted?: boolean; launchOk?: boolean; windows?: WindowInfo[];
  windowError?: string | null; accessible?: boolean; typeOk?: boolean; readBack?: boolean; shotOk?: boolean;
} = {}) {
  const o = { available: true, granted: true, launchOk: true, windows: [window], windowError: null, accessible: true, typeOk: true, readBack: true, shotOk: true, ...over };
  let typed = '';
  return {
    nativeStatus: async () => ({ available: o.available, version: '1.2.0', detail: 'stub', mode: o.available ? 'cli-json' : 'unavailable' }),
    services: { permissions: { check: () => ({ allowed: o.granted, reason: 'nekat' }) } },
    launchApp: async () => ({ ok: o.launchOk, detail: o.launchOk ? 'Notepad' : 'App not found' }),
    adapter: {
      listWindows: async () => ({ windows: o.windows, error: o.windowError }),
      snapshot: async () => o.accessible ? snapshot(typed) : { ...snapshot(), accessible: false, elements: [], note: 'Accessibility nekad' },
    },
    computerAction: async (_action: string, args: string[]) => {
      if (!o.typeOk) return { ok: false, detail: 'leverans misslyckades' };
      if (o.readBack) typed = args[1] ?? '';
      return { ok: true, detail: 'skickat' };
    },
    screenshot: async (_id: string, path: string) => {
      if (!o.shotOk) return { ok: false, detail: 'Skärmåtkomst nekad' };
      writeFileSync(path, Buffer.from('fake-png-bytes'));
      return { ok: true, detail: path };
    },
  } as unknown as StuddyRuntime;
}

describe('proveLive', () => {
  it('passes only when launch, window, tree, write read-back and screenshot all verify', async () => {
    const proof = await proveLive(runtimeStub(), { app: 'Notepad' });
    expect(proof.ok).toBe(true);
    expect(proof.steps.map(s => s.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
    expect(proof.marker).toMatch(/^Studdy proof [0-9a-f]{8}$/);
  });

  it('reports BLOCKED (not pass) when the native helper has no desktop session', async () => {
    const proof = await proveLive(runtimeStub({ available: false }), { app: 'Notepad' });
    expect(proof.ok).toBe(false);
    expect(proof.steps[0]!.status).toBe('blocked');
    expect(proof.steps.some(s => s.status === 'pass')).toBe(false);
  });

  it('does not claim a window from a successful launch envelope alone', async () => {
    const proof = await proveLive(runtimeStub({ windows: [] }), { app: 'Notepad', timeoutMs: 10 });
    expect(proof.ok).toBe(false);
    expect(proof.steps.find(s => s.name === 'Fönsterobservation')!.status).toBe('fail');
  });

  it('fails the write step when typed text cannot be read back', async () => {
    const proof = await proveLive(runtimeStub({ readBack: false }), { app: 'Notepad' });
    expect(proof.ok).toBe(false);
    expect(proof.marker).toBeNull();
    expect(proof.steps.find(s => s.name === 'Skrivtest')!.status).toBe('fail');
  });

  it('skips writing on request and still requires real observation', async () => {
    const proof = await proveLive(runtimeStub(), { app: 'Notepad', noWrite: true });
    expect(proof.ok).toBe(true);
    expect(proof.steps.find(s => s.name === 'Skrivtest')!.status).toBe('skipped');
  });

  it('treats a denied accessibility tree and denied screenshot as blocked', async () => {
    const tree = await proveLive(runtimeStub({ accessible: false }), { app: 'Notepad' });
    expect(tree.steps.find(s => s.name === 'UI-träd')!.status).toBe('blocked');
    const shot = await proveLive(runtimeStub({ shotOk: false }), { app: 'Notepad', noWrite: true });
    expect(shot.ok).toBe(false);
    expect(shot.steps.find(s => s.name === 'Skärmbild')!.status).toBe('blocked');
  });

  it('stops before acting when permission is revoked', async () => {
    const proof = await proveLive(runtimeStub({ granted: false }), { app: 'Notepad' });
    expect(proof.ok).toBe(false);
    expect(proof.steps.map(s => s.name)).toEqual(['Native helper', 'Behörighet']);
  });
});
