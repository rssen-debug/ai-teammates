#!/usr/bin/env node
/**
 * MAJIN V4 — supervised host launcher.
 *
 * Runs the host under the supervisor so a crash on the Windows machine comes
 * back by itself, with one JSON line per lifecycle event.
 *
 *   npm run v4:serve:supervised
 *   npm run v4:serve:supervised -- --port 7373
 *
 * Ctrl+C stops the host deliberately: the supervisor then never restarts it.
 * Logs: <MAJIN_HOME>/v4/logs/supervisor-YYYY-MM-DD.jsonl (mode 0600)
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/v4/config.js';
import { Supervisor } from '../../src/v4/supervisor.js';
import { recoverInterruptedUpdate } from '../../src/v4/updater.js';
import { scrubEnv } from '../../src/v2/spawn/safe-exec.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const config = loadConfig({ argv: args });
const port = value('--port') || String(config.port);
const host = value('--host') || config.host;
// Windows named pipes are released by the OS on exit, including a crash. The
// desktop launcher and Scheduled Task must never supervise the same port twice.
let instanceLock;
if (process.platform === 'win32') {
  instanceLock = net.createServer((socket) => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      instanceLock.once('error', reject);
      instanceLock.listen(`\\\\.\\pipe\\majin-v4-host-${port}`, resolve);
    });
    instanceLock.unref();
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write('A MAJIN V4 supervisor already owns this port.\n');
      process.exit(1);
    }
    throw err;
  }
}
const day = new Date().toISOString().slice(0, 10);

fs.mkdirSync(config.paths.logs, { recursive: true, mode: 0o700 });
const logFile = path.join(config.paths.logs, `supervisor-${day}.jsonl`);

// The health URL always targets the loopback the supervisor can actually reach.
const localHealthHost = ['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host;
const healthUrl = `http://${localHealthHost.includes(':') ? `[${localHealthHost}]` : localHealthHost}:${port}/api/health`;

const supervisor = new Supervisor({
  command: [process.execPath, path.join(repoRoot, 'src/v4/main.js'), '--port', port, '--host', host],
  cwd: repoRoot,
  healthUrl,
  logFile,
});
// Explicit owner configuration only. Reuse the existing supervised lifecycle;
// never download models or propagate provider credentials to the audio worker.
let voiceSupervisor = null;
if (process.env.MAJIN_V4_VOICE_SERVICE_ARGV) {
  const command = JSON.parse(process.env.MAJIN_V4_VOICE_SERVICE_ARGV);
  if (!Array.isArray(command) || command.length < 2 || command.some((arg) => typeof arg !== 'string')) throw new Error('Invalid voice service argv');
  voiceSupervisor = new Supervisor({ command, cwd: repoRoot, env: scrubEnv(),
    healthUrl: 'http://127.0.0.1:18765/health', startupGraceMs: 60000,
    logFile: path.join(config.paths.logs, `voice-supervisor-${day}.jsonl`) });
}
supervisor.log('launcher_started', { pid: process.pid });

function line(text) {
  process.stdout.write(`${text}\n`);
}

// If the last update died between two files, put the previous release back
// before the host is asked to boot from a mixed tree.
const recovery = recoverInterruptedUpdate({
  liveDir: repoRoot,
  backupDir: path.join(config.paths.root, 'release-previous'),
});

line('');
line('  MAJIN V4 — supervised host');
if (recovery.recovered) line(`  update recovery: ${recovery.action}`);
line(`  command    ${supervisor.command.join(' ')}`);
line(`  health     ${healthUrl}`);
line(`  log        ${logFile}`);
line('');

const statusTimer = setInterval(() => {
  const s = supervisor.status();
  line(`  [${new Date().toLocaleTimeString('sv-SE')}] ${s.state}  pid ${s.pid ?? '-'}  restarts ${s.restarts}  crashes ${s.crashes}${s.lastError ? `  (${s.lastError})` : ''}`);
}, 60_000);

async function shutdown(signal) {
  line(`\n  ${signal} — stopping the host (no restart).`);
  clearInterval(statusTimer);
  await voiceSupervisor?.stop();
  await supervisor.stop();
  const s = supervisor.status();
  line(`  final: ${s.state}, ${s.spawns} spawn(s), ${s.crashes} crash(es), ${s.restarts} restart(s)`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

await supervisor.start();
const initial = supervisor.status();
if (initial.state === 'failed') {
  line(`  host did not become healthy: ${initial.lastError}`);
  line('  run "npm run v4:doctor" for the reason');
  process.exitCode = 1;
  clearInterval(statusTimer);
  await supervisor.stop();
} else {
  line(`  host is ${initial.state} on pid ${initial.pid}`);
  line('  the supervisor keeps it running; Ctrl+C stops both');
  line('');
  if (voiceSupervisor) {
    await voiceSupervisor.start();
    const voice = voiceSupervisor.status();
    line(`  local voice worker: ${voice.state}${voice.lastError ? ` (${voice.lastError})` : ''}`);
  }
}
