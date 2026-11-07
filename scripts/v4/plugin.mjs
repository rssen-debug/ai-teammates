#!/usr/bin/env node
/**
 * MAJIN V4 — plugin management CLI.
 *
 *   node scripts/v4/plugin.mjs list        what is installed and what happened
 *   node scripts/v4/plugin.mjs quarantine  list quarantined plugins + reasons
 *   node scripts/v4/plugin.mjs restore <name>
 *
 * Plugins are opt-in (MAJIN_V4_PLUGINS=1) and isolated in a child process by
 * default. Restoring moves a quarantined directory back so the next boot retries
 * it; it does not vouch for the code.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../src/v4/config.js';
import { Kernel } from '../../src/v4/kernel.js';

const config = loadConfig();
const pluginsDir = config.platform.pluginsDir;
const quarantineDir = config.platform.pluginQuarantineDir;

function listQuarantine() {
  try {
    return fs.readdirSync(quarantineDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => {
      const dir = path.join(quarantineDir, e.name);
      let reason = null;
      try {
        reason = JSON.parse(fs.readFileSync(path.join(dir, 'QUARANTINE.json'), 'utf8'));
      } catch { /* directory without a record */ }
      return { dir, name: e.name, reason };
    });
  } catch {
    return [];
  }
}

async function main() {
  const [cmd = 'list', arg] = process.argv.slice(2);

  if (cmd === 'list') {
    const kernel = new Kernel({
      features: config.platform.features,
      pluginsEnabled: config.platform.pluginsEnabled,
      allowlist: config.platform.pluginAllowlist,
      isolate: config.platform.pluginIsolate,
      quarantineDir,
    });
    const results = await kernel.loadPlugins(pluginsDir);
    const summary = kernel.summary();
    kernel.shutdownWorkers();
    process.stdout.write(`\nplugins enabled: ${summary.pluginsEnabled}  ·  isolated: ${config.platform.pluginIsolate}\n`);
    process.stdout.write(`directory: ${pluginsDir}\n\n`);
    if (!results.length) process.stdout.write('  (no plugins installed)\n');
    for (const r of results) {
      process.stdout.write(`  ${r.status.padEnd(11)} ${r.name}${r.error ? ` — ${r.error}` : ''}${r.quarantined ? '  (quarantined)' : ''}\n`);
    }
    for (const cap of summary.capabilities) process.stdout.write(`  capability  ${cap.kind}:${cap.name} (${cap.plugin})\n`);
    process.stdout.write('\n');
    return 0;
  }

  if (cmd === 'quarantine') {
    const items = listQuarantine();
    process.stdout.write(`\nquarantine: ${quarantineDir}\n\n`);
    if (!items.length) process.stdout.write('  (empty)\n');
    for (const item of items) {
      process.stdout.write(`  ${item.name}\n    ${item.reason?.reason || 'no reason recorded'}\n    restore: node scripts/v4/plugin.mjs restore ${item.name}\n`);
    }
    process.stdout.write('\n');
    return 0;
  }

  if (cmd === 'restore') {
    if (!arg) {
      process.stderr.write('usage: node scripts/v4/plugin.mjs restore <quarantine-dir-name>\n');
      return 2;
    }
    const match = listQuarantine().find((i) => i.name === arg);
    if (!match) {
      process.stderr.write(`not found in quarantine: ${arg}\n`);
      return 2;
    }
    const target = path.join(pluginsDir, match.reason?.plugin || arg.replace(/-\d{4}-.*$/, ''));
    if (fs.existsSync(target)) {
      process.stderr.write(`refusing to overwrite ${target}\n`);
      return 2;
    }
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.renameSync(match.dir, target);
    try {
      fs.unlinkSync(path.join(target, 'QUARANTINE.json'));
    } catch { /* optional */ }
    process.stdout.write(`restored ${arg} -> ${target}\n`);
    return 0;
  }

  process.stderr.write('usage: node scripts/v4/plugin.mjs [list|quarantine|restore <name>]\n');
  return 2;
}

process.exitCode = await main();
