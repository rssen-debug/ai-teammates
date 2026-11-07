/**
 * Unattended updates, proven as processes.
 *
 * The owner's requirement: after one install he should never run a PowerShell
 * command again. That is only true if the *scheduled* path works without an
 * environment — no MAJIN_V4_RELEASE_URL in a Task Scheduler context, no TTY.
 *
 * This test builds a real signed release, runs the real setup flow to pin the
 * key and write the channel, serves the release over HTTP, and applies it with
 * the real CLI into a throwaway copy of the repository. Then it does the same
 * with an unhealthy host and proves the previous version is restored.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readUpdateConfig, writeUpdateConfig } from '../../src/v4/updater.js';
import { tempHome } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function runNode(script, args, env) {
  const res = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, MAJIN_V4_RELEASE_URL: '', ...env },
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

/**
 * Async variant. The release is served by an HTTP server inside THIS process,
 * so a spawnSync child would block the event loop that has to answer it — the
 * updater would hang until its timeout.
 */
function runNodeAsync(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, MAJIN_V4_RELEASE_URL: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, out });
    });
  });
}

function copyRepo(dest) {
  fs.cpSync(ROOT, dest, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (!rel) return true;
      if (rel === '.git' || rel.startsWith(`.git${path.sep}`)) return false;
      if (rel === 'node_modules' || rel.startsWith(`node_modules${path.sep}`)) return false;
      if (rel === 'desktop' || rel.startsWith(`desktop${path.sep}`)) return false;
      return true;
    },
  });
}

function serveDir(dir, { health = 200 } = {}) {
  const server = http.createServer((req, res) => {
    const url = String(req.url || '/').split('?')[0];
    if (url === '/health') {
      res.writeHead(health, { 'content-type': 'text/plain' });
      res.end(health === 200 ? 'ok' : 'unhealthy');
      return;
    }
    const rel = decodeURIComponent(url).replace(/^\/+/, '');
    const file = path.join(dir, rel);
    if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function buildRelease(home) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keyFile = path.join(home, 'private.pem');
  const out = path.join(home, 'release');
  const publicFile = path.join(home, 'public.pem');
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(publicFile, publicKey.export({ type: 'spki', format: 'pem' }));
  const res = runNode(path.join(ROOT, 'scripts', 'v4', 'release.mjs'), ['--key', keyFile, '--out', out], {});
  assert.equal(res.status, 0, res.out);
  return { publicFile, out };
}

/** A throwaway host: the repository copy plus an older version number. */
function makeOldHost(home, name) {
  const live = path.join(home, name);
  copyRepo(live);
  // A real installation has installed dependencies. They are deliberately NOT
  // part of a release, and the activation must carry them across.
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(live, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const pkg = JSON.parse(fs.readFileSync(path.join(live, 'package.json'), 'utf8'));
  const released = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  pkg.version = '3.9.0';
  fs.writeFileSync(path.join(live, 'package.json'), JSON.stringify(pkg, null, 2));
  return { live, released };
}

test('update channel: the config round-trips and refuses a downgrade of transport security', () => {
  const home = tempHome();
  const file = path.join(home, 'update.json');
  try {
    const saved = writeUpdateConfig(file, { releaseUrl: 'https://releases.example.com/majin', auto: true, time: '04:30' });
    assert.equal(saved.auto, true);
    const read = readUpdateConfig(file);
    assert.equal(read.releaseUrl, 'https://releases.example.com/majin');
    assert.equal(read.time, '04:30');

    // http is only allowed for loopback (the release-flow test runs there).
    assert.throws(() => writeUpdateConfig(file, { releaseUrl: 'http://releases.example.com' }), /https/);
    assert.throws(() => writeUpdateConfig(file, { time: '25:99' }), /HH:MM/);
    fs.writeFileSync(file, JSON.stringify({ schema: 'wrong', releaseUrl: 'https://x' }));
    assert.equal(readUpdateConfig(file), null, 'a file with the wrong schema is not trusted');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('update channel: setup writes the channel so a scheduled task needs no environment', () => {
  const home = tempHome();
  try {
    const res = runNode(path.join(ROOT, 'scripts', 'v4', 'setup.mjs'),
      ['--release-url', 'https://releases.example.com/majin', '--update-time', '03:15'],
      { MAJIN_HOME: home });
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /channel https:\/\/releases\.example\.com\/majin/);
    const cfg = readUpdateConfig(path.join(home, 'v4', 'update.json'));
    assert.equal(cfg.releaseUrl, 'https://releases.example.com/majin');
    assert.equal(cfg.time, '03:15');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('update: a signed release installs from the saved channel and leaves a backup', async () => {
  const home = tempHome();
  const release = buildRelease(home);
  const { live, released } = makeOldHost(home, 'live');
  const server = await serveDir(release.out);
  try {
    // One setup flow: pin the key + configure the channel.
    const setup = await runNodeAsync(path.join(live, 'scripts', 'v4', 'setup.mjs'),
      ['--release-url', server.url],
      { MAJIN_HOME: home, MAJIN_V4_RELEASE_KEY_PUB: release.publicFile });
    assert.equal(setup.status, 0, setup.out);

    const check = await runNodeAsync(path.join(live, 'scripts', 'v4', 'update.mjs'), ['check'],
      { MAJIN_HOME: home, MAJIN_V4_HEALTH_URL: `${server.url}/health` });
    assert.equal(check.status, 0, check.out);
    assert.match(check.out, new RegExp(`available: ${released.replace(/\./g, '\\.')}`));

    const apply = await runNodeAsync(path.join(live, 'scripts', 'v4', 'update.mjs'), ['apply', '--quiet', '--log'],
      { MAJIN_HOME: home, MAJIN_V4_HEALTH_URL: `${server.url}/health` });
    assert.equal(apply.status, 0, apply.out);
    assert.equal(apply.out.trim(), '', `--quiet must be quiet, got: ${apply.out}`);

    const installed = JSON.parse(fs.readFileSync(path.join(live, 'package.json'), 'utf8')).version;
    assert.equal(installed, released, 'the live tree was not replaced by the release');
    assert.ok(fs.existsSync(path.join(live, 'node_modules')), 'activation deleted node_modules — the updated host could not start');
    assert.ok(fs.existsSync(path.join(home, 'v4', 'release-previous')), 'no rollback copy was kept');

    const log = fs.readFileSync(path.join(home, 'v4', 'logs', 'update.log'), 'utf8');
    assert.match(log, /\[updated\]/, 'the unattended run left no log line');
  } finally {
    await server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('update: a release that fails its health check is rolled back', async () => {
  const home = tempHome();
  const release = buildRelease(home);
  const { live } = makeOldHost(home, 'live');
  const healthy = await serveDir(release.out, { health: 200 });
  const unhealthy = await serveDir(release.out, { health: 503 });
  try {
    const setup = await runNodeAsync(path.join(live, 'scripts', 'v4', 'setup.mjs'),
      ['--release-url', healthy.url],
      { MAJIN_HOME: home, MAJIN_V4_RELEASE_KEY_PUB: release.publicFile });
    assert.equal(setup.status, 0, setup.out);

    const apply = await runNodeAsync(path.join(live, 'scripts', 'v4', 'update.mjs'), ['apply'],
      { MAJIN_HOME: home, MAJIN_V4_HEALTH_URL: `${unhealthy.url}/health` });
    assert.notEqual(apply.status, 0, 'a failed health check must not exit 0');
    assert.match(apply.out, /rolled back|previous version is running again/i);
    const version = JSON.parse(fs.readFileSync(path.join(live, 'package.json'), 'utf8')).version;
    assert.equal(version, '3.9.0', `the old version was not restored, found ${version}`);
  } finally {
    await healthy.close();
    await unhealthy.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
