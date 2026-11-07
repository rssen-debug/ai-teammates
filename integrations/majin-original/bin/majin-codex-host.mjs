#!/usr/bin/env node
import path from 'node:path';
import { createCodexHost } from '../src/v5/codex-host.js';
const args = process.argv.slice(2);
const arg = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const workspace = path.resolve(arg('--workspace', '.codex-driver/workspace'));
const host = createCodexHost({ workspace, stateDir: path.resolve(arg('--state-dir', '.codex-driver/state')),
  uiDir: arg('--ui-dir', undefined),
  browserWriteOrigins: args.flatMap((value, index) => value === '--submit-origin' ? [args[index + 1]] : []),
  desktop: args.includes('--desktop'), browser: args.includes('--browser'), processAccess: args.includes('--process'), port: Number(arg('--port', '4556')) });
console.log(JSON.stringify(await host.start()));
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => host.stop().finally(() => process.exit(0)));
