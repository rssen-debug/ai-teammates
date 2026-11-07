import { describe, it, expect } from 'vitest';
import { FULL_DESKTOP_SCOPES, configureCliFullAccess } from '@studdy/core';
import { PERMISSION_DEFAULTS, PermissionGate } from '@studdy/agent-core';
import type { PermissionKey, PermissionMode } from '@studdy/shared';

/**
 * The user asked for "full permission to everything". These tests define what
 * that phrase is allowed to mean in this codebase, so it can never quietly mean
 * less than it says - which is exactly what happened: "Full åtkomst" left the
 * microphone denied while the voice modes used it anyway.
 */

function fakeDb() {
  const rows = new Map<PermissionKey, { granted: boolean }>();
  let mode: PermissionMode = 'OBSERVE_ONLY';
  const store = new Map<string, unknown>();
  return {
    permissions: {
      list: () => [...rows.entries()].map(([key, v]) => ({ key, granted: v.granted, grantedAt: null, mode })),
      get: (key: PermissionKey) => (rows.has(key) ? { key, granted: rows.get(key)!.granted } : undefined),
      set: (key: PermissionKey, granted: boolean) => { rows.set(key, { granted }); },
      // AutoSetupStore calls these two; keep them identical to the real gate.
      grant: (key: PermissionKey) => { rows.set(key, { granted: true }); },
      revoke: (key: PermissionKey) => { rows.set(key, { granted: false }); },
      isGranted: (key: PermissionKey) => rows.get(key)?.granted ?? false,
      setMode: (m: PermissionMode) => { mode = m; },
    },
    checkpoints: {
      get: <T,>(k: string) => store.get(k) as T | null | undefined,
      set: (k: string, v: unknown) => { store.set(k, v); },
    },
  };
}

describe('full access', () => {
  it('includes the microphone', () => {
    // The voice modes cannot work without it, so "full" must not exclude it.
    expect(FULL_DESKTOP_SCOPES).toContain('microphone');
  });

  it('covers every permission the app defines except none silently left out', () => {
    const all = Object.keys(PERMISSION_DEFAULTS) as PermissionKey[];
    for (const key of all) expect(FULL_DESKTOP_SCOPES).toContain(key);
  });

  it('grants the action mode, not just observe', () => {
    const db = fakeDb();
    expect(configureCliFullAccess(db as never)).toBe(true);
    expect(db.permissions.list().every((row) => row.mode === 'APPROVED_ACTION')).toBe(true);
    for (const key of FULL_DESKTOP_SCOPES) expect(db.permissions.get(key)?.granted).toBe(true);
  });

  it('is one-shot so a later revoke is respected', () => {
    const db = fakeDb();
    configureCliFullAccess(db as never);
    db.permissions.set('computer.actions', false);
    expect(configureCliFullAccess(db as never)).toBe(false);
    expect(db.permissions.get('computer.actions')?.granted).toBe(false);
  });
});

describe('permission gate', () => {
  it('starts closed', () => {
    const gate = new PermissionGate(fakeDb() as never);
    for (const row of gate.getAll()) expect(row.granted).toBe(false);
  });

  it('refuses to act without both the mode and the grant', () => {
    const db = fakeDb();
    const gate = new PermissionGate(db as never);
    expect(gate.check('act', ['computer.actions']).allowed).toBe(false);
    gate.grant('computer.actions');
    // Grant without the action mode is still not enough.
    expect(gate.check('act', ['computer.actions']).allowed).toBe(false);
    gate.setMode('APPROVED_ACTION');
    expect(gate.check('act', ['computer.actions']).allowed).toBe(true);
  });

  it('lets a revoke take effect immediately', () => {
    const db = fakeDb();
    const gate = new PermissionGate(db as never);
    gate.setMode('APPROVED_ACTION');
    gate.grant('screen.capture');
    expect(gate.check('observe', ['screen.capture']).allowed).toBe(true);
    gate.revoke('screen.capture');
    expect(gate.check('observe', ['screen.capture']).allowed).toBe(false);
  });
});
