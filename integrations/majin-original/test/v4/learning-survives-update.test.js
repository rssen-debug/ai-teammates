/**
 * Learning must survive a release update.
 *
 * The brief requires learning to persist, and the release pipeline is a real
 * subsystem that writes over the installation. Learned skills live in the data
 * directory, not in the repository, so an update cannot reach them — but that is
 * a property of the layout, and a property nobody tests is a hope. A release that
 * quietly shipped a `learned-skills` directory, or an activation that copied the
 * data dir, would erase months of accumulated procedure.
 *
 * This drives the REAL `activateRelease` overlay against a fake installation that
 * has a data directory beside it, and asserts the skills are byte-identical.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { activateRelease, rollbackRelease } from '../../src/v4/updater.js';
import { v4Paths } from '../../src/v4/config.js';
import { tempHome } from './helpers.mjs';

function seedSkills(dataRoot) {
  const dir = path.join(dataRoot, 'learned-skills', 'learn-files-abc');
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    schema: 'majin.v4.skill/v1',
    name: 'learn-files-abc',
    title: 'files: fs_find → fs_read · 2 verified',
    learned: { schema: 'majin.v4.learned-skill/v1', state: 'REUSABLE', successes: 3, failures: 0 },
  };
  fs.writeFileSync(path.join(dir, 'skill.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# procedure\n');
  return dir;
}

test('update: learned skills live outside the installation, not inside it', () => {
  // The layout is the whole guarantee: if the data dir were ever computed from
  // the repo root, an update would overwrite it.
  const home = tempHome();
  try {
    const paths = v4Paths({ env: { MAJIN_HOME: home }, platform: 'linux' });
    assert.ok(paths.root.startsWith(home), 'the data root must live under the data home');
    assert.ok(!paths.root.includes(`${path.sep}src${path.sep}v4`), 'the data root must not be inside the source tree');
    assert.ok(paths.root.endsWith(`${path.sep}v4`));
    assert.notEqual(paths.workspace, paths.root, 'workspace and data must not be the same directory');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('update: an overlay release leaves learned skills byte-identical', () => {
  const home = tempHome();
  const live = path.join(home, 'MAJINCLI');
  const staging = path.join(home, 'staging');
  const backup = path.join(home, 'backup');
  const dataRoot = path.join(home, 'data', 'v4');
  try {
    // A real installation: source, plus installed dependencies the release does
    // not ship.
    fs.mkdirSync(path.join(live, 'src', 'v4'), { recursive: true });
    fs.writeFileSync(path.join(live, 'src', 'v4', 'agent.js'), 'old');
    fs.mkdirSync(path.join(live, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(live, 'node_modules', 'dep.js'), 'dep');

    // Accumulated learning, in the data directory beside the installation.
    const skillDir = seedSkills(dataRoot);
    const before = fs.readdirSync(skillDir).sort()
      .map((f) => [f, fs.readFileSync(path.join(skillDir, f), 'utf8')]);

    // The new release changes source only.
    fs.mkdirSync(path.join(staging, 'src', 'v4'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'src', 'v4', 'agent.js'), 'new');
    fs.writeFileSync(path.join(staging, 'package.json'), '{"version":"9.9.9"}');

    const act = activateRelease({ liveDir: live, stagingDir: staging, backupDir: backup });
    assert.equal(fs.readFileSync(path.join(live, 'src', 'v4', 'agent.js'), 'utf8'), 'new', 'the update did not apply');

    const after = fs.readdirSync(skillDir).sort()
      .map((f) => [f, fs.readFileSync(path.join(skillDir, f), 'utf8')]);
    assert.deepEqual(after, before, 'the update changed or removed a learned skill');

    // A failed release rolls back without touching learning either.
    rollbackRelease({ liveDir: live, backupDir: act.backupDir, journalFile: act.journalFile, added: act.added || [] });
    assert.equal(fs.readFileSync(path.join(live, 'src', 'v4', 'agent.js'), 'utf8'), 'old', 'the rollback did not restore');
    const afterRollback = fs.readdirSync(skillDir).sort()
      .map((f) => [f, fs.readFileSync(path.join(skillDir, f), 'utf8')]);
    assert.deepEqual(afterRollback, before, 'the rollback changed a learned skill');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('update: a release never contains a learned-skills directory', () => {
  // The release ships source. If a data directory ever appeared under the repo
  // (someone running `v4` from the checkout with a relative MAJIN_HOME), the
  // release builder must still not publish it.
  const fsMod = fs;
  const releaseScript = fsMod.readFileSync(path.resolve('scripts/v4/release.mjs'), 'utf8');
  const include = /const INCLUDE = \[([^\]]*)\]/.exec(releaseScript)?.[1] || '';
  assert.ok(!/learned-skills/.test(include), 'the release include list names learned-skills');
  assert.ok(!/data/.test(include), 'the release include list names a data directory');
});
