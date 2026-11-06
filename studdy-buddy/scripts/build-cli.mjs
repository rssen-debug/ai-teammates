import { build } from 'esbuild';
import { mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'dist', 'cli');
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(root, 'packages/cli/src/bin.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: join(out, 'studdy.mjs'),
  banner: { js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);" },
  external: ['node:*'],
  logLevel: 'info',
});
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
writeFileSync(join(out, 'package.json'), JSON.stringify({
  name: 'studdy-buddy',
  version: process.env.STUDDY_BUILD_VERSION ?? pkg.version,
  description: pkg.description,
  type: 'module',
  bin: { studdy: './studdy.mjs' },
  engines: pkg.engines,
  dependencies: { 'agent-desktop': '1.2.0' },
  license: 'MIT',
}, null, 2) + '\n');
copyFileSync(join(root, 'third-party/agent-desktop-LICENSE.txt'), join(out, 'agent-desktop-LICENSE.txt'));
writeFileSync(join(out, 'README.md'), '# Studdy Buddy CLI\n\nInstall: `npm install -g .` from this directory, then run `studdy`.\nRequires Node >= 22.13. Native computer control uses agent-desktop on Windows.\n');
console.log('Built dist/cli/studdy.mjs');
