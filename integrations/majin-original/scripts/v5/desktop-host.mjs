#!/usr/bin/env node
/**
 * MAJIN V5 — Native Electron Desktop Background Host Launcher (`scripts/v5/desktop-host.mjs`).
 *
 * Started automatically by `desktop/main.cjs` when no healthy local V5 host is
 * listening yet. Stores V5 state under `%LOCALAPPDATA%\MAJIN\v5` (`~/.majin/v5`)
 * without touching V1–V4 installations or user data.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createV5Server } from '../../src/v5/server.js';
import { V5_VERSION, atomicWriteJson } from '../../src/v5/ops.js';

const args = process.argv.slice(2);
function readArg(flag, fallback) {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return fallback;
}

export function resolveV5DataDir(env = process.env, platform = process.platform) {
  const explicit = readArg('--data-dir', env.MAJIN_V5_DATA_DIR);
  if (explicit) return path.resolve(explicit);
  if (env.MAJIN_HOME) return path.join(path.resolve(env.MAJIN_HOME), 'v5');
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'MAJIN', 'v5');
  }
  return path.join(os.homedir(), '.majin', 'v5');
}

async function main() {
  const host = readArg('--host', process.env.MAJIN_V5_HOST || '127.0.0.1');
  const port = Number(readArg('--port', process.env.MAJIN_V5_PORT || '4555'));
  const dataDir = resolveV5DataDir();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const srv = createV5Server({ host, port, dataDir });
  const bound = await srv.start();

  atomicWriteJson(path.join(dataDir, 'desktop-host.json'), {
    pid: process.pid,
    url: bound.url,
    host: bound.host,
    port: bound.port,
    version: V5_VERSION,
    dataDir,
    startedAt: new Date().toISOString(),
  });

  if (typeof process.send === 'function') {
    await new Promise((resolve) => {
      process.send(
        {
          type: 'v5-ready',
          code: srv.getPairingCode(),
          url: bound.url,
          version: V5_VERSION,
        },
        () => resolve(),
      );
    });
  }
  if (process.connected) {
    process.disconnect();
  }

  const shutdown = async () => {
    try {
      await srv.stop();
    } catch { /* ignore */ }
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('desktop-host.mjs')) {
  main().catch((err) => {
    process.stderr.write(`MAJIN V5 desktop-host error: ${err?.message || err}\n`);
    process.exit(1);
  });
}
