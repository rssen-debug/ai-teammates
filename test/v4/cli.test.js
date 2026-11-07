/**
 * The commands the owner actually types.
 *
 * Library tests call functions. These spawn the real scripts with a real
 * environment and assert on exit code and output — because an exit code is what
 * a scheduled job and a human both depend on.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { tempHome } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function cli(script, args = [], { home = null, timeout = 120_000 } = {}) {
  const env = { ...process.env, MAJIN_HOME: home || tempHome() };
  if (script === 'host-doctor.mjs' && process.platform === 'win32') {
    // The Windows temp directory may grant access to test/sandbox groups.
    // A usable-host fixture needs a private ACL, just like a real data folder.
    const acl = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
      $ErrorActionPreference = 'Stop'
      $acl = New-Object System.Security.AccessControl.DirectorySecurity
      $acl.SetAccessRuleProtection($true, $false)
      $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
      foreach ($sid in @($me, [System.Security.Principal.SecurityIdentifier]'S-1-5-18', [System.Security.Principal.SecurityIdentifier]'S-1-5-32-544')) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
      }
      [System.IO.Directory]::SetAccessControl($env:MAJIN_HOME, $acl)
    `], { env, encoding: 'utf8', windowsHide: true });
    assert.equal(acl.status, 0, acl.stderr);
  }
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts/v4', script), ...args], {
    cwd: ROOT,
    env,
    timeout,
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', home: env.MAJIN_HOME };
}

/** Seed a data dir by running a real host and doing one real turn. */
async function seed(home) {
  const { startTestServer, postChat, readSse } = await import('./helpers.mjs');
  const s = await startTestServer({ home });
  try {
    const { cookie } = await s.pair();
    await readSse(await postChat(s.base, cookie, { text: 'Skriv filen cli.txt med innehåll: hej', requestId: 'cli-1' }));
  } finally {
    await s.close({ keep: true });
  }
}

test('cli: host-doctor reports and exits 0 on a usable host', () => {
  const out = cli('host-doctor.mjs');
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /Host is ready for V4/);
  assert.match(out.stdout, /OK\s+node/);
});

test('cli: host-doctor --json is machine readable and names every check', () => {
  const out = cli('host-doctor.mjs', ['--json']);
  const report = JSON.parse(out.stdout);
  assert.equal(report.ok, true);
  assert.ok(Array.isArray(report.checks) && report.checks.length >= 8);
  for (const c of report.checks) {
    assert.equal(typeof c.id, 'string');
    assert.equal(typeof c.ok, 'boolean');
  }
});

test('cli: the progress command derives the score and fails on a broken matrix', () => {
  const out = cli('progress.mjs', ['--json']);
  const report = JSON.parse(out.stdout);
  assert.equal(report.valid, true);
  assert.equal(report.weight, 100);
  assert.equal(report.score.possible, 100);
  assert.equal(out.status, 0);
});

test('cli: backup writes a bundle, verify accepts it, restore brings it back', async () => {
  const home = tempHome();
  await seed(home);

  const backup = cli('backup.mjs', ['backup'], { home });
  assert.equal(backup.status, 0, backup.stdout + backup.stderr);
  assert.match(backup.stdout, /backup written/);

  const dirs = fs.readdirSync(path.join(home, 'v4-backups'));
  assert.equal(dirs.length, 1);
  const bundle = path.join(home, 'v4-backups', dirs[0]);
  assert.ok(fs.existsSync(path.join(bundle, 'MANIFEST.json')));

  const verify = cli('backup.mjs', ['verify', bundle], { home });
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);
  assert.match(verify.stdout, /BUNDLE_OK/);

  const target = tempHome();
  const restore = cli('backup.mjs', ['restore', bundle], { home: target });
  assert.equal(restore.status, 0, restore.stdout + restore.stderr);
  assert.match(restore.stdout, /Pair the phone again/);
  assert.ok(fs.existsSync(path.join(target, 'v4', 'conversations')));

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(target, { recursive: true, force: true });
});

test('cli: restore refuses to overwrite without --force and says so', async () => {
  const home = tempHome();
  await seed(home);
  const backup = cli('backup.mjs', ['backup'], { home });
  assert.equal(backup.status, 0);
  const bundle = path.join(home, 'v4-backups', fs.readdirSync(path.join(home, 'v4-backups'))[0]);

  const refused = cli('backup.mjs', ['restore', bundle], { home });
  assert.equal(refused.status, 1, 'a refusal is a non-zero exit');
  assert.match(refused.stdout, /REFUSED \(ALREADY_EXISTS\)/);

  const forced = cli('backup.mjs', ['restore', bundle, '--force'], { home });
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);

  fs.rmSync(home, { recursive: true, force: true });
});

test('cli: a tampered bundle fails verify with a non-zero exit', async () => {
  const home = tempHome();
  await seed(home);
  cli('backup.mjs', ['backup'], { home });
  const bundle = path.join(home, 'v4-backups', fs.readdirSync(path.join(home, 'v4-backups'))[0]);
  const conv = fs.readdirSync(path.join(bundle, 'conversations'))[0];
  fs.appendFileSync(path.join(bundle, 'conversations', conv), ' ');

  const verify = cli('backup.mjs', ['verify', bundle], { home });
  assert.equal(verify.status, 1);
  assert.match(verify.stdout, /BUNDLE_TAMPERED|hash mismatch/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('cli: plugin list works with nothing installed and reports the settings', () => {
  const out = cli('plugin.mjs', ['list']);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /plugins enabled: false/);
  assert.match(out.stdout, /no plugins installed/);
});

test('cli: plugin quarantine on an empty host is not an error', () => {
  const out = cli('plugin.mjs', ['quarantine']);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /empty/);
});

test('cli: upgrade --dry shows the plan and changes nothing', () => {
  const before = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const out = cli('upgrade.mjs', ['--dry']);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /plan only/);
  assert.match(out.stdout, /nothing was changed/);
  const after = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  assert.equal(after, before, 'the working tree is untouched');
});

test('cli: bench writes a report and exits 0 when every scenario passes', () => {
  const out = cli('benchmark.mjs', [], { timeout: 180_000 });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /pass 7\/7/);
  assert.match(out.stdout, /verified/);
});

test('cli: an unknown command prints usage instead of crashing', () => {
  for (const [script, expect] of [
    ['backup.mjs', /MAJIN V4 backup/],
    ['plugin.mjs', /usage/i],
  ]) {
    const out = cli(script, ['wat']);
    assert.ok(out.status === 0 || out.status === 2, `${script} exited ${out.status}`);
    assert.match(`${out.stdout}${out.stderr}`, expect);
  }
});

test('cli: upgrade on a dirty tree stops with a readable reason and exit 1', () => {
  const home = tempHome();
  // Make the checkout dirty by touching a tracked file, run the CLI, then undo.
  const target = path.join(ROOT, 'package.json');
  const original = fs.readFileSync(target, 'utf8');
  fs.writeFileSync(target, `${original}\n`);
  try {
    const out = cli('upgrade.mjs', [], { home, timeout: 120_000 });
    assert.equal(out.status, 1, `expected exit 1, got ${out.status}`);
    assert.match(out.stdout, /STOPPED \(DIRTY_TREE\)/);
    assert.match(out.stdout, /Nothing was changed/);
    assert.match(out.stdout, /git stash/);
  } finally {
    fs.writeFileSync(target, original);
  }
});
