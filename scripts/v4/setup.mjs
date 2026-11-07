#!/usr/bin/env node
/**
 * MAJIN V4 — the one setup command.
 *
 *   npm run v4:setup             do everything that can be done safely, print what is left
 *   npm run v4:setup -- --check  only report, change nothing
 *
 * The point is that the owner runs ONE command on Windows, once, and every
 * subsequent update arrives through the app instead of a terminal. This command
 * is therefore split into what it can do alone and what only the owner can do:
 *
 *   IT DOES
 *     - check the runtime, the data dir and the workspace
 *     - create the pairing record and show the code once
 *     - seed Owner Mode with the read-only network lanes
 *     - pin the release key, if one is provided (MAJIN_V4_RELEASE_KEY_PUB)
 *     - register the per-user logon task, if asked (--autostart)
 *     - run the doctor and print exactly what is missing
 *
 *   IT CANNOT
 *     - create your Cloudflare/Tailscale tunnel (needs your account)
 *     - grant files/shell/desktop (that is the phone's job, on purpose)
 *     - sign a release (needs the private key, which never lives here)
 *
 * Everything it prints is either done or explicitly the owner's next step.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/v4/config.js';
import { ensurePairing, loadSecret, pairingExists } from '../../src/v4/auth.js';
import { OwnerMode } from '../../src/v4/owner-mode.js';
import {
  pinKey, readPinnedKey, readUpdateConfig, writeUpdateConfig, UPDATER_SCHEMA,
} from '../../src/v4/updater.js';

const args = process.argv.slice(2);
const check = args.includes('--check');
const autostart = args.includes('--autostart');
const accept = args.includes('--accept');
const autoUpdate = args.includes('--auto-update');
const value = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const releaseUrl = value('--release-url');
const updateTime = value('--update-time', '04:00');
const config = loadConfig({ argv: args });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const steps = [];
const record = (id, ok, detail, next = null) => steps.push({ id, ok, detail, next });

function line(t = '') {
  process.stdout.write(`${t}\n`);
}

/* 1. runtime ------------------------------------------------------------- */
const major = Number(process.versions.node.split('.')[0]);
record('node', major >= 22, `Node ${process.versions.node} (>= 22 required)`, major >= 22 ? null : 'Install Node 22 LTS, then run this again.');

/* 2. data dir + workspace ------------------------------------------------ */
function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const probe = path.join(dir, `.setup-${process.pid}`);
    fs.writeFileSync(probe, 'x', { mode: 0o600 });
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}
record('data', writable(config.paths.root), config.paths.root, 'Check permissions for %LOCALAPPDATA%\\MAJIN.');
record('workspace', writable(config.workspaceDir), config.workspaceDir, 'Set MAJIN_V4_WORKSPACE to a folder you own.');

/* 3. pairing ------------------------------------------------------------- */
if (!check) {
  const secret = loadSecret(config.paths.secret);
  const code = ensurePairing(config.paths.pairing, secret);
  record('pairing', true, code ? 'a new pairing code was issued (shown once, below)' : 'a pairing code already exists', code ? null : 'Run `npm run v4:pair -- --rotate` for a new code.');
  if (code) {
    line('');
    line('  ┌──────────────────────────────────────────────┐');
    line(`  │  Parkod: ${code.padEnd(36)}│`);
    line('  │  Skriv in den i telefonen. Visas bara nu.    │');
    line('  └──────────────────────────────────────────────┘');
  }
} else {
  record('pairing', pairingExists(config.paths.pairing), 'a pairing code exists', 'Run setup without --check to create one.');
}

/* 4. owner mode seed ----------------------------------------------------- */
const ownerFile = path.join(config.paths.root, 'owner-mode.json');
const owner = new OwnerMode({ file: ownerFile });
if (!check && !owner.enabled()) {
  owner.grant({ lanes: ['web', 'research', 'jobs'], reason: 'setup' });
  record('owner-mode', true, 'granted web, research and jobs (read-only network lanes)', null);
} else if (owner.enabled()) {
  record('owner-mode', true, `${owner.activeLanes().length} lane(s) already granted`, null);
} else {
  record('owner-mode', false, 'nothing granted yet', 'Run setup without --check to grant the read-only lanes.');
}
record('owner-extra', true, 'files, shell and desktop are granted from the phone (Permissions panel)', null);

/* 5. release key --------------------------------------------------------- */
const keyFile = path.join(config.paths.root, 'release-key.json');
const keySource = process.env.MAJIN_V4_RELEASE_KEY_PUB || path.join(root, 'release-public-key.pem');
if (!check && fs.existsSync(keySource) && !readPinnedKey(keyFile)) {
  pinKey(keyFile, fs.readFileSync(keySource, 'utf8'));
  record('release-key', true, `pinned from ${keySource}`, null);
} else if (readPinnedKey(keyFile)) {
  record('release-key', true, 'a release key is pinned; updates can be verified', null);
} else {
  record('release-key', false, 'no release key pinned; automatic updates stay off', 'Put the release public key at release-public-key.pem and run setup again, or set MAJIN_V4_RELEASE_KEY_PUB.');
}

/* 6. update channel ------------------------------------------------------ */
const updateFile = path.join(config.paths.root, 'update.json');
const existingUpdate = readUpdateConfig(updateFile);
if (!check && (releaseUrl || autoUpdate)) {
  try {
    const saved = writeUpdateConfig(updateFile, {
      releaseUrl: releaseUrl || existingUpdate?.releaseUrl || null,
      auto: autoUpdate || Boolean(existingUpdate?.auto),
      time: updateTime || existingUpdate?.time || '04:00',
    });
    record('updates', true,
      `${saved.releaseUrl ? `channel ${saved.releaseUrl}` : 'no channel yet'}${saved.auto ? `, checks daily at ${saved.time}` : ', manual apply'}`,
      saved.releaseUrl ? null : 'Pass --release-url https://… so the updater knows where releases live.');
  } catch (err) {
    record('updates', false, String(err?.message || err), 'Pass --release-url https://… and a time like --update-time 04:00.');
  }
} else if (existingUpdate?.releaseUrl) {
  record('updates', true, `channel ${existingUpdate.releaseUrl}${existingUpdate.auto ? `, checks daily at ${existingUpdate.time}` : ''}`, null);
} else {
  record('updates', false, 'no release channel configured', 'Run setup with --release-url https://… --auto-update to finish automatic updates.');
}

/* 7. autostart and automatic updates ------------------------------------- */
const needInstaller = (autostart || autoUpdate) && !check;
if (process.platform === 'win32' && needInstaller) {
  const ps = path.join(root, 'scripts', 'v4', 'install-v4-windows.ps1');
  const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, '-Port', String(config.port)];
  if (autostart) psArgs.push('-AutoStart');
  if (autoUpdate) psArgs.push('-AutoUpdate', '-UpdateTime', updateTime);
  const res = spawnSync('powershell', psArgs, { stdio: 'inherit' });
  record('autostart', res.status === 0 && autostart, autostart ? (res.status === 0 ? 'logon task registered' : 'the installer returned an error') : 'not requested', autostart && res.status !== 0 ? 'Run: powershell -ExecutionPolicy Bypass -File .\\scripts\\v4\\install-v4-windows.ps1 -AutoStart' : null);
  record('auto-update-task', res.status === 0 && autoUpdate, autoUpdate ? (res.status === 0 ? `daily task registered at ${updateTime}` : 'the installer returned an error') : 'not requested', autoUpdate && res.status !== 0 ? 'Run: powershell -ExecutionPolicy Bypass -File .\\scripts\\v4\\install-v4-windows.ps1 -AutoUpdate' : null);
} else if (process.platform === 'win32') {
  record('autostart', false, 'not requested', 'Add --autostart to register the per-user logon task.');
  record('auto-update-task', false, 'not requested', 'Add --auto-update (with --release-url) to register the daily update task.');
} else {
  record('autostart', false, `not applicable on ${process.platform}`, 'This runs on the Windows host.');
  record('auto-update-task', false, `not applicable on ${process.platform}`, 'This runs on the Windows host.');
}

/* 8. model route --------------------------------------------------------- */
const model = config.model;
record('model', model.kind !== 'demo', model.kind === 'demo' ? 'no provider configured; MAJIN runs in demo mode' : `${model.label} · ${model.model}`,
  model.kind === 'demo' ? 'Configure a provider in the MAJIN config (or MAJIN_V4_BASE_URL/API_KEY/MODEL).' : null);

/* 9. tunnel -------------------------------------------------------------- */
record('tunnel', Boolean(config.publicOrigin), config.publicOrigin || 'no public origin configured',
  config.publicOrigin ? null : 'Set up the tunnel once (docs/v4/DEPLOYMENT.md §3-4), then set MAJIN_V4_PUBLIC_ORIGIN.');

/* 10. acceptance --------------------------------------------------------- */
if (accept && !check) {
  // One command, one verdict: the same checks the owner would otherwise run
  // by hand, written to docs/v4/evidence/.
  const acceptArgs = [path.join(root, 'scripts', 'v4', 'accept.mjs'), '--write'];
  if (config.publicOrigin) acceptArgs.push('--url', config.publicOrigin);
  const res = spawnSync(process.execPath, acceptArgs, { stdio: 'inherit', cwd: root });
  record('accept', res.status === 0, res.status === 0 ? 'acceptance ran and the evidence was written' : `acceptance reported problems (exit ${res.status})`, res.status === 0 ? null : 'Read the report above; fix the FAIL lines and run setup again.');
} else if (accept && check) {
  record('accept', false, 'not run in --check mode', null);
}

/* report ----------------------------------------------------------------- */
const passed = steps.filter((s) => s.ok).length;
line('');
line('MAJIN V4 setup');
line('='.repeat(66));
for (const s of steps) {
  line(`  ${s.ok ? 'OK  ' : 'TODO'}  ${s.id.padEnd(12)} ${s.detail}`);
  if (!s.ok && s.next) line(`        → ${s.next}`);
}
line('-'.repeat(66));
line(`  ${passed}/${steps.length} automated steps done${check ? ' (check only: nothing was changed)' : ''}`);
line('');
const blocking = steps.filter((s) => !s.ok && ['node', 'data', 'workspace'].includes(s.id));
if (blocking.length) {
  line('  Fix the blocking steps above, then run setup again.');
} else if (!check) {
  line('  Next: npm run v4');
  line('  Then open the URL on the phone, enter the code, and turn on what you need in Permissions.');
  line('  One command does the whole install and the whole acceptance run:');
  line('    npm run v4:setup -- --autostart --accept --release-url https://<release-base> --auto-update');
}
line('');
process.exitCode = blocking.length ? 1 : 0;
void UPDATER_SCHEMA;
