#!/usr/bin/env node
/**
 * Windows packaging.
 *
 * Builds the renderer and the Electron bundles, then invokes electron-builder.
 * On non-Windows hosts we still build the bundles and then report clearly that
 * the installer itself requires Windows (or Wine) - we never claim an installer
 * was produced when it was not.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '../..');

function run(cmd, args, cwd) {
  process.stdout.write(`\n$ ${cmd} ${args.join(' ')}\n`);
  // Capture the output as well as showing it: CI log downloads are not always
  // reachable, but check-run annotations are. On failure we re-emit the tail as
  // ::error:: lines so the reason survives even when the raw log does not.
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: false });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) {
    const tail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-25)
      .join('\n');
    process.stdout.write(`\n--- sista 25 rader ---\n${tail}\n`);
    for (const line of tail.split('\n')) {
      // Annotations are capped, so trim each line to stay readable.
      process.stdout.write(`::error title=package-win::${line.slice(0, 400).replace(/%/g, '%25').replace(/\r/g, '')}\n`);
    }
    process.exit(result.status ?? 1);
  }
}

function step(label, fn) {
  process.stdout.write(`\n=== ${label} ===\n`);
  fn();
}

const started = Date.now();

// Launch the installed CLI through Node directly. On Windows, npm's `npx` is a\n// .cmd shim and execFileSync('npx') fails with spawnSync ENOENT. Avoid shells.\nconst viteCli = join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');\nconst builderCli = join(repoRoot, 'node_modules', 'electron-builder', 'cli.js');\nstep('Renderer (vite)', () => run(process.execPath, [viteCli, 'build', '--config', 'apps/desktop/vite.config.ts'], repoRoot));
step('Electron bundles (esbuild)', () => run(process.execPath, ['apps/desktop/scripts/build-electron.mjs'], repoRoot));

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
    author: { name: 'Studdy Buddy' },
    // Deliberately not "for NetAcad": the app has to work for any course site.
    description: 'AI-studiekompis som hjälper dig plugga på valfri kursplattform',
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

step('Verify electron-builder is installed', () => {
  // This used to be missing from package.json entirely, so CI reached this step
  // and npx tried to fetch a package that was never declared. Fail with a
  // sentence a human can act on instead of a stack trace.
  const bin = join(repoRoot, 'node_modules', '.bin', isWindows ? 'electron-builder.cmd' : 'electron-builder');
  if (!existsSync(bin)) {
    process.stdout.write(`electron-builder saknas i node_modules. Kör: npm install\n`);
    process.exit(1);
  }
  process.stdout.write(`electron-builder hittad: ${bin}\n`);
});

step('Windows installer (electron-builder)', () => {
  const configPath = join(appRoot, 'electron-builder.yml');
  if (!existsSync(configPath)) {
    process.stdout.write(`saknar ${configPath}\n`);
    process.exit(1);
  }
  // --publish never: a build must never upload anything implicitly.
  run(process.execPath, [builderCli, '--win', 'nsis', '--config', configPath, '--publish', 'never'], appRoot);
});

step('Confirm the installer exists', () => {
  const winDir = join(appRoot, 'dist', 'win');
  const exe = existsSync(winDir)
    ? readdirSync(winDir).filter((f) => f.endsWith('.exe'))
    : [];
  if (exe.length === 0) {
    process.stdout.write(`Ingen .exe skapades i ${winDir}. Det här är ett fel, inte en varning.\n`);
    process.exit(1);
  }
  for (const f of exe) {
    const size = (statSync(join(winDir, f)).size / (1024 * 1024)).toFixed(1);
    process.stdout.write(`  ${f} (${size} MB)\n`);
  }
});

process.stdout.write(`\nKlart på ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
