import { fileURLToPath } from 'node:url';
import { runCli } from './cli.js';
import { runInteractive } from './interactive.js';

const argv = process.argv.slice(2);
const moduleDir = fileURLToPath(new URL('.', import.meta.url));
if (argv.length === 0 && process.stdin.isTTY) {
  await runInteractive({ moduleDir });
} else {
  process.exitCode = await runCli(argv, { out: (t) => console.log(t), err: (t) => console.error(t) }, { moduleDir });
}
