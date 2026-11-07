#!/usr/bin/env node
/**
 * Assemble `MAJIN-Setup.exe` with Inno Setup.
 *
 * The compiler (`iscc.exe`) only runs on Windows, so on any other machine this
 * script prepares the whole staging folder and prints the one command to finish
 * the job -- and `--print` does exactly that without touching anything. What it
 * refuses to do is invent an installer: if `dist/majin-win-x64.exe` is missing it
 * says so, because the alternative is a Setup.exe with no program inside.
 *
 *   node scripts/build-installer.mjs            # stage + iscc (Windows)
 *   node scripts/build-installer.mjs --print    # what would happen
 *   node scripts/build-installer.mjs --stage    # staging folder only
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const inst = path.join(root, 'installer');
const outDir = path.join(root, 'dist', 'installer');
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function note(m) {
  process.stdout.write(m + '\n');
}
function fail(m, code = 1) {
  process.stderr.write(`build-installer: ${m}\n`);
  process.exit(code);
}

const exe = path.join(root, 'dist', 'majin-win-x64.exe');
const ico = path.join(root, 'dist', 'assets', 'majin.ico');

// 1) stage: the three files the .iss reads from its own folder
const cmd = [
  '@echo off',
  '"%~dp0majin-win-x64.exe" %*',
  '',
].join('\r\n');
if (has('--print')) {
  note(`stage   ${path.relative(root, exe)} -> installer/majin-win-x64.exe`);
  note(`stage   ${path.relative(root, ico)} -> installer/majin.ico`);
  note('write   installer/majin.cmd (runs the exe so "majin" works from PATH)');
  note('iscc    /DMyAppVersion=' + pkg.version + ' installer/majin.iss  ->  dist/installer/MAJIN-Setup.exe');
  note(`verify  dist/installer/MAJIN-Setup.exe (needs Windows: iscc.exe is not portable)`);
  process.exit(0);
}

if (!fs.existsSync(exe)) {
  fail(
    'dist/majin-win-x64.exe is missing -- build it first:\n' +
      '  npm run exe            (pkg + the M icon, on Windows)\n' +
      '  or let CI do it:       gh workflow run build-exe.yml',
  );
}
if (!fs.existsSync(ico)) fail('dist/assets/majin.ico is missing -- build the Windows EXE first so icon generation uses the current brand PNG');

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(exe, path.join(inst, 'majin-win-x64.exe'));
fs.copyFileSync(ico, path.join(inst, 'majin.ico'));
fs.copyFileSync(path.join(root, 'installer', 'MAJIN.vbs'), path.join(inst, 'MAJIN.vbs'));
note('stage   installer/MAJIN.vbs -> installer staging');
fs.writeFileSync(path.join(inst, 'majin.cmd'), cmd);
note(`staged  installer/{majin-win-x64.exe,majin.ico,majin.cmd} for ${pkg.version}`);
if (has('--stage')) process.exit(0);

// 2) compile with Inno Setup when it is here
function findIscc() {
  const cands = [
    process.env.ISCC,
    'iscc',
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
  ].filter(Boolean);
  for (const c of cands) {
    const r = spawnSync(c, ['/?', ...[]], { encoding: 'utf8', timeout: 20000 });
    if (!r.error && (r.status === 0 || r.status === 1)) return c;
  }
  return null;
}
const iscc = findIscc();
if (!iscc) {
  fail(
    'Inno Setup is not installed here. On Windows:  choco install innosetup -y   (or winget install JRSoftware.InnoSetup)\n' +
      '  then:  npm run installer\n' +
      `  the staging folder is ready, and "node scripts/build-installer.mjs --print" shows the command.`,
  );
}
const r = spawnSync(iscc, [`/DMyAppVersion=${pkg.version}`, path.join(inst, 'majin.iss')], {
  cwd: root,
  encoding: 'utf8',
  timeout: 600000,
});
if (r.stdout) note(String(r.stdout).trim().split('\n').slice(-6).join('\n'));
if (r.status !== 0) fail('iscc exited ' + r.status + '\n' + String(r.stderr || '').slice(0, 1200));

const setup = path.join(outDir, 'MAJIN-Setup.exe');
if (!fs.existsSync(setup)) fail('iscc reported success but there is no dist/installer/MAJIN-Setup.exe');
const size = fs.statSync(setup).size;
if (size < 1024 * 1024) fail(`MAJIN-Setup.exe is ${(size / 1024).toFixed(0)} kB -- too small to contain the program`);
const b = Buffer.alloc(2, 0);
const fd = fs.openSync(setup, 'r');
fs.readSync(fd, b, 0, 2, 0);
fs.closeSync(fd);
if (b.toString('latin1') !== 'MZ') fail('the produced file is not a Windows executable');
note(`done    dist/installer/MAJIN-Setup.exe (${(size / 1024 / 1024).toFixed(1)} MB, MZ ok)`);

/* ship the checksum beside the installer: the in-app updater verifies the
   downloaded bytes against the release's published .sha256 (update.js) — the
   file MUST exist at glob time, so produce it here, not in a flaky CI step */
{
  const { createHash } = await import('node:crypto');
  const h = createHash('sha256').update(fs.readFileSync(setup)).digest('hex');
  fs.writeFileSync(setup + '.sha256', `${h}  ${path.basename(setup)}`);
  note(`sha256  ${h.slice(0, 18)}…  -> dist/installer/MAJIN-Setup.exe.sha256`);
}
