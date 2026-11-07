/**
 * The installer itself: what `MAJIN-Setup.exe` promises.
 *
 * Inno Setup's compiler only runs on Windows, so these tests read the .iss as a
 * contract and CI is the one that compiles and *runs* it. The assertions are
 * about the things that are invisible when they are wrong: an installer without a
 * fixed AppId leaves a second entry in Add/Remove programs instead of updating;
 * one with `PrivilegesRequired=admin` fails outright on a work machine; a
 * `[UninstallDelete]` pointing at the data folder throws away someone's api keys
 * and memory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const iss = read('installer/majin.iss');
const wf = read('.github/workflows/build-exe.yml');

test('iss: it upgrades in place, needs no admin, and installs a program window', () => {
  assert.match(iss, /^AppId=\{\{[0-9A-F-]+\}$/m, 'a fixed GUID, doubled brace because { starts a constant in Inno, or an upgrade becomes a second install');
  assert.match(iss, /^AppName=\{#MyAppName\}$/m);
  assert.match(iss, /^PrivilegesRequired=lowest$/m, 'a locked-down laptop must still install it');
  assert.match(iss, /^PrivilegesRequiredOverridesAllowed=dialog$/m, 'and it may still go to Program Files when told to');
  assert.match(iss, /^DefaultDirName=\{autopf\}\\MAJIN$/m, 'per-user when unprivileged, machine-wide when not');
  assert.match(iss, /^ArchitecturesAllowed=x64compatible$/m, 'x64 only, and it says so instead of failing later');
  assert.match(iss, /^OutputBaseFilename=MAJIN-Setup$/m, 'the name the user is looking for');
  assert.match(iss, /^SetupIconFile=majin\.ico$/m, 'the M, not the default Inno cone');
  assert.match(iss, /^UninstallDisplayName=\{#MyAppName\}$/m, 'Add/Remove programs shows it by name');
  assert.match(iss, /#ifndef MyAppVersion/, 'the version comes from the build, with a fallback for hand runs');
  assert.match(iss, /Name: "\{group\}\\\{#MyAppName\}"/, 'a Start-menu entry');
  assert.match(iss, /^\[Icons\][\s\S]*MAJIN\.vbs/m, 'the shortcuts boot the hidden launcher, not a console');
  assert.match(iss, /^\[Run\][\s\S]*postinstall/ms, 'and offers to start it when the wizard finishes');
});

test('iss: autostart and the desktop icon are choices, and the command line is offered', () => {
  assert.match(iss, /^Name: "desktopicon"/m);
  assert.match(iss, /^Name: "autostart"[^\n]*Flags: unchecked$/m, 'auto-start must be opt-in, never a surprise');
  assert.match(iss, /^Root: HKCU;[^\n]*CurrentVersion\\Run"[^\n]*Tasks: autostart$/m, 'the Run key is tied to that task only');
  assert.match(iss, /uninsdeletevalue/, 'and it is the installer\s job to remove it again');
  assert.match(iss, /^Name: "cmdline"[^\n]*Flags: unchecked$/m, 'PATH is also opt-in');
  assert.match(iss, /Tasks: desktopicon/, 'the desktop icon is wired to its task');
  assert.match(iss, /UsePreviousTasks=no/, 'each install shows fresh shortcut choices, never inheriting an old "no icon"');
  assert.match(iss, /Name: "\{group\}\\\{#MyAppName\}"/, 'the Start Menu shortcut is unconditional -- there is always a way back in');
  assert.doesNotMatch(iss, /HKLM/, 'nothing machine-wide without an elevation the user asked for');
  assert.doesNotMatch(iss, /HKEY_LOCAL_MACHINE/, 'same on the long spelling');
});

test('iss: updating and uninstalling must not touch config, keys or memory', () => {
  assert.match(iss, /^\[Files\][\s\S]*majin-win-x64\.exe/m, 'the program is inside the package: no Node needed afterwards');
  assert.match(iss, /^\[UninstallRun\][\s\S]*"stop"/m, 'it stops the running program before deleting under it');
  const files = /\[Files\]([\s\S]*?)\n\[/.exec(iss)[1];
  assert.doesNotMatch(files, /localappdata\}\\MAJIN/i, 'the data folder is never packaged, so it is never replaced');
  assert.doesNotMatch(iss, /\[UninstallDelete\][\s\S]*localappdata/i, 'and never deleted by the uninstaller');
  assert.match(iss, /config, api keys and memory/, 'the reason is written where a maintainer will read it');
  assert.match(iss, /localappdata\}\\MAJIN/, 'the code knows where the data actually lives');
  const dirs = read('src/core/paths.js');
  const dataLine = dirs.match(/MAJIN'\)/)?.[0];
  assert.ok(dataLine, 'and that folder really is what paths.js uses');
});

test('iss: no reference to files the build does not stage', () => {
  for (const m of iss.matchAll(/^Source: "([^"]+)"/gm)) {
    const rel = m[1].replace(/\.\./, 'src').trim();
    if (rel.includes('majin-win-x64.exe') || rel.includes('majin.cmd')) continue; // built into installer/
    const p = path.join(ROOT, 'installer', m[1]);
    const exists = fs.existsSync(p) || /skipifsourcedoesntexist/.test(m.input);
    assert.ok(exists, `the .iss reads ${m[1]} without saying it may be absent`);
  }
  if (/^LicenseFile=(.*)$/m.test(iss)) {
    const f = /^LicenseFile=(.*)$/m.exec(iss)[1].trim();
    assert.ok(fs.existsSync(path.join(ROOT, 'installer', f)), `LicenseFile points at a missing file: ${f}`);
  }
});

test('build-installer: refuses to invent an installer, and says what to run instead', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-installer.mjs')], { encoding: 'utf8', timeout: 120000 });
  // no pkg build exists in this checkout, so the honest answer is a refusal
  assert.notEqual(r.status, 0, 'it must not succeed without dist/majin-win-x64.exe');
  assert.match(r.stderr, /majin-win-x64\.exe is missing/, r.stderr);
  assert.match(r.stderr, /npm run exe|gh workflow run/, 'and it names the command that fixes it: ' + r.stderr.slice(0, 160));

  const printed = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-installer.mjs'), '--print'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(printed.status, 0, printed.stderr);
  assert.match(printed.stdout, /iscc .*\.\.\/installer\/majin\.iss|iscc.*majin\.iss/, '--print shows the compile command');
  assert.match(printed.stdout, /dist\/installer\/MAJIN-Setup\.exe/, 'and where it lands');
  assert.equal(fs.existsSync(path.join(ROOT, 'installer', 'majin.cmd')), false, '--print writes nothing');
});

test('ci: the same verifier runs on the runner, so CI cannot pass on a weaker check', () => {
  assert.match(wf, /choco install innosetup/, 'the runner gets Inno Setup');
  assert.match(wf, /node scripts\/build-installer\.mjs/);
  assert.match(wf, /dist\/installer\/MAJIN-Setup\.exe/, 'and the artifact is asserted before the release');
  const verify = wf.slice(wf.indexOf('the installer must install'), wf.indexOf('the exe must run without'));
  assert.match(verify, /build-on-windows\.ps1 -SkipBuild -Ci/, 'CI delegates to the local script -- one verifier, no drift');
});

test('the Windows script installs, uses, restarts and uninstalls for real', () => {
  const ps = read('scripts/build-on-windows.ps1');
  assert.ok(ps.length > 5000, 'the verifier must be a real script: ' + ps.length + ' bytes');
  for (const [what, re] of [
    ['silent install', /\/VERYSILENT/],
    ['installed program answers', /@\('version'\)/],
    ['the window really serves', /\/api\/state/],
    ['health endpoint', /\/healthz/],
    ['a config change', /'config', 'set', 'name'/],
    ['stop is clean', /@\('stop'\)/],
    ['uninstall', /unins000\.exe/],
    ['data survives', /must survive/],
    ['content survives', /config did not survive the restart/],
  ]) {
    assert.match(ps, re, `the script must cover ${what}`);
  }
  assert.match(ps, /exit 1/, 'and every miss fails the run');
  // the checks that make "it works" mean something, not just "it installed"
  assert.match(ps, /id="composer"/, 'it must assert the real window came back, not only a port');
  assert.match(ps, /logo\.png/, 'and that the M is actually served');
  assert.match(ps, /port closed|still answers after stop/, 'a stop that does not stop is a failure');
  assert.match(ps, /Get-FileHash -Algorithm SHA256/, 'it prints the sha256 a user can verify');
  // a green run has to be about *this* install, not about a server left over from last time
  assert.match(ps, /'config', 'set', 'server\.port', \$Port/, 'the app is bound to -Port, so -Port means something');
  assert.match(ps, /is already serving/, 'and a stale listener on that port fails the run instead of passing it');
  assert.match(ps, /left the Desktop icon behind/, 'uninstall must take the Desktop icon with it');
  // the failure mode of a first local run is PowerShell 5.1 promoting npm's stderr noise to a
  // terminating error, so the script has to run native commands under Continue on purpose
  assert.match(ps, /NativeCommandError/, 'it must know about the PS 5.1 native-stderr trap');
  assert.match(ps, /function Run\([\s\S]{0,900}?\$ErrorActionPreference = 'Continue'/, 'and neutralise it inside the helper every build step goes through');
  assert.match(ps, /^\$ErrorActionPreference = 'Stop'$/m, 'while the script itself still stops on the first real error');
  assert.match(ps, /winget.*JRSoftware\.InnoSetup|winget install -e --id JRSoftware\.InnoSetup/, 'Inno Setup via winget, the runner-independent route');
  assert.doesNotMatch(ps, /net\.webclient|Invoke-Expression|iex /, 'no eval, no legacy downloader');
  assert.doesNotMatch(ps, /reboot|Restart-Computer|shutdown\b/i, 'it must never reboot the machine');
  assert.match(wf, /files: \|\n\s+dist\/installer\/MAJIN-Setup\.exe/, 'the release carries the installer first');
});

test('the zip wrapper builds via the shared script and asks for nothing but node', () => {
  const ps = read('scripts/install-windows.ps1');
  assert.ok(ps.length > 6000, 'the wrapper is a real script, not a stub: ' + ps.length + ' bytes');
  assert.match(ps, /build-on-windows\.ps1/, 'it delegates the build+verify to the one script CI also runs');
  assert.match(ps, /'-Port', \$Port/, 'and passes -Port through');
  assert.match(ps, /\$psArgs \+= '-SkipVerify'/, 'SkipVerify maps to the real skip flag, not to -SkipInstaller');
  assert.match(ps, /'ci'/, 'npm ci when package-lock.json is there, so the build is reproducible');
  assert.match(ps, /Node >= ?22\.0/, 'it checks the current node floor and says so');
  assert.match(ps, /OpenJS\.NodeJS\.LTS/, 'and hands out the winget line instead of a shrug');
  assert.match(ps, /LOCALAPPDATA/, 'it builds in LOCALAPPDATA, out of OneDrive and Downloads');
  assert.match(ps, /Stop-Here/, 'every dead end has its own sentence');
  assert.match(ps, /Get-FileHash -Algorithm SHA256/, 'it prints the sha256 of the installer');
  assert.match(ps, /1MB, 1/, 'and its size, so a stub cannot pass as a build');
  // the point of the zip: no GitHub, no token, no version-control commands
  assert.doesNotMatch(ps, /gh\s+release|git\s+push|git\s+am|GITHUB_TOKEN|Authorization|netrc/, 'no GitHub, no token, no manual git');
  assert.doesNotMatch(ps, /Invoke-Expression|iex |runAs/, 'no eval, no elevation');
  assert.ok(!/[^\x00-\x7F]/.test(ps.replace(/^\uFEFF/, '')), 'ASCII body, with an optional UTF-8 BOM supported by PS 5.1; no mojibake');
});

test('the double-click entry point is honest and stays open', () => {
  const bat = read('scripts/install-windows.bat');
  assert.match(bat, /ExecutionPolicy Bypass -File/, 'it bypasses the script policy for this one file');
  assert.match(bat, /%~dp0/, 'and calls the script next to it, not an assumed folder name');
  assert.match(bat, /pause/, 'the window stays open so a failure is actually readable');
  assert.match(bat, /ERRORLEVEL/, 'it reads the exit code instead of guessing');
  assert.doesNotMatch(bat, /del |rmdir|reg add|schtasks/, 'the .bat itself does nothing to the machine');
  assert.ok(!/[^\x00-\x7F]/.test(bat), 'ASCII, same reason');
});

test('-SkipVerify in the build script skips installing, not building', () => {
  const ps = read('scripts/build-on-windows.ps1');
  assert.match(ps, /\[switch\]\$SkipVerify/, 'the flag exists');
  const iSkip = ps.indexOf('if ($SkipVerify) {');
  const iInstall = ps.indexOf("Step 'install silently, the way the user will get it'");
  const iReport = ps.lastIndexOf('8. report'); // indexOf would hit the step list in the header comment
  assert.ok(iSkip > -1 && iInstall > iSkip && ps.slice(iSkip, iInstall).includes('} else {'), 'the install steps live inside the else-branch of the guard');
  assert.ok(iReport > iInstall && ps.slice(iInstall, iReport).includes('\n}\n'), 'and that branch closes before the report');
  assert.ok(ps.indexOf("Step 'MAJIN-Setup.exe (Inno Setup)'") < iSkip, 'the installer build sits before the guard, so -SkipVerify still produces a file');
});

test('publish: the script refuses an empty release and verifies the download', () => {
  const ps = read('scripts/publish.ps1');
  assert.match(ps, /is EMPTY/, 'the one failure mode the user called out is the one it checks for');
  assert.match(ps, /-lt 1MB/, 'and a stub-sized asset is refused as well');
  assert.match(ps, /Invoke-WebRequest -Uri \$Url -Method Head/, 'the URL must answer before it is reported');
  assert.match(ps, /releases\/download\/\$Tag\/MAJIN-Setup\.exe/, 'the direct link it prints is the release one');
  assert.match(ps, /MAJIN-Setup\.exe' \}|name -eq 'MAJIN-Setup\.exe'/, 'it looks for the installer by name');
  assert.match(ps, /gh run watch \$runId --exit-status/, 'it waits for the build instead of assuming');
  assert.match(ps, /no build-exe run for/, 'and notices if CI never picked up the commit');
  assert.doesNotMatch(ps, /gh release create/, 'it must not create a release of its own — the workflow does');
  assert.doesNotMatch(ps, /git push --force|push -f origin main/, 'never force-push main');
});

test('iss: the installer never lets a stale process outlive an upgrade', () => {
  const iss = fs.readFileSync(path.join(ROOT, 'installer', 'majin.iss'), 'utf8');
  assert.match(iss, /PrepareToInstall/, 'a PrepareToInstall hook exists');
  assert.match(iss, /taskkill\.exe[^\n]*\/F \/IM/, 'the running app is closed before files are replaced');
});



test('installed MAJIN shortcuts and embedded EXE use one freshly generated icon', () => {
  const entry = 'majin.ico';
  const backslash = String.fromCharCode(92);
  assert.ok(iss.includes('Source: "' + entry + '"; DestDir: "{app}"; Flags: ignoreversion'));
  assert.ok(iss.includes('UninstallDisplayIcon={app}' + backslash + entry));
  const shortcuts = iss.split(/\r?\n/).filter(x => x.includes('IconFilename:'));
  assert.equal(shortcuts.length, 2, 'start menu and desktop shortcuts both use the branded icon');
  for (const line of shortcuts) assert.ok(line.includes('IconFilename: "{app}' + backslash + entry), line);
  const exe = read('scripts/build-exe.mjs');
  assert.ok(exe.includes('refresh-icon.ps1'), 'the multi-size .ico is regenerated at build time');
  assert.ok(exe.includes("path.join(dist, 'assets', 'majin.ico')"));
  const installer = read('scripts/build-installer.mjs');
  assert.ok(installer.includes("'dist', 'assets', 'majin.ico'"));
});
