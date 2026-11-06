/**
 * Development launcher.
 *
 * A dev loop for this app has three pieces that must agree, and getting them out
 * of sync is how "npm run dev" ends up showing a stale renderer:
 *
 *   1. the renderer bundle      (vite -> apps/desktop/dist/renderer)
 *   2. the electron main+preload (esbuild -> apps/desktop/dist/electron/*.cjs)
 *   3. a package.json in dist/   (so `electron apps/desktop/dist` knows the entry)
 *
 * Steps 1 and 3 used to live only in package-win.mjs, which meant `npm run dev`
 * produced a renderer nobody could launch. This script does all three, then
 * starts Electron. With `--watch` it rebuilds the renderer on change; Electron
 * is not auto-restarted (that needs a display to be useful).
 *
 * If Electron's binary is absent (CI, or an install done with
 * ELECTRON_SKIP_BINARY_DOWNLOAD=1), the build still completes and the script
 * says exactly why it cannot launch, rather than failing with a module error.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const repoRoot = join(appRoot, '..', '..');
const distDir = join(appRoot, 'dist');

const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');

function run(command, argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { stdio: 'inherit', cwd: repoRoot, shell: process.platform === 'win32', ...options });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${argv.join(' ')} exited ${code}`))));
  });
}

function writeRuntimeManifest() {
  mkdirSync(distDir, { recursive: true });
  const manifest = {
    name: 'studdy-buddy',
    productName: 'Studdy Buddy',
    version: '0.1.0',
    private: true,
    description: 'Studdy Buddy – AI study companion',
    // Electron reads this to find the main process. .cjs is deliberate: the repo
    // root package.json is "type": "module", so a .js main would be loaded as ESM
    // and die on `module is not defined`.
    main: 'electron/main.cjs',
    type: 'commonjs',
  };
  writeFileSync(join(distDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function main() {
  if (!watch) {
    console.log('1/3 renderer');
    await run('npx', ['vite', 'build', '--config', 'apps/desktop/vite.config.ts']);
  } else {
    console.log('1/3 renderer (watch)');
    // Fire and forget: vite owns this process for the rest of the session.
    spawn('npx', ['vite', 'build', '--config', 'apps/desktop/vite.config.ts', '--watch'], {
      stdio: 'inherit',
      cwd: repoRoot,
      shell: process.platform === 'win32',
    });
  }

  console.log('2/3 electron bundle');
  await run('node', ['apps/desktop/scripts/build-electron.mjs']);

  console.log('3/3 runtime manifest');
  writeRuntimeManifest();

  if (!existsSync(join(distDir, 'electron', 'main.cjs'))) {
    throw new Error('main.cjs missing after build; refusing to launch');
  }

  // Find Electron. It is a devDependency, so the binary lives in node_modules.
  const electronBinary = join(repoRoot, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (!existsSync(electronBinary)) {
    console.log('');
    console.log('BLOCKED: the Electron binary is not installed.');
    console.log('  Reason: node_modules/electron/dist is missing (installed with ELECTRON_SKIP_BINARY_DOWNLOAD=1,');
    console.log('          or the download step has not run).');
    console.log('  Fix:    npx electron-download-install   (or reinstall electron without the skip flag)');
    console.log('  Built:  apps/desktop/dist/renderer + apps/desktop/dist/electron/*.cjs');
    return;
  }

  console.log('launching Electron');
  await new Promise((resolve, reject) => {
    const child = spawn(electronBinary, [distDir], { stdio: 'inherit', cwd: repoRoot });
    child.on('error', reject);
    child.on('exit', () => resolve());
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
