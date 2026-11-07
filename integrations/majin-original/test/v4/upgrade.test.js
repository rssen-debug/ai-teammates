/**
 * Upgrade with automatic rollback.
 *
 * A fake runner stands in for git and npm so every path is deterministic — most
 * importantly the one that matters in production: a gate fails and the checkout
 * must return to the commit that worked.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { GATES, upgrade, UpgradeError } from '../../src/v4/upgrade.js';

const SHA_OLD = 'a'.repeat(40);
const SHA_NEW = 'b'.repeat(40);

/** Build a runner that answers git commands from a script and gates on demand. */
function makeRunner({ head = SHA_OLD, target = SHA_NEW, failGates = [], failCheckout = false, failRollback = false, fetchCode = 0 } = {}) {
  const calls = [];
  const state = { head };
  const run = (argv, opts = {}) => {
    calls.push({ argv, cwd: opts.cwd });
    const key = argv.join(' ');
    if (key === 'git fetch --tags origin') return { code: fetchCode, stdout: '', stderr: fetchCode ? 'network down' : '' };
    if (key === 'git rev-parse HEAD') return { code: 0, stdout: `${state.head}\n`, stderr: '' };
    if (key === 'git rev-parse origin/v4/main') return { code: 0, stdout: `${target}\n`, stderr: '' };
    if (key.startsWith('git checkout --detach ')) {
      const sha = argv[3];
      if (sha === target && failCheckout) return { code: 1, stdout: '', stderr: 'checkout failed' };
      if (sha === head && failRollback) return { code: 1, stdout: '', stderr: 'rollback failed' };
      state.head = sha;
      return { code: 0, stdout: '', stderr: '' };
    }
    const gate = GATES.find((g) => g.argv.join(' ') === key);
    if (gate) return { code: failGates.includes(gate.id) ? 1 : 0, stdout: '', stderr: failGates.includes(gate.id) ? `${gate.id} failed` : '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { run, calls, state };
}

test('upgrade: a clean upgrade runs every gate and reports both SHAs', async () => {
  const { run, state } = makeRunner();
  const result = await upgrade({ repo: '/repo', run });
  assert.equal(result.status, 'UPGRADED');
  assert.equal(result.previousSha, SHA_OLD);
  assert.equal(result.newSha, SHA_NEW);
  assert.deepEqual(result.gates.map((g) => g.id), GATES.map((g) => g.id));
  assert.ok(result.gates.every((g) => g.code === 0));
  assert.equal(state.head, SHA_NEW);
  assert.match(result.rollbackCommand, /git checkout a{40}/);
});

test('upgrade: an up-to-date checkout does nothing', async () => {
  const { run, calls, state } = makeRunner({ target: SHA_OLD });
  const result = await upgrade({ repo: '/repo', run });
  assert.equal(result.status, 'UP_TO_DATE');
  assert.equal(state.head, SHA_OLD);
  assert.ok(!calls.some((c) => c.argv[0] === 'npm'), 'no gate ran');
});

test('upgrade: a failed test gate rolls the checkout back and reinstalls', async () => {
  const { run, calls, state } = makeRunner({ failGates: ['tests'] });
  const result = await upgrade({ repo: '/repo', run });
  assert.equal(result.status, 'ROLLED_BACK');
  assert.equal(result.failedGate, 'tests');
  assert.equal(state.head, SHA_OLD, 'the working tree is back on the commit that worked');
  assert.equal(result.restored, true);
  const reinstall = calls.filter((c) => c.argv[0] === 'npm' && c.argv[1] === 'ci');
  assert.equal(reinstall.length, 2, 'one install on the new commit, one after rollback');
});

test('upgrade: a failed doctor gate stops before the test suite', async () => {
  const { run, calls } = makeRunner({ failGates: ['doctor'] });
  const result = await upgrade({ repo: '/repo', run });
  assert.equal(result.status, 'ROLLED_BACK');
  assert.equal(result.failedGate, 'doctor');
  assert.ok(!calls.some((c) => c.argv.includes('v4:test')), 'the slow gate was not run after a failure');
});

test('upgrade: a failing rollback is escalated, never hidden', async () => {
  const { run } = makeRunner({ failGates: ['tests'], failRollback: true });
  const result = await upgrade({ repo: '/repo', run });
  assert.equal(result.status, 'ESCALATE');
  assert.match(result.reason, /intervene/i);
});

test('upgrade: fetch and checkout failures are classified', async () => {
  await assert.rejects(() => upgrade({ repo: '/repo', run: makeRunner({ fetchCode: 1 }).run }), (e) => e instanceof UpgradeError && e.code === 'FETCH_FAILED');
  await assert.rejects(() => upgrade({ repo: '/repo', run: makeRunner({ failCheckout: true }).run }), (e) => e instanceof UpgradeError && e.code === 'CHECKOUT_FAILED');
});

test('upgrade: the runner receives the repo as cwd for every command', async () => {
  const { run, calls } = makeRunner();
  await upgrade({ repo: '/some/repo', run });
  assert.ok(calls.length > 0);
  assert.ok(calls.every((c) => c.cwd === '/some/repo'));
});

test('upgrade: missing inputs are refused instead of half-running', async () => {
  await assert.rejects(() => upgrade({ run: () => ({ code: 0 }) }), (e) => e.code === 'NO_REPO');
  await assert.rejects(() => upgrade({ repo: '/r' }), (e) => e.code === 'NO_RUNNER');
});

test('upgrade: the plan explains the detached checkout and how to leave it', async () => {
  const { spawnSync } = await import('node:child_process');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const out = spawnSync(process.execPath, [path.join(root, 'scripts/v4/upgrade.mjs'), '--dry'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /plan only/);
  assert.match(out.stdout, /nothing was changed/);
});
