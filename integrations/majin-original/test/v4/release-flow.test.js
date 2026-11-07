/**
 * The release chain, end to end, as processes.
 *
 * `npm run v4:release` builds and signs; `npm run v4:setup` pins the key and
 * prepares the host; `npm run v4:update` verifies and applies. These run the real
 * scripts, because the owner's experience is the scripts, not the library.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { UPDATER_SCHEMA, verifyManifest } from '../../src/v4/updater.js';
import { tempHome } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function run(script, args = [], env = {}) {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts/v4', script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, ...env },
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

test('release: v4:release builds a signed manifest and proves its own signature', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const home = tempHome();
  const keyFile = path.join(home, 'private.pem');
  const out = path.join(home, 'release');
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));

  try {
    const res = run('release.mjs', ['--key', keyFile, '--out', out]);
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /signature verified/);

    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    const sig = fs.readFileSync(path.join(out, 'manifest.sig'), 'utf8').trim();
    assert.equal(manifest.schema, UPDATER_SCHEMA);
    assert.ok(manifest.files.length > 20, `only ${manifest.files.length} files in the release`);
    assert.ok(manifest.files.some((f) => f.path === 'package.json'));
    assert.ok(!manifest.files.some((f) => f.path.startsWith('test/')), 'tests are not shipped');
    assert.ok(!manifest.files.some((f) => f.path.startsWith('node_modules/')), 'dependencies are not shipped');

    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    assert.equal(verifyManifest(manifest, sig, publicPem), true);
    // and the shipped public key matches
    assert.equal(fs.readFileSync(path.join(out, 'public-key.pem'), 'utf8').trim(), publicPem.trim());
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('release: v4:release refuses without a key instead of shipping an unsigned release', () => {
  const res = run('release.mjs', []);
  assert.equal(res.status, 2);
  assert.match(res.out, /usage|no such key/);
});

test('setup: --check changes nothing and reports what is missing', () => {
  const home = tempHome();
  try {
    const before = fs.existsSync(path.join(home, 'v4', 'pairing.json'));
    const res = run('setup.mjs', ['--check'], { MAJIN_HOME: home });
    assert.match(res.out, /check only: nothing was changed/);
    assert.ok(res.out.includes(`Node ${process.versions.node}`), 'setup must report the actual runtime version');
    assert.match(res.out, />= 22 required/);
    assert.equal(fs.existsSync(path.join(home, 'v4', 'pairing.json')), before, 'check mode wrote a pairing file');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('setup: a real run issues a pairing code, seeds Owner Mode and is idempotent', () => {
  const home = tempHome();
  try {
    const first = run('setup.mjs', [], { MAJIN_HOME: home });
    assert.equal(first.status, 0, first.out);
    assert.match(first.out, /Parkod:/);

    const pairing = JSON.parse(fs.readFileSync(path.join(home, 'v4', 'pairing.json'), 'utf8'));
    assert.ok(pairing.hash, 'the code is stored hashed');

    const owner = JSON.parse(fs.readFileSync(path.join(home, 'v4', 'owner-mode.json'), 'utf8'));
    assert.deepEqual(owner.lanes.sort(), ['jobs', 'research', 'web']);
    assert.deepEqual(owner.folders, [], 'no folders are granted by the installer, deliberately');

    // a second run must not issue a new code
    const second = run('setup.mjs', [], { MAJIN_HOME: home });
    assert.match(second.out, /already exists/);
    assert.doesNotMatch(second.out, /Parkod:/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('setup: a provided release key is pinned and updates become possible', () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const home = tempHome();
  const keyFile = path.join(home, 'pub.pem');
  fs.writeFileSync(keyFile, publicKey.export({ type: 'spki', format: 'pem' }));
  try {
    const res = run('setup.mjs', [], { MAJIN_HOME: home, MAJIN_V4_RELEASE_KEY_PUB: keyFile });
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /pinned from|a release key is pinned/);
    const pinned = JSON.parse(fs.readFileSync(path.join(home, 'v4', 'release-key.json'), 'utf8'));
    assert.ok(pinned.publicKey.includes('BEGIN PUBLIC KEY'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('update: with no channel configured it says so and changes nothing', () => {
  const home = tempHome();
  try {
    const res = run('update.mjs', ['check'], { MAJIN_HOME: home, MAJIN_V4_RELEASE_URL: '' });
    assert.equal(res.status, 1);
    assert.match(res.out, /No release key is pinned|NO_RELEASE_URL/i);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('update: a pinned key with no channel refuses instead of guessing a source', () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const home = tempHome();
  const keyFile = path.join(home, 'pub.pem');
  fs.writeFileSync(keyFile, publicKey.export({ type: 'spki', format: 'pem' }));
  try {
    const setup = run('setup.mjs', [], { MAJIN_HOME: home, MAJIN_V4_RELEASE_KEY_PUB: keyFile });
    assert.equal(setup.status, 0, setup.out);
    const res = run('update.mjs', ['check'], { MAJIN_HOME: home, MAJIN_V4_RELEASE_URL: '' });
    assert.equal(res.status, 1);
    assert.match(res.out, /NO_RELEASE_URL/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
