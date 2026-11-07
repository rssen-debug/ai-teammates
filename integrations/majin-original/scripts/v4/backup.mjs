#!/usr/bin/env node
/**
 * MAJIN V4 — backup CLI.
 *
 *   node scripts/v4/backup.mjs backup [--out <dir>]
 *   node scripts/v4/backup.mjs verify <dir>
 *   node scripts/v4/backup.mjs restore <dir> [--dry-run] [--force]
 *
 * The default destination is <data>/v4-backups/<timestamp>, outside the live data
 * dir. A restore without --force refuses to overwrite anything, so a mistake is a
 * refusal rather than data loss.
 */
import path from 'node:path';
import { loadConfig } from '../../src/v4/config.js';
import { createBackup, verifyBackup, restoreBackup, BackupError } from '../../src/v4/backup.js';

const args = process.argv.slice(2);
const cmd = args[0] || 'help';
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const flag = (name) => args.includes(name);

const config = loadConfig();

function line(text = '') {
  process.stdout.write(`${text}\n`);
}

function usage() {
  line('MAJIN V4 backup');
  line('  node scripts/v4/backup.mjs backup [--out <dir>]');
  line('  node scripts/v4/backup.mjs verify <dir>');
  line('  node scripts/v4/backup.mjs restore <dir> [--dry-run] [--force]');
  line('');
  line(`data dir: ${config.paths.root}`);
}

function main() {
  if (cmd === 'backup') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const out = value('--out') || path.join(config.paths.home, 'v4-backups', stamp);
    const result = createBackup({ home: config.paths.home, out });
    line('');
    line(`  backup written: ${result.dir}`);
    line(`  ${result.files} file(s), ${result.bytes} bytes`);
    line('  keys, pairing codes and sessions are not included (by design).');
    line('  verify it with: npm run v4:backup -- verify "<dir>"');
    line('');
    return 0;
  }

  if (cmd === 'verify') {
    const dir = value('--out') || args[1];
    if (!dir) {
      usage();
      return 2;
    }
    const result = verifyBackup(path.resolve(dir));
    line('');
    line(`  ${result.ok ? 'OK  ' : 'FAIL'} ${result.verdict}  ${dir}`);
    for (const p of result.problems) line(`        - ${p}`);
    if (result.manifest) {
      line(`        ${result.manifest.stats?.files ?? '?'} file(s), created ${result.manifest.createdAt}`);
    }
    line('');
    return result.ok ? 0 : 1;
  }

  if (cmd === 'restore') {
    const dir = value('--out') || args[1];
    if (!dir) {
      usage();
      return 2;
    }
    const dryRun = flag('--dry-run');
    try {
      const result = restoreBackup({
        bundle: path.resolve(dir),
        home: config.paths.home,
        force: flag('--force'),
        dryRun,
      });
      line('');
      line(`  ${dryRun ? 'DRY RUN — nothing written' : 'restored'}: ${result.restored} file(s)`);
      line(`  target: ${result.target}`);
      if (result.skipped.length) line(`  skipped (no schema contract): ${result.skipped.join(', ')}`);
      line('  Pair the phone again: sessions are never restored.');
      line('');
      return 0;
    } catch (err) {
      if (!(err instanceof BackupError)) throw err;
      line('');
      line(`  REFUSED (${err.code}): ${err.message}`);
      line('');
      return 1;
    }
  }

  usage();
  return 0;
}

process.exitCode = main();
