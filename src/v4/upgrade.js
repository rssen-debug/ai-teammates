/**
 * MAJIN V4 — safe upgrade with automatic rollback.
 *
 * "MAJIN evolves through releases, not reinventions" only holds if a bad release
 * can be undone in one step. This module owns that:
 *
 *   fetch -> record current SHA -> check out the new one -> install ->
 *   doctor -> tests -> acceptance
 *        ✓ all good: report UPGRADED (old SHA kept for a manual rollback)
 *        ✗ anything fails: check out the previous SHA, reinstall, report ROLLED_BACK
 *
 * Every command runs through an injected runner, so the decision logic (including
 * the rollback path) is tested here without touching a real repository.
 *
 * What it will not do: force-push, rewrite history, or claim success when a gate
 * failed. A failed rollback is reported as ESCALATE, not swallowed.
 */
export class UpgradeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UpgradeError';
    this.code = code;
  }
}

export const GATES = Object.freeze([
  { id: 'install', argv: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], timeoutMs: 600_000 },
  { id: 'doctor', argv: ['npm', 'run', 'v4:doctor'], timeoutMs: 60_000 },
  { id: 'tests', argv: ['npm', 'run', 'v4:test'], timeoutMs: 1_800_000 },
  { id: 'matrix', argv: ['npm', 'run', 'v4:progress', '--', '--check'], timeoutMs: 60_000 },
]);

/**
 * @param {object} o
 * @param {string} o.repo             working tree
 * @param {string} [o.target]         ref to upgrade to (default origin/v4/main)
 * @param {Function} o.run            (argv, opts) => {code, stdout, stderr}
 * @param {Function} [o.log]          (event, detail) => void
 */
export async function upgrade({ repo, target = 'origin/v4/main', run, log = () => {}, gates = GATES } = {}) {
  if (!repo) throw new UpgradeError('NO_REPO', 'repo path is required');
  if (typeof run !== 'function') throw new UpgradeError('NO_RUNNER', 'a command runner is required');

  const git = (args) => run(['git', ...args], { cwd: repo });
  const events = [];

  /**
   * Refuse to move a tree that has uncommitted work in it.
   *
   * `git checkout --detach` with modified tracked files either refuses halfway
   * or carries the edits across, and both outcomes are discovered mid-upgrade.
   * Untracked files are fine: they are not part of any commit and survive a
   * checkout untouched, so they must not block an upgrade.
   */
  const dirty = git(['status', '--porcelain', '--untracked-files=no']);
  if (dirty.code !== 0) throw new UpgradeError('STATUS_FAILED', dirty.stderr || 'git status failed');
  const changed = dirty.stdout.trim();
  if (changed) {
    throw new UpgradeError(
      'DIRTY_TREE',
      `uncommitted changes would be carried across or lost:\n${changed}\n`
      + 'Commit them, or run: git stash push -u -m "before upgrade"',
    );
  }

  const fetch = git(['fetch', '--tags', 'origin']);
  if (fetch.code !== 0) throw new UpgradeError('FETCH_FAILED', fetch.stderr || 'git fetch failed');

  const before = git(['rev-parse', 'HEAD']);
  if (before.code !== 0) throw new UpgradeError('NO_HEAD', before.stderr || 'cannot read HEAD');
  const previousSha = before.stdout.trim();

  const resolved = git(['rev-parse', target]);
  if (resolved.code !== 0) throw new UpgradeError('UNKNOWN_TARGET', `cannot resolve ${target}`);
  const targetSha = resolved.stdout.trim();

  if (targetSha === previousSha) {
    log('up_to_date', { sha: previousSha });
    return { status: 'UP_TO_DATE', previousSha, newSha: previousSha, gates: [] };
  }

  const checkout = git(['checkout', '--detach', targetSha]);
  if (checkout.code !== 0) throw new UpgradeError('CHECKOUT_FAILED', checkout.stderr || 'git checkout failed');
  log('checked_out', { sha: targetSha });

  const results = [];
  for (const gate of gates) {
    const res = run(gate.argv, { cwd: repo, timeoutMs: gate.timeoutMs });
    results.push({ id: gate.id, code: res.code, stderr: (res.stderr || '').slice(0, 400) });
    log('gate', { id: gate.id, code: res.code });
    if (res.code !== 0) {
      log('gate_failed', { id: gate.id, sha: targetSha });
      return rollback({ repo, run, log, previousSha, targetSha, failedGate: gate.id, results });
    }
  }

  log('upgraded', { from: previousSha, to: targetSha });
  return {
    status: 'UPGRADED',
    previousSha,
    newSha: targetSha,
    gates: results,
    rollbackCommand: `git checkout ${previousSha} && npm ci --ignore-scripts`,
  };
}

async function rollback({ repo, run, log, previousSha, targetSha, failedGate, results }) {
  const git = (args) => run(['git', ...args], { cwd: repo });
  const back = git(['checkout', '--detach', previousSha]);
  if (back.code !== 0) {
    log('rollback_failed', { previousSha, stderr: (back.stderr || '').slice(0, 400) });
    return { status: 'ESCALATE', previousSha, newSha: targetSha, failedGate, gates: results, reason: 'could not return to the previous commit — intervene by hand' };
  }
  const reinstall = run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: repo, timeoutMs: 600_000 });
  log('rolled_back', { sha: previousSha, reinstallCode: reinstall.code });
  return {
    status: 'ROLLED_BACK',
    previousSha,
    newSha: targetSha,
    failedGate,
    gates: results,
    restored: reinstall.code === 0,
    ...(reinstall.code === 0 ? {} : { reason: 'code is back at the previous commit but dependencies may be out of sync — run npm ci' }),
  };
}
