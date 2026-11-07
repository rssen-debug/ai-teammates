import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/core/version.js';
import * as U from '../src/core/update.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const pkg = JSON.parse(read('package.json'));

// The version is reported in five places (CLI, banner, /healthz, /api/state, the installer's display
// name) and compared against a GitHub tag by the updater. Every one of those is a place where a stale
// literal either lies to the user or makes a freshly installed program nag about an update it already has.

test('one version literal, and package.json agrees with it', () => {
  assert.equal(VERSION, pkg.version, 'src/core/version.js and package.json must say the same thing');
  // V2 channel policy: stable releases stay plain x.y.z; prerelease builds identify as
  // x.y.z-alpha / -beta / -rc / -nightly (optionally .N). The updater compares these
  // prerelease-aware via update.js compareVersions(), so praise-catching regex must allow the suffix.
  assert.match(VERSION, /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc|nightly)(?:\.\d+)?)?$/,
    'semver optional V2 channel suffix, as compareVersions() understands it');
  const src = read('src/core/version.js');
  assert.match(src, new RegExp("export const VERSION = '" + VERSION + "'"), 'the literal lives in exactly one file');
  // and nowhere else as a hardcoded string
  const hardcoded = [];
  for (const dir of ['src', 'scripts']) {
    for (const ent of fs.readdirSync(path.join(root, dir), { recursive: true, encoding: 'utf8' })) {
      if (!/\.(js|mjs)$/.test(ent) || ent.includes('node_modules') || ent.replace(/\\/g, '/') === 'core/version.js') continue;
      const body = read(dir, ent);
      if (/VERSION\s*=\s*['"]\d+\.\d+\.\d+(?:-[\w.]+)?['"]/.test(body) || /version:\s*['"]\d+\.\d+\.\d+(?:-[\w.]+)?['"]/.test(body)) hardcoded.push(ent);
    }
  }
  assert.deepEqual(hardcoded, [], 'these files invent their own version instead of importing it: ' + hardcoded.join(', '));
});

test('the installer shows the same version, from package.json', () => {
  const iss = read('installer', 'majin.iss');
  const m = iss.match(/#define MyAppVersion "([^"]+)"/);
  assert.ok(m, 'the .iss needs a default so it still compiles without the /D flag');
  assert.equal(m[1], pkg.version, 'and that default must not be a stale number');
  const build = read('scripts', 'build-installer.mjs');
  assert.match(build, /\/DMyAppVersion=\$\{pkg\.version\}/, 'the real value comes from package.json at build time');
  assert.match(iss, /AppVersion/, 'and the wizard/ARP entry uses it, so "MAJIN 0.1.1" is what Settings shows');
});

test('a freshly installed MAJIN never reports an update', () => {
  // this is the property the version split broke: app at 0.1.0, release at v0.1.1 -> permanent nag
  assert.equal(U.notice({ latest: VERSION }, VERSION), '', 'the version it shipped as is not an update');
  assert.equal(U.notice({ latest: 'v' + VERSION }, VERSION), '', 'with or without the tag prefix');
  const pub = read('scripts', 'publish.ps1');
  const dv = pub.match(/\[string\]\$Version\s*=\s*'([\w.-]+)'/);
  assert.ok(dv, 'publish.ps1 has a default version');
  assert.equal(dv[1], VERSION, 'and publishing that default does not put the app behind its own release');
  // V2 channel ordering pinned (release gates depend on it): alpha < beta < rc < stable
  assert.ok(U.compareVersions('2.0.0-alpha', '2.0.0-beta') < 0);
  assert.ok(U.compareVersions('2.0.0-beta', '2.0.0-rc.1') < 0);
  assert.ok(U.compareVersions('2.0.0-rc.1', '2.0.0') < 0);
  assert.ok(U.compareVersions('2.0.0-alpha', '2.0.0-alpha') === 0);
  assert.ok(U.compareVersions('2.0.0', '2.0.1-beta') < 0);
  // and a V2 prerelease must NEVER prompt a downgrade to the latest V1 stable
  assert.equal(U.notice({ latest: 'v1.0.9' }, VERSION), '', 'V1 tags are older than 2.0.0-alpha, never an update');
});

test('majin --version answers with it', () => {
  const out = execFileSync(process.execPath, [path.join(root, 'src', 'cli', 'majin.js'), '--version'], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, MAJIN_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'majin-ver-')), MAJIN_NO_UPDATE_CHECK: '1' },
  });
  assert.match(out, new RegExp('^majin ' + VERSION.replace(/\./g, '\\.') + ' · node '), '--version prints exactly the version: ' + JSON.stringify(out.trim()));
  assert.doesNotMatch(out, /listening|http:/, 'and does not start a server to say it');
});
