#!/usr/bin/env node
// Deterministic CLI/browser acceptance; no real application or live model calls.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { browserBinary } from '../../src/v4/tools/host.js';

const browser = await browserBinary();
if (!browser) {
  console.error('NOT VERIFIED: install Edge/Chromium or set MAJIN_V4_BROWSER to its executable. Browser acceptance cannot pass by skipping tests.');
  process.exit(2);
}
const root = fileURLToPath(new URL('../../', import.meta.url));
const files = [
  'test/v5/browser-submit.test.js',
  'test/v5/cli.test.js',
  'test/v5/cli-view.test.js',
  'test/v5/cli-transport.test.js',
  'test/v5/provider-agent.test.js',
  'test/v5/learning-engine.test.js',
  'test/v5/deepseek-stream.test.js',
  'test/v5/job-workflow.test.js',
  'test/v5/full-access.test.js',
  'test/v5/schedule.test.js',
  'test/v5/heartbeat.test.js',
  'test/v5/cli-live-accept.test.js',
];
const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...files], {
  cwd: root, shell: false,
  env: { ...process.env, MAJIN_V4_BROWSER: browser },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let output = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', code => {
  const skipped = /^# skipped (\d+)\s*$/m.exec(output);
  const failed = /^# fail (\d+)\s*$/m.exec(output);
  const tests = /^# tests (\d+)\s*$/m.exec(output);
  const passed = code === 0 && skipped?.[1] === '0' && failed?.[1] === '0' && Number(tests?.[1]) > 0;
  console.log(passed
    ? 'VERIFIED: deterministic V5 CLI/browser suite passed without skips. Live model and real employer acceptance remain separate.'
    : 'NOT VERIFIED: V5 CLI/browser suite failed, skipped tests, or produced no complete test summary.');
  process.exitCode = passed ? 0 : 1;
});
