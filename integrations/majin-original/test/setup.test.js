/**
 * The double-click installer: majin-setup.exe.
 *
 * Two of these tests need a compiler and therefore skip without one — the
 * payload and the script itself are checked everywhere, because that is where
 * the mistakes hide (a tar missing ui/ installs a program that cannot serve a
 * window; a setup.ps1 that touches the machine PATH the wrong way leaves a
 * truncated PATH behind).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SETUP = path.join(ROOT, 'dist', 'setup');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// the payload test has to build the bundle, and a bare checkout (no npm install)
// has no esbuild — that is a skip with a hint, not a red suite
const canBundle = spawnSync(process.execPath, ['-e', "require('esbuild')"], { cwd: ROOT, encoding: 'utf8' }).status === 0;

function build(args) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-setup.mjs'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 600000,
  });
}

test('setup: the payload is a MAJIN that runs, file by file', { skip: canBundle ? false : 'needs esbuild — run: npm install' }, () => {
  const r = build(['--payload-only']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(SETUP, 'payload.tar.gz')), 'the build must leave a payload');
  const listing = spawnSync('tar', ['-tzf', path.join(SETUP, 'payload.tar.gz')], { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  const list = listing.stdout.split(/\r?\n/);
  for (const want of [
    'dist/majin.cjs',
    'dist/ui/index.html',
    'dist/ui/app.js',
    'dist/ui/logo.png',
    'dist/rules/majin.yar',
    'dist/assets/majin.ico',
    'setup.ps1',
    'INSTALL-NOTE.txt',
  ]) {
    assert.ok(list.includes(want), `the payload must carry ${want}; got ${list.join(' ')}`);
  }
  // 1.8 MB of design files is not something a user should download to get an app
  assert.ok(!list.includes('dist/assets/majin.png'), 'keep the big source render out of the payload');
  const size = fs.statSync(path.join(SETUP, 'payload.tar.gz')).size;
  assert.ok(size > 100000, `a 100 kB payload cannot hold the bundle: ${size}`);
  assert.ok(size < 900000, `the installer should stay small: ${size} B`);
  const hdr = read('dist/setup/payload.h');
  assert.match(hdr, /#define MAJIN_VERSION "\d+\.\d+\.\d+(?:-[\w.]+)?"/, 'the stub knows the version it installs');
  assert.match(hdr, /#define MAJIN_PAYLOAD_LEN \d+UL/);
  assert.match(hdr, /#define MAJIN_PAYLOAD_SHA256 "[0-9a-f]{64}"/);
  const declared = Number(/MAJIN_PAYLOAD_LEN (\d+)UL/.exec(hdr)[1]);
  assert.equal(declared, size, 'the length baked into the stub must be the payload length');
});

test('setup: setup.ps1 is readable, needs no admin and avoids the dangerous moves', () => {
  const ps = read('setup/setup.ps1');
  assert.match(ps, /param\(/, 'it must take switches, not edit-the-script behaviour');
  // the switches are the contract: each one must be a declared parameter, not a
  // magic environment variable somebody has to know about
  for (const [kind, name] of [
    ['string', 'Target'],
    ['string', 'NodeUrl'],
    ['switch', 'NoStart'],
    ['switch', 'NoPath'],
    ['switch', 'NoShortcut'],
    ['switch', 'DryRun'],
  ]) {
    assert.match(ps, new RegExp(`\\[${kind}\\]\\$${name}\\b`), `setup.ps1 must declare [${kind}]$${name}`);
  }
  assert.match(ps, /-DryRun|\\$DryRun/, 'and the header comment shows how to use it');
  assert.match(ps, /SetEnvironmentVariable\('Path', \$new, 'User'\)/, 'user-scope PATH via .NET');
  assert.doesNotMatch(ps, /^\s*setx\b/m, 'setx truncates PATH at 1024 characters — never invoked');
  assert.match(ps, /not setx|1024/, 'the comment must say why');
  assert.doesNotMatch(ps, /Invoke-Expression|iex /, 'nothing gets evaluated from a string');
  assert.doesNotMatch(ps, /HKLM|New-Item -Path 'HK/, 'no machine registry writes: no admin needed');
  assert.match(ps, /nodejs\.org\/dist\//, 'node comes from the official distribution');
  assert.match(ps, /https:\/\//, 'over https');
  assert.match(ps, /OpenJS\.NodeJS\.LTS/, 'and the fallback is the winget id, not a dead link');
  assert.match(ps, /OneDrive\\Desktop|'OneDrive' /, 'the Desktop is often redirected by OneDrive');
  assert.match(ps, /WScript\.Shell/, 'the shortcut is a plain .lnk');
  assert.match(ps, /IconLocation = "\$icon,0"/, 'the icon comes from the payload, not a download');
  assert.match(ps, /%~dp0\.\.\\dist\\majin\.cjs/, 'the wrapper runs the bundled app from its own folder');
  assert.match(ps, /MAJIN_HOME/, 'it must not start guessing new data locations');
  assert.match(ps, /22\.0/, 'the documented node floor is enforced, not assumed');
});

test('setup: the stub does four things and nothing fifth', () => {
  const c = read('setup/stub.c');
  assert.doesNotMatch(c, /#include <windows\.h>/, 'no Win32 API: that is what makes it testable on any OS');
  assert.match(c, /MAJIN_SETUP_CMD/, 'the handover is replaceable — that is how it is tested here');
  assert.match(c, /"--print"/, '--print must exist before anything touches the disk');
  assert.match(c, /"--dir"/, 'and a target the user can point at a folder they own');
  assert.match(c, /MAJIN_SETUP_DIR/, 'with an env form too');
  assert.match(c, /unknown argument/, 'a typo is refused, not ignored');
  assert.match(c, /remove\(payload\)/, 'the tarball is cleaned up unless --keep');
  assert.doesNotMatch(c, /https?:\/\/|curl|WinHTTP|URLDownload/, 'the stub downloads nothing itself — node is setup.ps1:s job');
});

const skipIfMissing = (name) =>
  (fs.existsSync(path.join(SETUP, name)) ? false : `needs dist/setup/${name} — run: npm run setup:exe`);

test('setup: majin-setup.exe is a real x64 console PE, and the manifest is not lying', { skip: skipIfMissing('majin-setup.exe') }, () => {
    const exe = fs.readFileSync(path.join(SETUP, 'majin-setup.exe'));
    const at = exe.readUInt32LE(0x3c);
    assert.equal(exe.slice(0, 2).toString('latin1'), 'MZ');
    assert.equal(exe.slice(at, at + 4).toString('latin1'), 'PE\u0000\u0000');
    assert.equal(exe.readUInt16LE(at + 4), 0x8664, 'x64');
    assert.equal(exe.readUInt16LE(at + 24 + 68), 3, 'console subsystem, so double-clicking shows output');
    const man = JSON.parse(fs.readFileSync(path.join(SETUP, 'manifest.json'), 'utf8'));
    assert.equal(man.bytes, exe.length, 'manifest size');
    assert.equal(man.sha256, crypto.createHash('sha256').update(exe).digest('hex'), 'manifest hash');
    const hdr = read('dist/setup/payload.h');
    assert.equal(/MAJIN_PAYLOAD_SHA256 "([0-9a-f]{64})"/.exec(hdr)[1], man.payload.sha256, 'the manifest hash is the hash that is inside the exe');
    const payload = fs.readFileSync(path.join(SETUP, 'payload.tar.gz'));
    assert.equal(crypto.createHash('sha256').update(payload).digest('hex'), man.payload.sha256, 'and it matches the file on disk');
    assert.equal(man.payload.bytes, payload.length, 'plus its size');
    const s = exe.toString('latin1');
    for (const bad of ['LIBGCC', 'winpthread', 'ucrt', 'msvcrt.dll']) {
      assert.ok(!s.includes(bad), `the exe must not need ${bad}: it has to run on a bare Windows install`);
    }
});

test('setup: the same stub, compiled for this machine, installs a MAJIN that runs', { skip: skipIfMissing('majin-setup') }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-setup-'));
    const home = path.join(dir, 'h');
    const ps1 = path.join(dir, 'setup.ps1');
    const checker = path.join(dir, 'check.sh');
    fs.writeFileSync(
      checker,
      [
        '#!/bin/sh',
        `root=$(dirname "$1")`,
        `test -f "$root/dist/majin.cjs" || { echo "no bundle"; exit 3; }`,
        `test -f "$root/dist/ui/index.html" || { echo "no ui"; exit 4; }`,
        `test -f "$root/setup.ps1" || { echo "no setup.ps1"; exit 5; }`,
        `MAJIN_HOME="${home}" MAJIN_WORKSPACE="${home}-ws" node "$root/dist/majin.cjs" version`,
        `MAJIN_HOME="${home}" MAJIN_WORKSPACE="${home}-ws" node "$root/dist/majin.cjs" doctor >/dev/null 2>&1; echo "doctor=$?"`,
        `test -f "$root/payload.tar.gz" && echo "payload left behind"`,
        'echo INSTALLED_OK',
      ].join('\n'),
      { mode: 0o755 },
    );

    const shown = spawnSync(path.join(SETUP, 'majin-setup'), ['--print'], {
      encoding: 'utf8',
      env: { ...process.env, MAJIN_SETUP_DIR: dir },
    });
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /^write   /m, 'print mode leads with the payload it would write');
    assert.match(shown.stdout, /tar -xf/);
    assert.equal(fs.existsSync(path.join(dir, 'dist')), false, '--print may not install anything');

    const run = spawnSync(path.join(SETUP, 'majin-setup'), ['--dir', dir], {
      encoding: 'utf8',
      env: { ...process.env, MAJIN_SETUP_DIR: dir, MAJIN_SETUP_CMD: checker },
      timeout: 120000,
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /INSTALLED_OK/, 'the extracted app must be a working MAJIN: ' + run.stdout);
    assert.match(run.stdout, /majin \d+\.\d+\.\d+ · node /, 'the installed bundle answers version');
    assert.match(run.stdout, /doctor=0/, 'and doctor is green on a virgin home');
    assert.match(run.stdout, /^done    majin /m, 'the stub reports where it put it');

    const bad = spawnSync(path.join(SETUP, 'majin-setup'), ['--definitely-not-a-flag'], { encoding: 'utf8' });
    assert.equal(bad.status, 2, 'typos exit 2 like a CLI should');
    assert.match(bad.stderr, /unknown argument/);
    fs.rmSync(dir, { recursive: true, force: true });
});
