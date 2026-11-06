#!/usr/bin/env node
/**
 * Windows packaging.
 *
 * Builds the renderer and the Electron bundles, then invokes electron-builder.
 * On non-Windows hosts we still build the bundles and then report clearly that
 * the installer itself requires Windows (or Wine) - we never claim an installer
 * was produced when it was not.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '../..');

function run(cmd, args, cwd) {
  process.stdout.write(`\n$ ${cmd} ${args.join(' ')}\n`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function step(label, fn) {
  process.stdout.write(`\n=== ${label} ===\n`);
  fn();
}

const started = Date.now();

step('Renderer (vite)', () => run('npx', ['vite', 'build', '--config', 'apps/desktop/vite.config.ts'], repoRoot));
step('Electron bundles (esbuild)', () => run('node', ['apps/desktop/scripts/build-electron.mjs'], repoRoot));

// Write a runtime package.json into dist so Electron resolves the entry point.
step('Runtime manifest', () => {
  const distDir = join(appRoot, 'dist');
  mkdirSync(distDir, { recursive: true });
  const pkg = {
    name: 'studdy-buddy',
    productName: 'Studdy Buddy',
    version: JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version,
    main: 'electron/main.cjs',
    private: true,
    description: 'Autonom AI-studiekompis för NetAcad och Packet Tracer',
  };
  writeFileSync(join(distDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  process.stdout.write(`wrote ${join(distDir, 'package.json')}\n`);
});

const isWindows = process.platform === 'win32';
if (!isWindows) {
  process.stdout.write(
    [
      '',
      '============================================================',
      'Byggnaden av applikationen lyckades.',
      'Windows-installern kunde INTE skapas här.',
      '============================================================',
      `Plattform: ${process.platform}`,
      '',
      'Anledning: electron-builder med NSIS-mål kräver Windows (eller Wine).',
      'Kör följande på en Windows-maskin för att producera installern:',
      '',
      '  npm run package:win',
      '',
      'Artefakterna hamnar i apps/desktop/dist/win-unpacked och som .exe.',
      'Se BUILD_STATUS.md för vad som är verifierat och vad som är blockerat.',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

step('Windows installer (electron-builder)', () => {
  const configPath = join(appRoot, 'electron-builder.yml');
  if (!existsSync(configPath)) {
    process.stdout.write(`saknar ${configPath}\n`);
    process.exit(1);
  }
  run('npx', ['electron-builder', '--win', 'nsis', '--config', configPath], repoRoot);
});

process.stdout.write(`\nKlart på ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
