import { describe, it, expect } from 'vitest';
import { configureCliFullAccess, configureFullDesktopAccess, FULL_DESKTOP_SCOPES } from '@studdy/core';
import type { PermissionKey, PermissionMode } from '@studdy/shared';

function store() {
  const checks = new Map<string, unknown>();
  const granted = new Set<PermissionKey>();
  let mode: PermissionMode = 'OBSERVE_ONLY';
  return {
    checkpoints: { get: <T>(k: string) => checks.get(k) as T | undefined, set: (k: string, v: unknown) => { checks.set(k, v); } },
    permissions: { grant: (k: PermissionKey) => { granted.add(k); }, setMode: (m: PermissionMode) => { mode = m; }, isGranted: (k: PermissionKey) => granted.has(k) },
    granted, mode: () => mode,
  };
}

describe('full access setup', () => {
  it('CLI setup grants all scopes once and respects revoke', () => {
    const s = store();
    expect(configureCliFullAccess(s)).toBe(true);
    expect(s.mode()).toBe('APPROVED_ACTION');
    for (const scope of FULL_DESKTOP_SCOPES) expect(s.granted.has(scope)).toBe(true);
    s.granted.delete('computer.actions');
    expect(configureCliFullAccess(s)).toBe(false);
    expect(s.granted.has('computer.actions')).toBe(false);
  });
  it('desktop setup only runs packaged Windows', () => {
    const s = store();
    expect(configureFullDesktopAccess(s, 'linux', true)).toBe(false);
    expect(configureFullDesktopAccess(s, 'win32', false)).toBe(false);
    expect(configureFullDesktopAccess(s, 'win32', true)).toBe(true);
  });
});
