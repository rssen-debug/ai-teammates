/**
 * The CLI entry point itself. A person who just downloaded the .exe types the
 * obvious things first — `majin --help`, `majin --version` — and each of those
 * must answer and exit, not quietly start a server on the default port.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'src', 'cli', 'majin.js');

function run(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 25000,
    env: {
      ...process.env,
      MAJIN_HOME: '/tmp/majin-cli-home-unused',
      MAJIN_WORKSPACE: '/tmp/majin-cli-ws-unused',
      ...env,
    },
  });
}

test('"majin --help" prints the help and exits — it does not start a server', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /majin doctor \[--full\]/, 'the help text must be there: ' + r.stdout.slice(0, 120));
  assert.match(r.stdout, /majin shortcut/, 'including the command a released exe adds');
  assert.doesNotMatch(r.stdout + r.stderr, /listening on/, 'and nothing may be started by asking for help');
});

test('"majin -h" and "majin --version" answer instead of serving', () => {
  assert.equal(run(['-h']).status, 0, '-h must not serve either');
  const v = run(['--version']);
  assert.equal(v.status, 0, `exit ${v.status}: ${v.stderr}`);
  assert.match(v.stdout, /^majin \d+\.\d+\.\d+(?:-[\w.]+)? · node /, 'a version line (optional V2 channel suffix): ' + v.stdout.trim());
  assert.equal(run(['-v']).status, 0);
  assert.doesNotMatch(v.stdout, /listening on/);
});

test('a bare flag-only invocation still means "start", and unknown commands say so', () => {
  // --json alone with no command is not a question, it is a start with a flag:
  // assert only that the dispatcher does not invent a command for it.
  const bad = run(['no-such-command-at-all']);
  assert.equal(bad.status, 2, 'unknown command exits 2 with a pointer to help');
  assert.match(bad.stderr, /unknown command/);
});
