/**
 * Windows installer contract.
 *
 * PowerShell cannot run here (no pwsh in this image), so these are structural
 * checks on the script text. They exist because the failure modes are specific
 * and silent:
 *
 *   - Task Scheduler stops a task on battery unless told otherwise
 *   - the default ExecutionTimeLimit is 72 hours, after which Windows kills it
 *   - "just add a service" turns a per-user install into a machine-wide change
 *
 * V1's install.ps1 already solved these; V4 reuses its settings.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const installer = fs.readFileSync(path.join(ROOT, 'scripts/v4/install-v4-windows.ps1'), 'utf8');
const v1Installer = (() => {
  try {
    return fs.readFileSync(path.join(ROOT, 'install.ps1'), 'utf8');
  } catch {
    return '';
  }
})();

test('installer: the host keeps running on battery', () => {
  assert.match(installer, /-AllowStartIfOnBatteries/);
  assert.match(installer, /-DontStopIfGoingOnBatteries/);
});

test('installer: there is no 72-hour execution limit', () => {
  assert.match(installer, /ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.ok(!/ExecutionTimeLimit \(New-TimeSpan -Hours/.test(installer), 'no hour-based limit');
});

test('installer: a crashed host is restarted by Task Scheduler', () => {
  assert.match(installer, /-RestartCount/);
  assert.match(installer, /-RestartInterval/);
});

test('installer: it reuses the settings V1 already proved', () => {
  // If V1 is present, the three settings V4 borrowed must still be there —
  // otherwise the reuse claim in SOURCE_AUDIT.md would be stale.
  if (!v1Installer) return;
  for (const flag of ['AllowStartIfOnBatteries', 'DontStopIfGoingOnBatteries']) {
    assert.ok(v1Installer.includes(flag), `V1 no longer sets ${flag}; update docs/v4/SOURCE_AUDIT.md`);
    assert.ok(installer.includes(flag));
  }
  assert.match(v1Installer, /ExecutionTimeLimit/);
  assert.match(installer, /ExecutionTimeLimit/);
});

test('installer: a fresh install grants only the read-only network lanes', () => {
  // The default must not hand over the machine. Files, shell and desktop are the
  // owner's decision, made on the phone where the consequence is visible.
  assert.ok(installer.includes("$GrantLanes = @('web', 'research', 'jobs')"), 'the default grant set is the read-only network lanes');
  assert.ok(!/GrantLanes = @\('[^']*files/.test(installer), 'files must not be granted by default');
  assert.ok(!/GrantLanes = @\('[^']*shell/.test(installer), 'a shell must not be granted by default');
  assert.ok(!/GrantLanes = @\('[^']*desktop/.test(installer), 'desktop must not be granted by default');
});

test('installer: the grant is written as a schema-tagged file, not implied', () => {
  assert.match(installer, /majin\.v4\.owner-mode\/v1/);
  assert.match(installer, /owner-mode\.json/);
  assert.match(installer, /reason = 'installer'/);
});

test('installer: uninstall revokes the permissions it granted', () => {
  assert.match(installer, /Remove-Item \$OwnerMode -Force/);
  assert.match(installer, /Återkallade alla behörigheter|revoked/i);
});

test('installer: nothing is changed machine-wide', () => {
  const forbidden = [
    /Register-Service/i,
    /New-Service/i,
    /sc\.exe\s+create/i,
    /New-NetFirewallRule/i,
    /netsh\s+advfirewall/i,
    /netsh\s+interface\s+portproxy/i,
    /HKLM:/i,
  ];
  for (const re of forbidden) assert.ok(!re.test(installer), `must not contain ${re}`);
});

test('installer: a clean uninstall exists and leaves data alone', () => {
  assert.match(installer, /-Uninstall/);
  assert.match(installer, /Unregister-ScheduledTask/);
  assert.match(installer, /%LOCALAPPDATA%\\MAJIN\\v4/);
});

test('installer: it refuses to run on an old Node instead of failing later', () => {
  assert.match(installer, /major -lt 22/);
  assert.match(installer, /Fail/);
});

test('installer: the V4 task does not collide with the V1 task name', () => {
  const v4Name = (installer.match(/\$TaskName = '([^']+)'/) || [])[1];
  assert.equal(v4Name, 'MAJIN V4 Host');
  if (v1Installer) {
    const v1Names = [...v1Installer.matchAll(/-TaskName '([^']+)'/g)].map((m) => m[1]);
    assert.ok(!v1Names.includes(v4Name), `V4 must not reuse V1's task name ${v4Name}`);
  }
});

test('installer: the automatic update task exists, is daily, and verifies signatures', () => {
  assert.match(installer, /\[switch\]\$AutoUpdate/);
  assert.match(installer, /\$UpdateTaskName = 'MAJIN V4 Update'/);
  assert.match(installer, /New-ScheduledTaskTrigger -Daily -At \$UpdateTime/);
  assert.match(installer, /Join-Path \$RepoRoot 'scripts\\v4\\update\.mjs'/);
  assert.match(installer, /apply --quiet --log/);
  assert.match(installer, /-Argument \$updateArguments/);
  assert.doesNotMatch(installer, /-ArgumentList/, 'Scheduled Task actions accept Argument, not ArgumentList');
  assert.match(installer, /-RunOnlyIfNetworkAvailable/);
  assert.match(installer, /-ExecutionTimeLimit \(New-TimeSpan -Minutes 20\)/);
  // A failed update must not leave two updaters running against the same tree.
  assert.match(installer, /-MultipleInstances IgnoreNew/);
  // The task is registered by the same flow the owner already runs.
  assert.match(installer, /release-key\.json/);
});

test('installer: all Windows entry scripts parse in Windows PowerShell 5', { skip: process.platform !== 'win32' }, () => {
  /**
   * Two separate questions, asked separately.
   *
   * They used to share one PowerShell invocation, so a missing ScheduledTasks
   * cmdlet and a genuine syntax error produced the same failure — and a cold
   * powershell.exe start on a loaded runner could hit the 20 s timeout, which
   * then read as "the scripts do not parse". Each check now reports exactly what
   * went wrong, and the deadline is generous enough that a slow runner is not
   * mistaken for a broken script.
   */
  const run = (script) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, MAJIN_PS_PARSE_ROOT: ROOT },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
  const detail = (out) => [
    `status=${out.status}`,
    out.error ? `error=${out.error.code || out.error.message}` : null,
    out.signal ? `signal=${out.signal}` : null,
    out.stdout ? `stdout=${String(out.stdout).trim().slice(0, 600)}` : null,
    out.stderr ? `stderr=${String(out.stderr).trim().slice(0, 600)}` : null,
  ].filter(Boolean).join(' | ');

  const parse = run(`
    $ErrorActionPreference = 'Stop'
    $bad = @()
    foreach ($relative in @('install.ps1', 'scripts/install-windows.ps1', 'scripts/v4/install-v4-windows.ps1')) {
      $tokens = $null; $errors = $null
      $null = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $env:MAJIN_PS_PARSE_ROOT $relative), [ref]$tokens, [ref]$errors)
      if ($errors.Count) { $bad += ($relative + ': ' + ($errors | ForEach-Object { $_.Message } | Select-Object -First 3) -join '; ') }
    }
    if ($bad.Count) { Write-Output ($bad -join ' || '); exit 3 }
    Write-Output 'parsed'
  `);
  assert.equal(parse.status, 0, `a Windows entry script has a syntax error: ${detail(parse)}`);
  assert.match(String(parse.stdout), /parsed/);

  // ScheduledTasks must expose the parameters the installer relies on. This is a
  // runtime capability, not a syntax question, so it is asserted on its own.
  const cmdlet = run(`
    $ErrorActionPreference = 'Stop'
    $c = Get-Command New-ScheduledTaskAction -ErrorAction Stop
    if (-not $c.Parameters.ContainsKey('Argument')) { Write-Output 'no Argument'; exit 4 }
    Write-Output 'ok'
  `);
  assert.equal(cmdlet.status, 0, `ScheduledTasks is unusable here: ${detail(cmdlet)}`);
});

test('installer: uninstall removes the update task too', () => {
  assert.match(installer, /Unregister-ScheduledTask -TaskName \$UpdateTaskName/);
});

test('installer: here-strings are balanced (the one syntax error that breaks the whole script)', () => {
  // In PowerShell the closing "@ must START a line, but code may follow it on
  // the same line ("@ | Set-Content ...), which is how the launcher is written.
  const openers = (installer.match(/^\s*@"\s*$/gm) || []).length;
  const closers = (installer.match(/^\s*"@/gm) || []).length;
  assert.equal(openers, closers, `@" opened ${openers} times, "@ closed ${closers}`);
  assert.ok(openers >= 1, 'the launcher is written through a here-string');

  // A line-continuation backtick must be the last character on its line.
  // Backticks inside strings (`n, `t) are legal and are not continuations.
  installer.split(/\r?\n/).forEach((line, i) => {
    if (line.trim().startsWith('#')) return;
    if (!line.trimEnd().endsWith('`')) return;
    assert.equal(line, line.trimEnd(), `line ${i + 1}: whitespace after a continuation backtick`);
  });
});
