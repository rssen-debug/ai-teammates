#!/usr/bin/env node
/**
 * Bundles the Electron main process and preload with esbuild.
 *
 * Why a bundler instead of plain tsc: the main process imports our workspace
 * packages via path aliases (@studdy/*). Those aliases do not exist at runtime,
 * so a tsc-only build produces a main.js that cannot resolve them. esbuild
 * inlines everything into two files, which also makes packaging predictable.
 *
 * `electron` is marked external (it is provided by the runtime), and so is
 * `node:sqlite` (a Node builtin that must not be bundled).
 */
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '../..');

const alias = {
  '@studdy/shared': resolve(repoRoot, 'packages/shared/src/index.ts'),
  '@studdy/database': resolve(repoRoot, 'packages/database/src/index.ts'),
  '@studdy/ai-router': resolve(repoRoot, 'packages/ai-router/src/index.ts'),
  '@studdy/learning-engine': resolve(repoRoot, 'packages/learning-engine/src/index.ts'),
  '@studdy/agent-core': resolve(repoRoot, 'packages/agent-core/src/index.ts'),
  '@studdy/curriculum': resolve(repoRoot, 'packages/curriculum/src/index.ts'),
  '@studdy/packet-tracer': resolve(repoRoot, 'packages/packet-tracer/src/index.ts'),
  '@studdy/voice-engine': resolve(repoRoot, 'packages/voice-engine/src/index.ts'),
};

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outdir: resolve(appRoot, 'dist/electron'),
  external: ['electron', 'node:sqlite', 'node:module', 'node:crypto', 'node:fs', 'node:path', 'node:os', 'node:child_process'],
  alias,
  sourcemap: false,
  logLevel: 'info',
  // Keep the bundle readable enough for a stack trace to be useful.
  minify: false,
};

try {
  const iconJob = spawnSync(process.execPath, [resolve(appRoot, 'scripts/generate-icons.mjs')], { cwd: repoRoot, encoding: 'utf8' });
  if (iconJob.status !== 0) throw new Error('Icon generation failed: ' + (iconJob.stderr || iconJob.stdout || iconJob.error?.message));
  console.log(iconJob.stdout.trim());
  // .cjs extension is required: the repo root package.json sets "type": "module",
  // so a CommonJS bundle named .js would be executed as ESM and crash at load.
  await build({ ...common, entryPoints: [resolve(appRoot, 'electron/main.ts')], outExtension: { '.js': '.cjs' } });
  await build({ ...common, entryPoints: [resolve(appRoot, 'electron/preload.ts')], outExtension: { '.js': '.cjs' } });
  console.log('electron bundle: ok ->', resolve(appRoot, 'dist/electron'));
} catch (err) {
  console.error('electron bundle failed');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
