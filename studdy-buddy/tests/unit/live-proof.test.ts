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
  /** Windows refuses headless `type`; set-value is the semantic path. */
  setValueOk?: boolean; headedOnly?: boolean;
} = {}) {
  const o = { available: true, granted: true, launchOk: true, windows: [window], windowError: null, accessible: true, typeOk: true, readBack: true, shotOk: true, setValueOk: true, headedOnly: false, ...over };
  let typed = '';
  const attempts: string[] = [];
  return {
    nativeStatus: async () => ({ available: o.available, version: '1.2.0', detail: 'stub', mode: o.available ? 'cli-json' : 'unavailable' }),
    services: { permissions: { check: () => ({ allowed: o.granted, reason: 'nekat' }) } },
    launchApp: async () => ({ ok: o.launchOk, detail: o.launchOk ? 'Notepad' : 'App not found' }),
    adapter: {
      listWindows: async () => ({ windows: o.windows, error: o.windowError }),
      snapshot: async () => o.accessible ? snapshot(typed) : { ...snapshot(), accessible: false, elements: [], note: 'Accessibility nekad' },
    },
    computerAction: async (action: string, args: string[], options: { headed?: boolean } = {}) => {
      attempts.push(action + (options.headed ? ':headed' : ':headless'));
      if (action === 'set-value' && !o.setValueOk) return { ok: false, detail: 'ACTION_NOT_SUPPORTED' };
      if (action === 'type' && o.headedOnly && !options.headed) return { ok: false, detail: 'POLICY_DENIED' };
      if (action === 'type' && !o.typeOk) return { ok: false, detail: 'leverans misslyckades' };
      if (o.readBack) typed = args[1] ?? '';
      return { ok: true, detail: 'skickat' };
    },
    attempts,
    screenshot: async (_id: string, path: string) => {
      if (!o.shotOk) return { ok: false, detail: 'Skärmåtkomst nekad' };
      writeFileSync(path, Buffer.from('fake-png-bytes'));
      return { ok: true, detail: path };
    },
  } as unknown as StuddyRuntime & { attempts: string[] };
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

  it('falls back to physical --headed delivery when the helper refuses semantic writes', async () => {
    const stub = runtimeStub({ setValueOk: false, headedOnly: true });
    const proof = await proveLive(stub, { app: 'Notepad' });
    expect(proof.ok).toBe(true);
    expect(stub.attempts).toEqual(['set-value:headless', 'type:headed']);
    expect(proof.steps.find(s => s.name === 'Skrivtest')!.detail).toContain('type --headed');
  });

  it('never claims a pass when every delivery method is refused', async () => {
    const proof = await proveLive(runtimeStub({ setValueOk: false, typeOk: false }), { app: 'Notepad' });
    expect(proof.ok).toBe(false);
    expect(proof.marker).toBeNull();
    expect(proof.steps.find(s => s.name === 'Skrivtest')!.status).toBe('fail');
  });

  it('prefers an element that advertises a value action over a guessed role', async () => {
    const stub = runtimeStub();
    const original = stub.adapter.snapshot.bind(stub.adapter);
    stub.adapter.snapshot = (async (windowId: string) => {
      const snap = await original(windowId);
      return {
        ...snap,
        elements: [
          { ref: '@s1:e9', role: 'edit', name: 'Fel fält', value: null, bounds: null, enabled: true, stale: false, availableActions: ['Scroll'] },
          { ...snap.elements[0]!, availableActions: ['SetValue'] },
        ],
      };
    }) as typeof stub.adapter.snapshot;
    const proof = await proveLive(stub, { app: 'Notepad' });
    expect(proof.ok).toBe(true);
    expect(proof.marker).toBeTruthy();
  });
});
