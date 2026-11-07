#!/usr/bin/env node
/**
 * MAJIN V4 — updater CLI.
 *
 *   node scripts/v4/update.mjs check           what is available (no changes)
 *   node scripts/v4/update.mjs apply           verify, stage, activate, restart
 *   node scripts/v4/update.mjs apply --allow-unsigned   local testing only
 *
 * Where it looks: a GitHub release asset by default, overridable with
 * MAJIN_V4_RELEASE_URL. The manifest must be signed by the key pinned at
 * install time (`release-key.json` next to the data dir).
 *
 * Nothing here touches git. An update is a signed release, not a branch.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/v4/config.js';
import { spawnSync } from 'node:child_process';
import {
  UPDATER_SCHEMA, UpdateError, planUpdate, readPinnedKey, readUpdateConfig, recoverInterruptedUpdate, runUpdate,
} from '../../src/v4/updater.js';

const args = process.argv.slice(2);
const cmd = args[0] || 'check';
const flag = (n) => args.includes(n);
const config = loadConfig();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const liveDir = root;
const stagingDir = path.join(config.paths.root, 'release-staging');
const backupDir = path.join(config.paths.root, 'release-previous');
const keyFile = path.join(config.paths.root, 'release-key.json');
const versionFile = path.join(root, 'package.json');
const updateConfigFile = path.join(config.paths.root, 'update.json');

// An unattended task at 03:00 has nobody to read a banner, but it must still
// leave a trace. --quiet keeps stdout clean; --log appends every line to the
// data dir's logs so a failed update can be explained afterwards.
const quiet = flag('--quiet');
const logFile = flag('--log') ? path.join(config.paths.logs, 'update.log') : null;
const out = [];
function line(t = '') {
  out.push(t);
  if (!quiet) process.stdout.write(`${t}\n`);
}
process.on('exit', () => {
  if (!logFile) return;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${out.join('\n')}\n`);
  } catch {
    /* a log that cannot be written must not change the update result */
  }
});

function currentVersion() {
  try {
    return JSON.parse(fs.readFileSync(versionFile, 'utf8')).version;
  } catch {
    return null;
  }
}

/** Fetch the manifest and signature for the configured release. */
async function fetchRelease() {
  // The scheduled task has no environment: the durable channel lives in
  // <data>/v4/update.json, written by setup. The env var still wins.
  const fromFile = readUpdateConfig(updateConfigFile);
  const base = process.env.MAJIN_V4_RELEASE_URL || fromFile?.releaseUrl;
  if (!base) {
    throw new UpdateError(
      'NO_RELEASE_URL',
      'no release channel configured. Set MAJIN_V4_RELEASE_URL to the release asset base '
      + '(the folder that holds manifest.json and manifest.sig), run `npm run v4:setup -- --release-url https://…`, '
      + 'or use `npm run v4:upgrade` for a git checkout.',
    );
  }
  const get = async (name) => {
    const url = `${base.replace(/\/+$/, '')}/${name}`;
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new UpdateError('FETCH_FAILED', `${url} -> HTTP ${res.status}`);
    return res;
  };
  const manifest = await (await get('manifest.json')).json();
  const signature = (await (await get('manifest.sig')).text()).trim();
  return {
    manifest,
    signature,
    readFile: async (p) => {
      const rel = String(p).replace(/^\/+/, '');
      if (rel.split('/').includes('..')) {
        throw new UpdateError('BAD_MANIFEST_PATH', `refusing a path outside the release: ${p}`);
      }
      // release.mjs publishes the signed bytes under files/ next to the
      // manifest. Fetching them from the base returned 404 on every file — the
      // first end-to-end test of a real release caught it.
      const res = await get(`files/${rel}`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

/**
 * Dependencies are not part of a release, so they are preserved. If the release
 * changed package-lock.json they may no longer match the code, and the host
 * would fail its health check for an honest reason the owner cannot fix from
 * the phone. Install them here, before the health check, with scripts disabled.
 * A failure returns false, which makes runUpdate roll the whole release back.
 */
function makeDependencySync(lockBefore) {
  return () => {
    const lockFile = path.join(liveDir, 'package-lock.json');
    let lockAfter = null;
    try {
      lockAfter = crypto.createHash('sha256').update(fs.readFileSync(lockFile)).digest('hex');
    } catch {
      return true; // no lock file in this release: nothing to sync
    }
    if (!lockBefore || lockAfter === lockBefore) return true;
    const npm = process.env.MAJIN_V4_NPM || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
    line(`  dependencies changed; running ${npm} ci --ignore-scripts`);
    const res = spawnSync(npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: liveDir,
      encoding: 'utf8',
      timeout: 600_000,
      env: { ...process.env, NODE_ENV: 'production' },
    });
    if (res.status !== 0) {
      line(`  dependency install failed (exit ${res.status}): ${String(res.stderr || res.stdout || '').slice(0, 300)}`);
      return false;
    }
    return true;
  };
}

async function restartHost() {
  // The supervisor owns the host process; a restart is a health-checked signal.
  const health = process.env.MAJIN_V4_HEALTH_URL || `http://127.0.0.1:${config.port}/api/health`;
  try {
    const res = await fetch(health, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  const recovery = recoverInterruptedUpdate({ liveDir, backupDir });
  line('');
  line('MAJIN V4 update');
  line('='.repeat(60));
  line(`  current version: ${currentVersion() || 'unknown'}`);
  line(`  release key:     ${readPinnedKey(keyFile) ? 'pinned' : 'NOT PINNED'}`);
  if (recovery.recovered) line(`  recovery:        ${recovery.action} (the last update did not finish)`);
  line('');

  if (keyFile && !readPinnedKey(keyFile) && !flag('--allow-unsigned')) {
    line('  No release key is pinned, so no release can be trusted.');
    line('  Pin one once at install time:  npm run v4:pin-release-key -- <public-key.pem>');
    line('');
    process.exitCode = 1;
    return;
  }

  let release;
  try {
    release = await fetchRelease();
  } catch (err) {
    line(`  ${err.code || 'ERROR'}: ${err.message}`);
    line('');
    process.exitCode = 1;
    return;
  }

  const publicKey = readPinnedKey(keyFile);
  let plan;
  try {
    plan = planUpdate({
      manifest: release.manifest,
      signature: release.signature,
      publicKey,
      currentVersion: currentVersion(),
      allowUnsigned: flag('--allow-unsigned'),
    });
  } catch (err) {
    line(`  REFUSED (${err.code}): ${err.message}`);
    line('');
    process.exitCode = 1;
    return;
  }

  line(`  available: ${plan.action === 'noop' ? 'nothing (already current)' : `${plan.version} (${plan.files} files, ${Math.round(plan.bytes / 1024)} kB)`}`);
  if (plan.unsigned) line('  WARNING: this release is unsigned and was explicitly allowed.');
  line('');

  if (cmd === 'check' || plan.action === 'noop') {
    line('  nothing was changed.');
    line('');
    return;
  }

  if (cmd !== 'apply') {
    line('  run `node scripts/v4/update.mjs apply` to install it.');
    line('');
    return;
  }

  // fetchRelease reads through the network; runUpdate wants sync bytes, so the
  // files are pulled first and cached in memory. A release is small by design.
  const cache = new Map();
  for (const entry of release.manifest.files) cache.set(entry.path, await release.readFile(entry.path));

  let lockBefore = null;
  try {
    lockBefore = crypto.createHash('sha256').update(fs.readFileSync(path.join(liveDir, 'package-lock.json'))).digest('hex');
  } catch { /* the release may not carry a lock file */ }
  const syncDependencies = makeDependencySync(lockBefore);

  const result = await runUpdate({
    manifest: release.manifest,
    signature: release.signature,
    publicKey,
    currentVersion: currentVersion(),
    liveDir,
    stagingDir,
    backupDir,
    readFile: (p) => cache.get(p),
    restartHost: async () => {
      if (!syncDependencies()) return false;
      return restartHost();
    },
    allowUnsigned: flag('--allow-unsigned'),
    log: (event, detail) => line(`  [${event}] ${JSON.stringify(detail)}`),
  });

  line('');
  switch (result.status) {
    case 'UPDATED':
      line(`  Updated to ${result.version}. The host was restarted and answered its health check.`);
      break;
    case 'ROLLED_BACK':
      line(`  ${result.version} failed its health check. The previous version is running again.`);
      break;
    case 'NOOP':
      line('  Already current.');
      break;
    default:
      line(`  ${result.status}: ${result.reason || 'see the log above'}`);
      break;
  }
  line('');
  process.exitCode = result.status === 'UPDATED' || result.status === 'NOOP' ? 0 : 1;
}

await main();
void UPDATER_SCHEMA;
