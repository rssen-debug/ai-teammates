import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { V4_VERSION } from '../../src/v4/config.js';

const root = path.resolve(import.meta.dirname, '../..');
const entry = path.join(root, 'bin/majin.mjs');

test('product CLI reports the package version and rejects accidental legacy operations', () => {
  const version = spawnSync(process.execPath, [entry, '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.ok(version.stdout.startsWith(`majin ${V4_VERSION} · node `));
  const unsupported = spawnSync(process.execPath, [entry, 'config', 'set', 'server.token', 'example'], { encoding: 'utf8' });
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /Unknown V4 command/);
});

test('product serve entry starts the V4 host and shares its durable data', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-product-entry-'));
  const env = { ...process.env, MAJIN_HOME: home, MAJIN_V4_PROVIDER: 'demo', MAJIN_V4_PUBLIC_ORIGIN: '', MAJIN_V4_HOST_LANES: '' };
  const child = spawn(process.execPath, [entry, '_serve', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  let errors = '';
  child.stderr.on('data', (data) => { errors += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No V4 boot: ${output} ${errors}`)), 15000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Host exited: ${errors}`)); });
    child.stdout.on('data', (data) => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  const health = await (await fetch(`${origin}/api/health`)).json();
  assert.equal(health.version, V4_VERSION);
  assert.equal(health.app, 'majin');
  assert.equal((await fetch(`${origin}/api/state`)).status, 401);
  assert.ok(fs.existsSync(path.join(home, 'v4/secret.key')));
  assert.ok(!fs.existsSync(path.join(home, 'server.pid')), 'legacy runtime was not started');
});
