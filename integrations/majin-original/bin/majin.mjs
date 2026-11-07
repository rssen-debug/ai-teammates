#!/usr/bin/env node
/** Current product entry point. Legacy runtimes require an explicit command. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadConfig, V4_VERSION, assertNodeSupported } from '../src/v4/config.js';

const [command = 'start', ...args] = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, '..');
const scripts = {
  doctor: 'host-doctor', logs: 'logs', backup: 'backup', update: 'update',
  setup: 'setup', tools: 'tools', plugins: 'plugin', progress: 'progress',
};

async function main() {
  assertNodeSupported();
  if (['version', '--version', '-v'].includes(command)) {
    console.log(`majin ${V4_VERSION} · node ${process.versions.node}`);
    return;
  }
  if (['help', '--help', '-h'].includes(command)) {
    console.log(`MAJIN ${V4_VERSION}\nCommands: start, serve, window, pair, status, doctor, logs, backup, update, setup, tools, plugins\nUse majin legacy <command> only for the V1 runtime; it uses separate runtime semantics.`);
    return;
  }
  if (command === 'legacy') return run('src/cli/majin.js', args);
  if (command === 'status' || command === 'url') {
    const config = loadConfig({ argv: args });
    const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
    const origin = `http://${host.includes(':') ? `[${host}]` : host}:${config.port}`;
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    const health = await response.json();
    if (!response.ok || health.app !== 'majin' || !/^4\./.test(health.version)) throw new Error('The configured port is not a healthy MAJIN V4 host.');
    console.log(command === 'url' ? config.publicOrigin || origin : JSON.stringify(health, null, 2));
    return;
  }
  if (command === 'pair') return run('src/v4/main.js', ['pair', ...args]);
  if (command === '_serve') return run('src/v4/main.js', args);
  if (command === 'serve' || (command === 'start' && args.includes('--no-window'))) {
    return run('scripts/v4/supervise.mjs', args.filter((arg) => arg !== '--no-window'));
  }
  if (['start', 'window', 'ui', 'app'].includes(command)) {
    // A browser app window is not a substitute for the packaged native client.
    const exe = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'majin-v4-desktop', 'MAJIN V4.exe');
    if (!fs.existsSync(exe)) throw new Error('Install the MAJIN V4 desktop package first. To run only the shared host: majin serve');
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return;
  }
  if (scripts[command]) return run(`scripts/v4/${scripts[command]}.mjs`, args);
  throw new Error(`Unknown V4 command: ${command}. Run majin help. Use majin legacy <command> for an intentional V1 operation.`);
}

async function run(script, argv) {
  const target = path.join(root, script);
  process.argv = [process.execPath, target, ...argv];
  await import(pathToFileURL(target).href);
}

main().catch((error) => { console.error(`majin: ${error.message}`); process.exitCode = 1; });
