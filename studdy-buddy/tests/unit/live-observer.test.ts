import { describe, it, expect } from 'vitest';
import { LiveObserver, StuddyServices, type DesktopAccessibilityAdapter } from '@studdy/core';
import type { UiSnapshot, WindowInfo } from '@studdy/shared';

const win = (over: Partial<WindowInfo> = {}): WindowInfo => ({
  id: 'w1', title: 'Packet Tracer', processName: 'PacketTracer.exe', appKind: 'PACKET_TRACER',
  bounds: { x: 0, y: 0, width: 800, height: 600 }, displayId: null, minimized: false, focused: true, ...over,
});
const snap = (accessible: boolean, note: string | null = null): UiSnapshot => ({
  windowId: 'w1', takenAt: new Date().toISOString(), accessible, note,
  elements: accessible ? [{ ref: '@w1:e1', role: 'text', name: 'Destination host unreachable', value: null, bounds: null, enabled: true, stale: false }] : [],
});
function fakeAdapter(windows: WindowInfo[], snapshot: UiSnapshot, error: string | null = null) {
  return { listWindows: async () => ({ windows, error }), snapshot: async () => snapshot } as unknown as DesktopAccessibilityAdapter;
}

describe('LiveObserver', () => {
  it('is not live until a real accessible snapshot succeeds', async () => {
    const services = new StuddyServices({ dataDir: ':memory:' });
    services.permissions.grant('application.observe');
    const observer = new LiveObserver({ services, adapter: fakeAdapter([win()], snap(true)), clock: () => 1000 });
    expect(observer.status().observing).toBe(false);
    await observer.tick();
    expect(observer.status().observing).toBe(true);
    expect(observer.status().windowTitle).toBe('Packet Tracer');
    expect(observer.status().level).toBeGreaterThanOrEqual(2);
    services.close();
  });
  it('observes permitted Gmail foreground UI but anonymizes sensitive status and offers no hints', async () => {
    const services = new StuddyServices({ dataDir: ':memory:' });
    services.permissions.grant('application.observe');
    const observer = new LiveObserver({ services, adapter: fakeAdapter([win({ title: 'Gmail - Inbox' })], snap(true)) });
    await observer.tick();
    expect(observer.status().observing).toBe(true);
    expect(observer.status().windowTitle).toBe('Privat fönster');
    expect(observer.status().activity).not.toContain('Gmail');
    services.close();
  });
  it('observes Chrome ChatGPT UI while showing only a safe browser label', async () => {
    const services = new StuddyServices({ dataDir: ':memory:' });
    services.permissions.grant('application.observe');
    const hints: string[] = [];
    const observer = new LiveObserver({
      services, adapter: fakeAdapter([win({ title: 'ChatGPT - Google Chrome', processName: 'chrome.exe' })], snap(true)),
      onHint: hint => hints.push(hint.kind ?? 'unknown'),
    });
    await observer.tick();
    expect(observer.status().observing).toBe(true);
    expect(observer.status().windowTitle).toBe('Webbläsare · AI-chatt');
    expect(hints).toEqual([]);
    services.close();
  });
  it('enumerates apps behind CMD and reads the recent external window without stealing focus', async () => {
    const services = new StuddyServices({ dataDir: ':memory:' });
    services.permissions.grant('application.observe');
    const windows = [
      win({ id: 'console', title: 'Administrator: CMD', processName: 'cmd.exe', focused: true }),
      win({ id: 'chrome', title: 'ChatGPT - Google Chrome', processName: 'chrome.exe', focused: false }),
      win({ id: 'editor', title: 'Visual Studio Code', processName: 'Code.exe', focused: false, minimized: true }),
    ];
    const read: string[] = [];
    const adapter = {
      listWindows: async () => ({ windows, error: null }),
      snapshot: async (id: string) => { read.push(id); return { ...snap(true), windowId: id }; },
    } as unknown as DesktopAccessibilityAdapter;
    const observer = new LiveObserver({ services, adapter });
    await observer.tick();
    expect(observer.status().observing).toBe(true);
    expect(observer.status().observationScope).toBe('background');
    expect(observer.status().openWindowCount).toBe(2);
    expect(observer.status().openWindows).toContain('Webbläsare · AI-chatt');
    expect(observer.status().openWindows).toContain('Visual Studio Code (minimerad)');
    expect(observer.status().windowTitle).toBe('Webbläsare · AI-chatt');
    expect(read).toEqual(['chrome']);
    services.close();
  });
  it('keeps the all-windows inventory even when a background snapshot is inaccessible', async () => {
    const services = new StuddyServices({ dataDir: ':memory:' });
    services.permissions.grant('application.observe');
    const observer = new LiveObserver({ services, adapter: fakeAdapter([
      win({ id: 'terminal', title: 'Administrator: CMD', processName: 'cmd.exe', focused: true }),
      win({ id: 'chrome', title: 'Browser - Google Chrome', processName: 'chrome.exe', focused: false }),
    ], snap(false, 'ACCESS_DENIED')) });
    await observer.tick();
    expect(observer.status().openWindowCount).toBe(1);
    expect(observer.status().openWindows).toEqual(['Webbläsare']);
    expect(observer.status().observing).toBe(false);
    expect(observer.status().elementCount).toBe(0);
    services.close();
  });
  it('does not accidentally hide a browser page containing the word terminal', async () => {
    const services = new StuddyServices({ dataDir: ':memory:' });
    services.permissions.grant('application.observe');
    const observer = new LiveObserver({ services, adapter: fakeAdapter([
      win({ title: 'Terminal tutorial - Google Chrome', processName: 'chrome.exe' }),
    ], snap(true)) });
    await observer.tick();
    expect(observer.status().openWindowCount).toBe(1);
    expect(observer.status().observing).toBe(true);
    services.close();
  });
  it('reports unavailable honestly when adapter fails', async () => {
    const services = new StuddyServices({ dataDir: ':memory:' });
    services.permissions.grant('application.observe');
    const observer = new LiveObserver({ services, adapter: fakeAdapter([], snap(false), 'PLATFORM_NOT_SUPPORTED') });
    await observer.tick();
    expect(observer.status().state).toBe('unavailable');
    expect(observer.status().observing).toBe(false);
    services.close();
  });
  it('goes stale after 35s without a new observation', async () => {
    const services = new StuddyServices({ dataDir: ':memory:' });
    services.permissions.grant('application.observe');
    let now = 1000;
    const observer = new LiveObserver({ services, adapter: fakeAdapter([win()], snap(true)), clock: () => now });
    await observer.tick();
    expect(observer.status().observing).toBe(true);
    now += 40_000;
    expect(observer.status().observing).toBe(false);
    services.close();
  });
  it('drains an in-flight observation before closing the database', async () => {
    const services = new StuddyServices({ dataDir: ':memory:' });
    services.permissions.grant('application.observe');
    let release!: (value: { windows: WindowInfo[]; error: string | null }) => void;
    const adapter = {
      listWindows: () => new Promise<{ windows: WindowInfo[]; error: string | null }>(resolve => { release = resolve; }),
      snapshot: async () => snap(true),
    } as unknown as DesktopAccessibilityAdapter;
    const observer = new LiveObserver({ services, adapter });
    observer.start();
    const pending = observer.tick();
    observer.stop();
    release({ windows: [win()], error: null });
    await pending;
    expect(() => services.close()).not.toThrow();
    expect(() => observer.status()).not.toThrow();
  });
});
