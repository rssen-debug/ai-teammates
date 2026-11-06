import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The CLI stores everything in Node's built-in `node:sqlite`. That module only
 * exists from Node 22.5 and only works without `--experimental-sqlite` from
 * 22.13. The CLI is now the shipped product, so the Node engine floor is the
 * real runtime contract. The old Electron installer is archived and must not
 * reappear as an active dependency.
 *
 * These assertions are deliberately about the manifest, because a wrong floor is
 * invisible to every test that runs on a newer machine.
 */

const root = resolve(__dirname, '../..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  engines?: { node?: string };
  devDependencies?: Record<string, string>;
};

function minorFloor(range: string | undefined): [number, number] {
  const m = /(\d+)\.(\d+)/.exec(range ?? '');
  if (!m) throw new Error(`no version in "${range}"`);
  return [Number(m[1]), Number(m[2])];
}

describe('runtime floor', () => {
  it('declares Node >= 22.13, where node:sqlite needs no flag', () => {
    const [major, minor] = minorFloor(pkg.engines?.node);
    expect(major).toBeGreaterThanOrEqual(22);
    expect(major > 22 || minor >= 13).toBe(true);
  });

  it('does not ship Electron or electron-builder anymore', () => {
    expect(pkg.devDependencies?.electron).toBeUndefined();
    expect(pkg.devDependencies?.['electron-builder']).toBeUndefined();
  });

  it('pins the native agent-desktop helper exactly', () => {
    const range = pkg.devDependencies?.['agent-desktop'] ?? '';
    expect(range).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('the driver can report the floor instead of crashing when it is unmet', () => {
    const source = readFileSync(resolve(root, 'packages/database/src/driver.ts'), 'utf8');
    expect(source).toContain('22.13');
    expect(source).toContain('SqliteUnavailableError');
  });
});
