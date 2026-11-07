/**
 * Upgrade against a real git repository, including a dirty working tree.
 *
 * The unit tests use an injected runner. These use real `git`, because the
 * dangerous behaviour is git's own: `checkout --detach <sha>` with local
 * modifications either refuses or carries them across — and neither outcome is
 * something MAJIN should discover halfway through an upgrade.
 *
 * This matters in practice: in this very project the working tree has contained
 * local modifications more than once, and `upgrade` never looked at `git status`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { upgrade, UpgradeError } from '../../src/v4/upgrade.js';
import { tempHome } from './helpers.mjs';

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' } });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

/**
 * A working repo with a real bare `origin`, two commits, and `v4/main` on the
 * second. The working tree is checked out on the first, so an upgrade has
 * somewhere to go.
 */
function makeRepo() {
  const root = tempHome();
  const remote = path.join(root, 'origin.git');
  const dir = path.join(root, 'work');

  git(root, ['init', '-q', '--bare', remote]);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['remote', 'add', 'origin', remote]);

  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'one']);
  const first = git(dir, ['rev-parse', 'HEAD']);

  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x","version":"2"}\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'two']);
  const second = git(dir, ['rev-parse', 'HEAD']);

  // publish main and v4/main to the bare origin, then come back to the first commit
  git(dir, ['push', '-q', 'origin', 'main', `${second}:refs/heads/v4/main`]);
  git(dir, ['checkout', '-q', first]);
  git(dir, ['fetch', '-q', 'origin']);
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  return { dir, root, first, second };
}

const realRun = (argv, opts = {}) => {
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd: opts.cwd,
    encoding: 'utf8',
    timeout: opts.timeoutMs || 60_000,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' },
  });
  return { code: res.status ?? 1, stdout: res.stdout || '', stderr: res.stderr || '' };
};

// The gates run npm; stub them out so the test is about git, not npm.
const noNpmGates = [
  { id: 'install', argv: ['node', '-e', 'process.exit(0)'], timeoutMs: 10_000 },
  { id: 'tests', argv: ['node', '-e', 'process.exit(0)'], timeoutMs: 10_000 },
];

test('upgrade/git: a clean tree upgrades to the target commit', async () => {
  const { dir, second } = makeRepo();
  try {
    const result = await upgrade({ repo: dir, target: 'origin/v4/main', run: realRun, gates: noNpmGates });
    assert.equal(result.status, 'UPGRADED');
    assert.equal(git(dir, ['rev-parse', 'HEAD']), second);
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('upgrade/git: uncommitted changes stop the upgrade before anything moves', async () => {
  const { dir, first } = makeRepo();
  // a local edit the owner would not want silently carried or lost
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x","local":"änderad"}\n');
  try {
    await assert.rejects(
      () => upgrade({ repo: dir, target: 'origin/v4/main', run: realRun, gates: noNpmGates }),
      (err) => err instanceof UpgradeError && err.code === 'DIRTY_TREE',
    );
    assert.equal(git(dir, ['rev-parse', 'HEAD']), first, 'the checkout did not move');
    assert.match(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), /änderad/, 'the local edit is untouched');
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('upgrade/git: untracked files alone do not block an upgrade', async () => {
  const { dir, second } = makeRepo();
  fs.writeFileSync(path.join(dir, 'anteckning.txt'), 'lokalt skräp som inte är versionshanterat');
  try {
    const result = await upgrade({ repo: dir, target: 'origin/v4/main', run: realRun, gates: noNpmGates });
    assert.equal(result.status, 'UPGRADED');
    assert.equal(git(dir, ['rev-parse', 'HEAD']), second);
    assert.ok(fs.existsSync(path.join(dir, 'anteckning.txt')), 'untracked files survive');
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('upgrade/git: a failing gate rolls the real checkout back to the first commit', async () => {
  const { dir, first } = makeRepo();
  const failing = [
    { id: 'install', argv: ['node', '-e', 'process.exit(0)'], timeoutMs: 10_000 },
    { id: 'tests', argv: ['node', '-e', 'process.exit(1)'], timeoutMs: 10_000 },
  ];
  try {
    const result = await upgrade({ repo: dir, target: 'origin/v4/main', run: realRun, gates: failing });
    assert.equal(result.status, 'ROLLED_BACK');
    assert.equal(git(dir, ['rev-parse', 'HEAD']), first, 'the tree is back on the commit that worked');
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('upgrade/git: an up-to-date repo is a no-op', async () => {
  const { dir } = makeRepo();
  try {
    git(dir, ['checkout', '-q', 'origin/v4/main']);
    const before = git(dir, ['rev-parse', 'HEAD']);
    const result = await upgrade({ repo: dir, target: 'origin/v4/main', run: realRun, gates: noNpmGates });
    assert.equal(result.status, 'UP_TO_DATE');
    assert.equal(git(dir, ['rev-parse', 'HEAD']), before);
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});
