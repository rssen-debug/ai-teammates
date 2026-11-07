#!/usr/bin/env node
/**
 * MAJIN V4 — host doctor.
 *
 * Read-only health report for the Windows host (works on any OS). It never
 * writes configuration, never prints a credential and never starts a tunnel.
 * Exit code 1 only when a *blocking* check fails.
 *
 *   node scripts/v4/host-doctor.mjs
 *   node scripts/v4/host-doctor.mjs --json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, isNodeSupported, V4_MIN_NODE } from '../../src/v4/config.js';
import { discoverModels } from '../../src/v4/models.js';
import { pairingExists, loadSecret } from '../../src/v4/auth.js';
import { privateFilePermissions } from '../../src/v4/file-permissions.js';

const checks = [];
const add = (id, ok, detail, blocking = false, hint = null) => {
  checks.push({ id, ok, detail, blocking, ...(hint ? { hint } : {}) });
};

function readableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const probe = path.join(dir, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, 'ok', { mode: 0o600 });
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function main() {
  const config = loadConfig();
  add('node', isNodeSupported(), `Node ${process.versions.node} (requires >= ${V4_MIN_NODE})`, true, 'Install Node 22 LTS.');
  add('platform', true, `${process.platform} ${os.release()} · ${os.arch()}`);
  add('host_bind', ['127.0.0.1', 'localhost', '::1'].includes(config.host) || Boolean(config.publicOrigin),
    `listening on ${config.host}:${config.port}${config.publicOrigin ? ` via ${config.publicOrigin}` : ''}`);
  add('data_dir', readableDir(config.paths.root), config.paths.root, true, 'Check permissions for %LOCALAPPDATA%\\MAJIN.');
  add('workspace', readableDir(config.workspaceDir), config.workspaceDir, true, 'Point MAJIN_V4_WORKSPACE at a folder you own.');

  const secretFile = config.paths.secret;
  const secretOk = (() => {
    try {
      return /^[a-f0-9]{64}$/.test(loadSecret(secretFile)) && privateFilePermissions(secretFile);
    } catch {
      return false;
    }
  })();
  add('secret', secretOk, 'HMAC key present with restricted permissions', true, 'Start the host once and the key is created with mode 0600.');
  add('pairing', pairingExists(config.paths.pairing), 'pairing record present (its value is never printed here)', false,
    'Start the host once (npm run v4) to create a pairing code shown on the console.');

  // Telemetry is how an always-on host gets debugged. It is optional (a broken
  // ledger never takes a turn down) but its absence should be visible.
  const telDir = path.join(config.paths.root, 'telemetry');
  const telOk = readableDir(telDir);
  add('telemetry', telOk, telOk ? telDir : 'telemetry directory is not writable', false,
    'The host still runs without telemetry; npm run v4:logs will report "no data".');

  const catalogue = discoverModels({ home: config.paths.home, env: process.env });
  const configured = catalogue.models.filter((m) => m.configured);
  add('v1_config', catalogue.configReadable, `${catalogue.configPath} (${catalogue.source})`, false,
    'Run MAJIN V1 once, or set MAJIN_CONFIG, so V4 can reuse the existing configuration.');
  add('models', configured.length > 0, `${configured.length} configured models, ${catalogue.liveVerifiedCount} live-verified`, false,
    'Add a provider with a key to the MAJIN config. Without one, V4 runs in demo mode.');

  const tls = Boolean(config.publicOrigin && config.publicOrigin.startsWith('https://'));
  add('public_origin', tls, config.publicOrigin || 'no public origin configured', false,
    'Set MAJIN_V4_PUBLIC_ORIGIN=https://your-tunnel-host after the tunnel is running.');

  add('trust_proxy', config.trustProxy ? true : !config.publicOrigin, config.trustProxy ? 'enabled' : 'disabled', false,
    'Behind Cloudflare Tunnel: set MAJIN_V4_TRUST_PROXY=1 so Secure cookies and client IP are correct.');

  const blocking = checks.filter((c) => c.blocking && !c.ok);
  const result = {
    ok: blocking.length === 0,
    app: 'majin-v4',
    version: config.version,
    checkedAt: new Date().toISOString(),
    platform: process.platform,
    checks,
    blocking: blocking.map((c) => c.id),
  };

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write('\nMAJIN V4 host doctor\n\n');
    for (const c of checks) {
      const mark = c.ok ? 'OK  ' : c.blocking ? 'FAIL' : 'WARN';
      process.stdout.write(`  ${mark}  ${c.id.padEnd(15)} ${c.detail}\n`);
      if (!c.ok && c.hint) process.stdout.write(`        → ${c.hint}\n`);
    }
    process.stdout.write(`\n${result.ok ? 'Host is ready for V4.' : 'Blocking problems must be fixed first.'}\n\n`);
  }
  return result.ok ? 0 : 1;
}

process.exitCode = main();
