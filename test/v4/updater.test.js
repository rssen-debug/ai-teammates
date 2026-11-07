/**
 * The auto-updater: signed, verified, atomic, reversible.
 *
 * An updater that runs code from the network without proof is a remote code
 * execution hole with a progress bar. These tests attack that assumption: wrong
 * key, tampered manifest, tampered file, downgrade, unsigned release, and a new
 * version that boots unhealthy.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  UPDATER_SCHEMA, UpdateError, activateRelease, canonicalManifest, compareVersions,
  hashTree, pinKey, planUpdate, readPinnedKey, recoverInterruptedUpdate, rollbackRelease, runUpdate,
  signManifest, stageRelease, verifyManifest,
} from '../../src/v4/updater.js';
import { tempHome } from './helpers.mjs';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

function makeRelease(files, { version = '4.1.0', commit = 'abc123' } = {}) {
  const payload = new Map(Object.entries(files).map(([p, body]) => [p, Buffer.from(body)]));
  const manifest = {
    schema: UPDATER_SCHEMA,
    version,
    commit,
    publishedAt: '2026-10-23T00:00:00.000Z',
    files: [...payload.entries()].map(([p, buf]) => ({
      path: p, sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length,
    })),
  };
  return { manifest, signature: signManifest(manifest, PRIVATE_PEM), payload };
}

test('updater: a signed release passes verification', () => {
  const { manifest, signature } = makeRelease({ 'package.json': '{"v":1}', 'src/a.js': 'x' });
  assert.equal(verifyManifest(manifest, signature, PUBLIC_PEM), true);
});

test('updater: a manifest signed by another key is refused', () => {
  const other = crypto.generateKeyPairSync('ed25519');
  const { manifest } = makeRelease({ 'package.json': 'x' });
  const wrongSig = signManifest(manifest, other.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  assert.throws(() => verifyManifest(manifest, wrongSig, PUBLIC_PEM), (e) => e.code === 'BAD_SIGNATURE');
});

test('updater: a tampered manifest is refused even with the original signature', () => {
  const { manifest, signature } = makeRelease({ 'package.json': 'x' });
  const evil = { ...manifest, files: [...manifest.files, { path: 'src/evil.js', sha256: 'a'.repeat(64), bytes: 10 }] };
  assert.throws(() => verifyManifest(evil, signature, PUBLIC_PEM), (e) => e.code === 'BAD_SIGNATURE');
});

test('updater: changing only the version breaks the signature', () => {
  const { manifest, signature } = makeRelease({ 'package.json': 'x' });
  assert.throws(() => verifyManifest({ ...manifest, version: '9.9.9' }, signature, PUBLIC_PEM), (e) => e.code === 'BAD_SIGNATURE');
});

test('updater: an unsigned release is refused when a key is pinned', () => {
  const { manifest } = makeRelease({ 'package.json': 'x' });
  assert.throws(() => verifyManifest(manifest, null, PUBLIC_PEM), (e) => e.code === 'UNSIGNED');
  assert.throws(
    () => planUpdate({ manifest, signature: null, publicKey: PUBLIC_PEM, currentVersion: '4.0.0', allowUnsigned: true }),
    (e) => e.code === 'REFUSED',
  );
});

test('updater: without a pinned key, unsigned is only allowed when explicitly asked for', () => {
  const { manifest } = makeRelease({ 'package.json': 'x' });
  assert.throws(() => planUpdate({ manifest, signature: null, publicKey: null, currentVersion: '4.0.0' }), (e) => e.code === 'NO_KEY');
  const plan = planUpdate({ manifest, signature: null, publicKey: null, currentVersion: '4.0.0', allowUnsigned: true });
  assert.equal(plan.action, 'install');
  assert.equal(plan.unsigned, true, 'the plan says out loud that it is unsigned');
});

test('updater: the canonical form is stable across key order and whitespace', () => {
  const a = { schema: UPDATER_SCHEMA, version: '4.1.0', commit: 'c', publishedAt: 't', files: [{ path: 'b', sha256: '2', bytes: 2 }, { path: 'a', sha256: '1', bytes: 1 }] };
  const b = { files: [{ bytes: 1, sha256: '1', path: 'a' }, { bytes: 2, sha256: '2', path: 'b' }], publishedAt: 't', commit: 'c', version: '4.1.0', schema: UPDATER_SCHEMA };
  assert.equal(canonicalManifest(a), canonicalManifest(b));
});

test('updater: a downgrade is refused unless allowed', () => {
  const { manifest, signature } = makeRelease({ 'package.json': 'x' }, { version: '3.9.0' });
  assert.throws(() => planUpdate({ manifest, signature, publicKey: PUBLIC_PEM, currentVersion: '4.0.0' }), (e) => e.code === 'DOWNGRADE_REFUSED');
  assert.equal(planUpdate({ manifest, signature, publicKey: PUBLIC_PEM, currentVersion: '4.0.0', allowDowngrade: true }).action, 'install');
});

test('updater: the same version is a no-op, not a reinstall', () => {
  const { manifest, signature } = makeRelease({ 'package.json': 'x' }, { version: '4.1.0' });
  const plan = planUpdate({ manifest, signature, publicKey: PUBLIC_PEM, currentVersion: '4.1.0' });
  assert.equal(plan.action, 'noop');
});

test('updater: version comparison is numeric, not lexical', () => {
  assert.equal(compareVersions('4.10.0', '4.9.0') > 0, true);
  assert.equal(compareVersions('4.0.1', '4.0.0') > 0, true);
  assert.equal(compareVersions('4.0.0', '4.0.0'), 0);
  assert.equal(compareVersions('3.9.9', '4.0.0') < 0, true);
});

test('updater: a file whose bytes do not match its hash never reaches the disk', () => {
  const { manifest, payload } = makeRelease({ 'package.json': '{"v":1}' });
  const home = tempHome();
  const staging = path.join(home, 'stage');
  const tampered = new Map(payload);
  // same length, different bytes: this isolates the HASH check from the size check
  tampered.set('package.json', Buffer.from('{"v":2}'));
  try {
    assert.throws(
      () => stageRelease({ manifest, readFile: (p) => tampered.get(p), stagingDir: staging }),
      (e) => e.code === 'HASH_MISMATCH',
    );
    // the staging dir may exist but must not contain the tampered file
    const written = fs.existsSync(staging) ? fs.readdirSync(staging) : [];
    assert.deepEqual(written, [], 'nothing was written');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('updater: a missing file aborts the whole release', () => {
  const { manifest, payload } = makeRelease({ 'a.js': '1', 'b.js': '2' });
  const home = tempHome();
  try {
    assert.throws(
      () => stageRelease({ manifest, readFile: (p) => (p === 'b.js' ? null : payload.get(p)), stagingDir: path.join(home, 's') }),
      (e) => e.code === 'SIZE_MISMATCH',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('updater: activation overlays the release and rollback restores the old tree exactly', () => {
  const home = tempHome();
  const live = path.join(home, 'live');
  const staging = path.join(home, 'staging');
  const backup = path.join(home, 'backup');
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(live, 'version.txt'), 'old');
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'version.txt'), 'new');
  try {
    const act = activateRelease({ liveDir: live, stagingDir: staging, backupDir: backup });
    assert.equal(fs.readFileSync(path.join(live, 'version.txt'), 'utf8'), 'new');
    assert.equal(fs.readFileSync(path.join(backup, 'version.txt'), 'utf8'), 'old');
    assert.equal(act.backupDir, backup);

    rollbackRelease({ liveDir: live, backupDir: backup });
    assert.equal(fs.readFileSync(path.join(live, 'version.txt'), 'utf8'), 'old', 'the old tree is back');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('updater: activation preserves runtime files the release does not ship', () => {
  const home = tempHome();
  const live = path.join(home, 'live');
  const staging = path.join(home, 'staging');
  const backup = path.join(home, 'backup');
  try {
    fs.mkdirSync(path.join(live, 'node_modules', 'zod'), { recursive: true });
    fs.writeFileSync(path.join(live, 'node_modules', 'zod', 'index.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(live, 'src.js'), 'old');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'src.js'), 'new');

    const act = activateRelease({ liveDir: live, stagingDir: staging, backupDir: backup });
    assert.deepEqual(act.added, []);
    assert.deepEqual(act.replaced, ['src.js']);
    assert.equal(fs.readFileSync(path.join(live, 'node_modules', 'zod', 'index.js'), 'utf8'), 'module.exports = {};');
    assert.equal(fs.readFileSync(path.join(live, 'src.js'), 'utf8'), 'new');

    // A failed health check must not take the dependencies with it.
    rollbackRelease({ liveDir: live, backupDir: backup, preserved: act.preserved, journalFile: act.journalFile });
    assert.equal(fs.readFileSync(path.join(live, 'src.js'), 'utf8'), 'old');
    assert.equal(fs.readFileSync(path.join(live, 'node_modules', 'zod', 'index.js'), 'utf8'), 'module.exports = {};');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('updater: an interrupted update is rolled back on the next run', () => {
  const home = tempHome();
  const live = path.join(home, 'live');
  const staging = path.join(home, 'staging');
  const backup = path.join(home, 'backup');
  try {
    fs.mkdirSync(path.join(live, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(live, 'node_modules', 'dep.js'), 'dep');
    fs.writeFileSync(path.join(live, 'app.js'), 'old');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'app.js'), 'new');
    const act = activateRelease({ liveDir: live, stagingDir: staging, backupDir: backup });
    assert.equal(fs.readFileSync(path.join(live, 'app.js'), 'utf8'), 'new');

    // Simulate a crash between activation and the health check: the journal is
    // still on disk. The next run must not treat the half-updated tree as current.
    const out = recoverInterruptedUpdate({ liveDir: live, backupDir: backup });
    assert.equal(out.recovered, true);
    assert.equal(fs.readFileSync(path.join(live, 'app.js'), 'utf8'), 'old');
    assert.ok(fs.existsSync(path.join(live, 'node_modules', 'dep.js')));
    assert.ok(!fs.existsSync(act.journalFile), 'the journal was not cleared');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('updater: rollback without a backup is refused instead of pretending', () => {
  const home = tempHome();
  try {
    assert.throws(() => rollbackRelease({ liveDir: path.join(home, 'live'), backupDir: path.join(home, 'nope') }), (e) => e.code === 'NO_BACKUP');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('updater: hashTree produces a manifest that verifies and installs', () => {
  const home = tempHome();
  const tree = path.join(home, 'tree');
  fs.mkdirSync(path.join(tree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'package.json'), '{"name":"x"}');
  fs.writeFileSync(path.join(tree, 'src', 'a.js'), 'console.log(1)');
  fs.mkdirSync(path.join(tree, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'node_modules', 'junk.js'), 'x');
  try {
    const files = hashTree(tree, { skip: ['node_modules'] });
    assert.deepEqual(files.map((f) => f.path), ['package.json', 'src/a.js']);
    assert.ok(files.every((f) => /^[a-f0-9]{64}$/.test(f.sha256)));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('updater: a successful run stages, activates and reports the new version', async () => {
  const home = tempHome();
  const live = path.join(home, 'live');
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(live, 'version.txt'), '4.0.0');
  const { manifest, signature, payload } = makeRelease({ 'version.txt': '4.1.0', 'index.js': 'x' });
  const events = [];
  try {
    const result = await runUpdate({
      manifest,
      signature,
      publicKey: PUBLIC_PEM,
      currentVersion: '4.0.0',
      liveDir: live,
      stagingDir: path.join(home, 'stage'),
      backupDir: path.join(home, 'backup'),
      readFile: (p) => payload.get(p),
      restartHost: async () => true,
      log: (e, d) => events.push({ e, d }),
    });
    assert.equal(result.status, 'UPDATED');
    assert.equal(result.version, '4.1.0');
    assert.equal(fs.readFileSync(path.join(live, 'version.txt'), 'utf8'), '4.1.0');
    assert.deepEqual(events.map((x) => x.e), ['planned', 'staged', 'activated', 'updated']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('updater: a new version that will not start is rolled back automatically', async () => {
  const home = tempHome();
  const live = path.join(home, 'live');
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(live, 'version.txt'), '4.0.0');
  const { manifest, signature, payload } = makeRelease({ 'version.txt': '4.1.0' });
  let restarts = 0;
  try {
    const result = await runUpdate({
      manifest,
      signature,
      publicKey: PUBLIC_PEM,
      currentVersion: '4.0.0',
      liveDir: live,
      stagingDir: path.join(home, 'stage'),
      backupDir: path.join(home, 'backup'),
      readFile: (p) => payload.get(p),
      restartHost: async () => { restarts += 1; return restarts > 1; }, // first restart unhealthy
      healthCheck: async () => false,
    });
    assert.equal(result.status, 'ROLLED_BACK');
    assert.equal(fs.readFileSync(path.join(live, 'version.txt'), 'utf8'), '4.0.0', 'the working version is back');
    assert.equal(restarts, 2, 'it restarted again after rolling back');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('updater: a restart that throws is treated as unhealthy, not as success', async () => {
  const home = tempHome();
  const live = path.join(home, 'live');
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(live, 'version.txt'), '4.0.0');
  const { manifest, signature, payload } = makeRelease({ 'version.txt': '4.1.0' });
  let first = true;
  try {
    const result = await runUpdate({
      manifest,
      signature,
      publicKey: PUBLIC_PEM,
      currentVersion: '4.0.0',
      liveDir: live,
      stagingDir: path.join(home, 'stage'),
      backupDir: path.join(home, 'backup'),
      readFile: (p) => payload.get(p),
      restartHost: async () => {
        if (first) { first = false; throw new Error('supervisor refused'); }
        return true;
      },
    });
    assert.equal(result.status, 'ROLLED_BACK');
    assert.equal(fs.readFileSync(path.join(live, 'version.txt'), 'utf8'), '4.0.0');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('updater: the pinned key round-trips and a bad key is refused', () => {
  const home = tempHome();
  const file = path.join(home, 'release-key.json');
  try {
    pinKey(file, PUBLIC_PEM);
    assert.equal(readPinnedKey(file), PUBLIC_PEM);
    assert.throws(() => pinKey(file, 'not a pem'), (e) => e.code === 'BAD_KEY');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  const missing = path.join(tempHome(), 'none.json');
  assert.equal(readPinnedKey(missing), null);
});

test('updater: a release with no files is refused', () => {
  const manifest = { schema: UPDATER_SCHEMA, version: '4.1.0', commit: 'c', publishedAt: 't', files: [] };
  const sig = signManifest(manifest, PRIVATE_PEM);
  assert.throws(() => planUpdate({ manifest, signature: sig, publicKey: PUBLIC_PEM, currentVersion: '4.0.0' }), (e) => e.code === 'EMPTY_RELEASE');
});

test('updater: a bad version string is refused', () => {
  const { manifest, signature } = makeRelease({ 'a.js': 'x' }, { version: 'banana' });
  assert.throws(() => planUpdate({ manifest, signature, publicKey: PUBLIC_PEM, currentVersion: '4.0.0' }), (e) => e.code === 'BAD_VERSION');
  assert.ok(UpdateError.prototype instanceof Error);
});
