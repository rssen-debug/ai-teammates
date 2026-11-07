#!/usr/bin/env node
/**
 * MAJIN — builds a standalone executable (.exe on Windows, binary on linux/mac).
 *
 *   node scripts/build-exe.mjs                 # win-x64 (standard)
 *   node scripts/build-exe.mjs --all           # win + linux + macos
 *   node scripts/build-exe.mjs --no-pkg          # bundle only, as CJS (fast)
 *
 * Steps: 1) src/ui + rules are copied into dist/  2) esbuild packages the CLI into
 * dist/majin.cjs  3) @yao-pkg/pkg snapshots it into a binary with node built in.
 * No native dependencies — Baileys/qrcode stay external (optional).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const argv = process.argv.slice(2);
const all = argv.includes('--all');
const noPkg = argv.includes('--no-pkg');

/* Aldrig shell:true — på Windows kör cmd.exe och den tolkar `>` i `=>` som omdirigering.
   Vi anropar bara node med filer, så det behövs inget skal och inga citat. */
function run(cmd, args, opts = {}) {
  process.stdout.write(`$ ${cmd} ${args.join(' ')}\n`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: false, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} exit ${r.status}`);
}

function copyDir(from, to) {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
  return true;
}

fs.mkdirSync(dist, { recursive: true });
for (const f of fs.readdirSync(dist)) {
  if (f === 'node-sea' || f === 'bundle-step.cjs') continue;
  fs.rmSync(path.join(dist, f), { recursive: true, force: true });
}

/* 1) resurser bredvid bundlen */
// The installed logo used to come from a stale hand-maintained .ico.
// Generate the multi-size Windows icon from the *same* pink PNG shown in MAJIN UI.
// Windows-only: no need to generate icons during a Linux bundle-only build.
copyDir(path.join(root, 'src', 'ui'), path.join(dist, 'ui'));
copyDir(path.join(root, 'rules'), path.join(dist, 'rules'));
copyDir(path.join(root, 'assets'), path.join(dist, 'assets'));
// Browser --app window/taskbar favicon and the embedded EXE/installer ICO must
// use the same exact pixels. Never ship the old hand-maintained UI PNG.
fs.copyFileSync(path.join(root, 'assets', 'majin.png'), path.join(dist, 'ui', 'logo.png'));
if (process.platform === 'win32' && !noPkg && process.env.MAJIN_NO_ICON !== '1') {
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(root, 'scripts', 'refresh-icon.ps1'),
    '-Destination', path.join(dist, 'assets', 'majin.ico')]);
}
fs.copyFileSync(path.join(root, 'package.json'), path.join(dist, 'package.json'));

/* 2) esbuild — som en fil i dist/, aldrig som `node -e <manus>`: ett
   fler-raders-manus med `=>` och citat går inte genom cmd.exe på Windows. */
const out = path.join(dist, 'majin.cjs');
const esbuildScript = path.join(dist, 'bundle-step.cjs');
fs.writeFileSync(esbuildScript, `const path = require('node:path');
import('esbuild').then(async (esbuild) => {
  const r = await esbuild.build({
    entryPoints: ['src/cli/majin.js'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node' + process.versions.node.split('.')[0],
    outfile: ${JSON.stringify(out.split(path.sep).join('/'))},
    external: ['@whiskeysockets/baileys', 'qrcode', 'sharp'],
    keepNames: true,
    legalComments: 'none',
    minify: false,
    logLevel: 'warning',
  });
  if (r.errors && r.errors.length) process.exit(1);
}).catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });
`);
// esbuild is a devDependency; MAJIN runs without any dependency at all, so a bare
// clone has no node_modules and the real error would be a stack trace from the
// generated script. Say what to do instead.
if (spawnSync(process.execPath, ['-e', "require('esbuild')"], { cwd: root, encoding: 'utf8' }).status !== 0) {
  console.error(
    'build-exe: esbuild is not installed — run `npm install` first (it is only needed to build;\n' +
    '  MAJIN itself has no runtime dependencies). To skip building entirely, take a build from the\n' +
    '  release instead: see docs/EXE.md',
  );
  process.exit(1);
}
run(process.execPath, [esbuildScript]);
const bundleBytes = fs.statSync(out).size;
fs.rmSync(esbuildScript, { force: true });
process.stdout.write(`\nbundle: dist/majin.cjs (${(bundleBytes / 1024).toFixed(0)} kB)\n\n`);
if (noPkg) {
  process.stdout.write('done (--no-pkg). Try it: node dist/majin.cjs doctor\n');
  process.exit(0);
}

/* 3) pkg */
const major = process.versions.node.split('.')[0];
const targets = all
  ? [`node${major}-win-x64`, `node${major}-linuxstatic-x64`, `node${major}-macos-x64`]
  : [process.env.PKG_TARGET || `node${process.versions.node.split('.')[0]}-win-x64`];
const cfg = path.join(dist, 'pkg.config.json');
fs.writeFileSync(
  cfg,
  `${JSON.stringify(
    {
      name: 'majin',
      version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
      bin: 'majin.cjs',
      pkg: {
        assets: ['ui/**/*', 'rules/**/*', 'assets/**/*', 'package.json'],
        scripts: [],
        targets,
        // pkg's own default for bytecode: `bytecode:false` becomes --no-bytecode, which
        // is what pkg's Windows run died on ("Please run with -d and without
        // --no-bytecode"). The default path is the supported one; size is not the goal.
      },
    },
    null,
    2,
  )}\n`,
);

/**
 * Put the M icon inside the .exe so the taskbar shows the logo. resedit is a
 * devDependency, and scripts/set-icon.mjs restores the original file if anything
 * about the patch looks wrong -- so this can only ever be a nicer icon, never a
 * broken binary. Set MAJIN_NO_ICON=1 to skip it entirely.
 */
function embedExeIcon(exe) {
  if (process.env.MAJIN_NO_ICON === '1') {
    console.log('  icon      skipped (MAJIN_NO_ICON=1)');
    return;
  }
  const ico = path.join(dist, 'assets', 'majin.ico');
  if (!fs.existsSync(ico)) {
    console.log('  icon      skipped (no assets/majin.ico)');
    return;
  }
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'set-icon.mjs'), exe, ico], {
    encoding: 'utf8',
    timeout: 180000,
  });
  const line = String(r.stdout || r.stderr || 'icon: no output').trim().split('\n').pop();
  console.log('  ' + line);
  if (r.error) console.log('  icon      spawn error: ' + r.error.message);
  /* a release with the default icon has shipped looking "old" before —
     never again: unless explicitly skipped, a failed embed FAILS the build. */
  if (!/now carries/.test(line) && !process.env.MAJIN_NO_ICON) {
    console.log('  icon      FAILED -- refusing to ship an exe with the default icon (MAJIN_NO_ICON=1 skips this)');
    process.exit(1);
  }
}

const pkgBin = ['node_modules/@yao-pkg/pkg/lib-es5/bin.js', 'node_modules/@yao-pkg/pkg/lib-es/bin.js', 'node_modules/@yao-pkg/pkg/lib/bin.js']
  .map((r) => path.join(root, ...r.split('/')))
  .find((f) => fs.existsSync(f));
if (!pkgBin) throw new Error('pkg not found — run: npm i -D @yao-pkg/pkg');

const made = [];
for (const t of targets) {
  const name = t.includes('win') ? 'majin-win-x64.exe' : t.includes('linux') ? 'majin-linux-x64' : 'majin-macos-x64';
  try {
    run(process.execPath, [pkgBin, out, '--config', cfg, '--targets', t, '--output', path.join(dist, name)], {
      env: { ...process.env, PKG_CACHE_PATH: path.join(root, '.pkg-cache') },
    });
  } catch (e) {
    process.stdout.write(`\n! ${t} could not be built: ${e.message}\n  (pkg needs the node host binary from github.com release assets — build where that is reachable, or run "node dist/majin.cjs")\n`);
    continue;
  }
  const p2 = path.join(dist, name);
  if (fs.existsSync(p2)) {
    made.push(name);
    process.stdout.write(`\n✔ ${name} (${(fs.statSync(p2).size / 1024 / 1024).toFixed(1)} MB)\n`);
    if (name === 'majin-linux-x64') fs.chmodSync(p2, 0o755);
    if (name.endsWith('.exe')) embedExeIcon(p2);
    /* checksum sidecar at build time — the release glob must find it, and the
       in-app updater verifies downloads against it */
    {
      const { createHash } = await import('node:crypto');
      const h = createHash('sha256').update(fs.readFileSync(p2)).digest('hex');
      fs.writeFileSync(p2 + '.sha256', `${h}  ${name}`);
      process.stdout.write(`  sha256:   ${h.slice(0, 18)}…\n`);
    }
  }
}
/* ett bygge som inte producerade nagon binar ar ett misslyckande, inte en varning:
   annars later CI som att majin-win-x64.exe finns och den som laddar ner den far leta */
if (!made.length) {
  process.stdout.write('\n✖ no binary was produced. pkg could not fetch its node host binary (it needs the pkg-fetch release assets from github.com).\n');
  process.stdout.write('  Either build where that download works, or run the bundle directly: node dist/majin.cjs\n');
  process.exit(1);
}
process.stdout.write(`\nDone. ${made.join(', ')} in dist/ (not in git).\n`);
