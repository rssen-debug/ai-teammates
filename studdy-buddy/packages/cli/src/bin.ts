import { fileURLToPath } from 'node:url';
import { runCli } from './cli.js';
import { runInteractive } from './interactive.js';

process.removeAllListeners('warning');
process.on('warning', warning => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
  console.error(warning.stack ?? warning.message);
});
declare const __STUDDY_VERSION__: string;
const version = typeof __STUDDY_VERSION__ === 'string' ? __STUDDY_VERSION__ : '0.2.0-dev';
const argv = process.argv.slice(2);
const moduleDir = fileURLToPath(new URL('.', import.meta.url));
if (argv.length === 0 && process.stdin.isTTY) {
  await runInteractive({ moduleDir, version });
} else {
  process.exitCode = await runCli(argv, { out: (t) => console.log(t), err: (t) => console.error(t) }, { moduleDir, version });
}
