#!/usr/bin/env node
/**
 * MAJIN V4 — entry point.
 *
 *   node src/v4/main.js             start the private server
 *   node src/v4/main.js pair [--rotate]
 *
 * Prints the pairing code exactly once (on first boot or rotation) and never
 * logs secrets. V1, V2 and V3 entry points are untouched.
 */
import { loadConfig, assertNodeSupported, V4_VERSION } from './config.js';
import { ensurePairing, loadSecret } from './auth.js';
import { startV4Server } from './server.js';
import { t } from './ui/strings.js';

function line(text = '') {
  process.stdout.write(`${text}\n`);
}

async function pairCommand({ rotate }) {
  const config = loadConfig({ argv: process.argv.slice(2) });
  const secret = loadSecret(config.paths.secret);
  const code = ensurePairing(config.paths.pairing, secret, { rotate });
  if (code) {
    line('');
    line('  MAJIN parkod (visas bara nu):');
    line(`    ${code}`);
    line('');
  } else {
    line(t('cli.pairExists'));
  }
}

async function serve() {
  const config = loadConfig({ argv: process.argv.slice(2) });
  const { server, context, url, port } = await startV4Server({ config });

  line('');
  line('  MAJIN V4');
  line(`  lyssnar   ${url}`);
  line(`  modell    ${context.model.info.label}${context.model.info.demo ? '  (demo — ingen LLM ansluten)' : ''}`);
  line(`  policy    ${config.approvals.policy}`);
  line(`  arbetsyta ${config.workspaceDir}`);
  if (config.publicOrigin) line(`  publik    ${config.publicOrigin}`);
  if (context.pairingFresh) {
    line('');
    line('  Parkod (visas bara nu):');
    line(`    ${context.pairingFresh}`);
    line(t('cli.pairEnter'));
  } else {
    line('');
    line(t('cli.pairRotate'));
  }
  if (context.reconciled.length) {
    line('');
    line(t('cli.reconciled', { count: context.reconciled.length }));
    for (const id of context.reconciled) line(`    ${id}`);
  }
  // A goal the state machine would not let us move is reported, never hidden:
  // it is still on disk in its old state and a human needs to know.
  if (context.reconciled.stuck?.length) {
    line('');
    line(t('cli.reconcileStuck', { count: context.reconciled.stuck.length }));
    for (const item of context.reconciled.stuck) line(`    ${item.id} (${item.state}): ${item.error}`);
  }
  if (context.reconciled.clearedApprovals) {
    line(t('cli.approvalsCleared', { count: context.reconciled.clearedApprovals }));
  }
  line('');

  const shutdown = (signal) => {
    line(`\n  ${t('cli.shutdown', { signal })}`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return { server, port };
}

async function main() {
  assertNodeSupported();
  const [cmd, ...rest] = process.argv.slice(2);
  if (['version', '--version', '-v'].includes(cmd)) {
    line(`majin ${V4_VERSION} · node ${process.versions.node}`);
    return;
  }
  if (cmd === 'pair') {
    await pairCommand({ rotate: rest.includes('--rotate') });
    return;
  }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    line('MAJIN V4');
    line(t('cli.help.serve'));
    line(t('cli.help.pair'));
    line(t('cli.help.env'));
    line('         MAJIN_V4_API_KEY, MAJIN_V4_MODEL, MAJIN_V4_PUBLIC_ORIGIN');
    return;
  }
  if (cmd && !['start', 'serve', '--host', '--port'].includes(cmd)) throw new Error(`Unknown host command: ${cmd}. Use --help.`);
  await serve();
}

main().catch((err) => {
  process.stderr.write(`MAJIN V4: ${err?.message || err}\n`);
  process.exit(1);
});
