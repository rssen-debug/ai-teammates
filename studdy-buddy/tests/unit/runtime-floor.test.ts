import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The app stores everything in Node's built-in `node:sqlite`. That module only
 * exists from Node 22.5 and only works without `--experimental-sqlite` from
 * 22.13. The Electron build is what actually ships, so its bundled Node is the
 * real floor - and Electron 33 bundles Node 20, where the module is absent
 * entirely. CI proved this the hard way: every database test failed on a pinned
 * Node 22.12 while passing on 22.22 locally.
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

function electronMajor(range: string | undefined): number {
  const m = /(\d+)/.exec(range ?? '');
  if (!m) throw new Error(`no version in "${range}"`);
  return Number(m[1]);
}

describe('runtime floor', () => {
  it('declares Node >= 22.13, where node:sqlite needs no flag', () => {
    const [major, minor] = minorFloor(pkg.engines?.node);
    expect(major).toBeGreaterThanOrEqual(22);
    expect(major > 22 || minor >= 13).toBe(true);
  });

  it('uses an Electron whose bundled Node has node:sqlite', () => {
    // Electron 33 bundles Node 20 (no node:sqlite at all); the module became
    // usable from Electron 35 onwards. Pin the rule, not a vague "recent".
    expect(electronMajor(pkg.devDependencies?.electron)).toBeGreaterThanOrEqual(35);
  });

  it('the driver can report the floor instead of crashing when it is unmet', () => {
    const source = readFileSync(resolve(root, 'packages/database/src/driver.ts'), 'utf8');
    expect(source).toContain('22.13');
    expect(source).toContain('SqliteUnavailableError');
  });
});
