<#
  MAJIN 0.1.1 - Windows build + install + verify, one double click.

  You do not need git, GitHub, a token, or Visual Studio. What this script does:

    1. checks the machine (PowerShell 5+, Node >= 22.0, room on disk, a folder it may write to)
    2. copies the source next to it into %LOCALAPPDATA%\MAJIN\src  (a boring, writeable, non-synced path -
       OneDrive folders and "Downloads" are where npm builds usually die)
    3. installs the build tools from npm (esbuild, pkg, resedit)
    4. builds dist\majin-win-x64.exe and dist\installer\MAJIN-Setup.exe with Inno Setup
       (Inno Setup itself is installed with winget when the machine has none)
    5. installs MAJIN for real, starts it, checks its API and its window, restarts it, uninstalls it,
       checks your settings survived, and installs it again so you keep a working MAJIN
    6. prints where the .exe is, its size and sha256, and opens the folder

  Everything printed here is also written to INSTALL-log.txt next to this script, and the detailed build
  log lands in %LOCALAPPDATA%\MAJIN\src\build-notes.txt. If a step fails, paste one of those two files back
  to the agent and it will fix exactly that.

  Switches: -KeepInPlace (build where the zip was extracted) -SkipVerify (build only, no install test)
            -Port 9199 (if 8787 is taken) -NoPause (for automation) -Source C:\path\to\repo
#>

param(
  [switch]$KeepInPlace,
  [switch]$SkipVerify,
  [switch]$NoPause,
  [switch]$Legacy,
  [string]$Port = '8787',
  [string]$Source = ''
)

$ErrorActionPreference = 'Stop'
if (-not $Legacy) {
  $v4Source = if ($Source) { $Source } else { Split-Path -Parent $PSScriptRoot }
  & (Join-Path $v4Source 'install.ps1') -NoTask:$SkipVerify
  if (-not $?) { exit 1 }
  exit 0
}
$ProgressPreference = 'SilentlyContinue'
$here = $PSScriptRoot
$log = Join-Path $here 'INSTALL-log.txt'
$buildRoot = Join-Path $env:LOCALAPPDATA 'MAJIN\src'
$problems = @()
$step = 0
$steps = 6

function Stamp { (Get-Date -Format 'HH:mm:ss') }
function Line($m) { Write-Host $m; Add-Content -Path $log -Value ((Stamp) + '  ' + $m) }
function Head($m) {
  $script:step++
  Write-Host ''
  Write-Host ('[' + $script:step + '/' + $script:steps + '] ' + $m) -ForegroundColor Cyan
  Add-Content -Path $log -Value ((Stamp) + '  == ' + $m)
}
function Good($m) { Line('      ok      ' + $m) }
function Info($m) { Line('      ..      ' + $m) }
function Bad($m) {
  $script:problems += $m
  Write-Host ('      FAIL    ' + $m) -ForegroundColor Red
  Add-Content -Path $log -Value ((Stamp) + '      FAIL    ' + $m)
}
function Stop-Here($why) {
  Write-Host ''
  Write-Host '  BUILD STOPPED - nothing was installed.' -ForegroundColor Red
  Write-Host ('  reason: ' + $why) -ForegroundColor Yellow
  Write-Host ''
  Write-Host ('  log: ' + $log) -ForegroundColor DarkGray
  if (-not $NoPause) { Read-Host '  press Enter to close' }
  exit 1
}
# Native commands write harmless warnings to stderr, and PowerShell 5.1 turns a stderr line into a
# terminating error while the preference is Stop. So run them under Continue and trust the exit code.
function Native($exe, $argv, $blurb) {
  $ErrorActionPreference = 'Continue'
  Info ($blurb + '  (' + $exe + ')')
  $out = & $exe @argv 2>&1
  $code = $LASTEXITCODE
  ($out | Out-String) | Add-Content -Path $log
  if ($code -ne 0) {
    $tail = ($out | Select-Object -Last 15 | Out-String).Trim()
    Bad ($blurb + ' exited with code ' + $code)
    if ($tail.Length -gt 0) { Write-Host '        last lines:' -ForegroundColor DarkGray; ($tail -split "`n") | ForEach-Object { Write-Host ('        ' + $_) -ForegroundColor DarkGray } }
    return $null
  }
  return $out
}

Set-Content -Path $log -Value ('=== MAJIN windows build ' + (Get-Date -Format 's') + ' ===')
Write-Host ''
Write-Host '  M### M### MAJIN 0.1.1  -  Windows build and install' -ForegroundColor Magenta
Write-Host '  ====================================================' -ForegroundColor DarkMagenta
Line ('cwd ' + (Get-Location).Path)

# ------------------------------------------------------------------ 1. the machine
Head 'checking this machine'
$psv = $PSVersionTable.PSVersion
if ($psv.Major -lt 5) { Stop-Here ('Windows PowerShell 5.1 or newer is required, found ' + $psv) }
Good ('PowerShell ' + $psv)

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Stop-Here ('node is not installed or not on PATH. Fix it with:  winget install -e --id OpenJS.NodeJS.LTS   then run INSTALL.bat again in a NEW terminal window.')
}
$nv = ''
try { $nv = ((& node --version 2>&1) | Select-Object -First 1) } catch { $nv = '' }
$nv = ($nv -replace '^v', '')
$parts = $nv.Split('-')[0].Split('.')
if ($parts.Count -lt 2 -or [int]$parts[0] -lt 22) {
  Stop-Here ('node ' + $nv + ' is too old; MAJIN requires Node.js 22 or newer:  winget install -e --id OpenJS.NodeJS.LTS')
}
Good ('node ' + $nv + '  ' + $node.Source)
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Stop-Here 'npm is missing (it ships with node - reinstall node and open a new terminal)' }

$freeGB = 0
try { $freeGB = [math]::Round(((Get-PSDrive ($buildRoot.Substring(0, 1))).Free / 1GB), 1) } catch { $freeGB = 99 }
if ($freeGB -lt 1.5) { Bad ('only ' + $freeGB + ' GB free on the system drive; the build needs about 1.5 GB') }
else { Good ('disk: ' + $freeGB + ' GB free') }
if ($Port -notmatch '^\d+$') { Stop-Here ('-Port must be a number, got ' + $Port) }

# ------------------------------------------------------------------ 2. the source
Head 'finding the source'
$src = $Source
if (-not $src) {
  $cand = Join-Path $here 'app'
  if ($KeepInPlace) { $cand = $here }
  $src = $cand
}
if (-not (Test-Path (Join-Path $src 'package.json'))) { Stop-Here ('no MAJIN source in ' + $src + ' - extract the whole zip (keep the app folder inside it) and run INSTALL.bat from there') }
if (-not (Test-Path (Join-Path $src 'scripts\build-on-windows.ps1'))) { Stop-Here ('the zip is incomplete: ' + $src + ' has no scripts\build-on-windows.ps1') }
Good ('source: ' + $src)

$work = $buildRoot
if ($KeepInPlace) { $work = $src }
else {
  Info ('copying to ' + $work + ' (npm does not like OneDrive and Downloads)')
  if (Test-Path $work) {
    # a MAJIN still running from a previous run locks its own files; say so instead of dying cryptically
    try { Remove-Item $work -Recurse -Force -ErrorAction Stop } catch {
      Info 'some files could not be deleted (a running MAJIN?) -- trying to stop it and continue'
      $installedExe = Join-Path $env:LOCALAPPDATA 'Programs\MAJIN\majin-win-x64.exe'
      if (Test-Path $installedExe) { $null = Native $installedExe @('stop') 'majin stop' }
      else { Info 'MAJIN is not installed here, so the lock is something else (antivirus, an open window)' }
      try { Remove-Item $work -Recurse -Force -ErrorAction Stop } catch { Stop-Here ('cannot clear ' + $work + ' -- close MAJIN, or log out and in again, then run INSTALL.bat once more') }
    }
  }
  $null = New-Item -ItemType Directory -Force -Path $work
  Copy-Item -Path (Join-Path $src '*') -Destination $work -Recurse -Force
  if (-not (Test-Path (Join-Path $work 'package.json'))) { Stop-Here ('the copy to ' + $work + ' failed - check that you can write there') }
  Good 'copied'
}
$setup = Join-Path $work 'scripts\build-on-windows.ps1'
$distSetup = Join-Path $work 'dist\installer\MAJIN-Setup.exe'
$distExe = Join-Path $work 'dist\majin-win-x64.exe'
$notes = Join-Path $work 'build-notes.txt'

# ------------------------------------------------------------------ 3. the tools
Head 'installing the build tools from npm'
Set-Location $work
if (Test-Path (Join-Path $work 'node_modules\esbuild')) {
  Good 'build tools already present'
} else {
  $mode = @('install', '--no-audit', '--no-fund')
  if (Test-Path (Join-Path $work 'package-lock.json')) { $mode = @('ci', '--no-audit', '--no-fund') }
  Info ('npm ' + $mode[0] + ' - this is the slow step, a minute or two on a first run')
  $out = Native 'npm' $mode 'npm'
  if ($null -eq $out) { Stop-Here ('npm could not install the build tools. Check internet access, then run again. Details: ' + (Join-Path $env:LOCALAPPDATA 'npm-cache\_logs')) }
  Good 'esbuild, pkg, resedit installed'
}

# ------------------------------------------------------------------ 4+5. build, install, verify
Head 'building MAJIN-Setup.exe (bundle, single-file exe, embedded M icon, Inno Setup)'
Line '      the same script GitHub Actions runs, so "green here" and "green in CI" mean the same thing'
$psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $setup, '-Port', $Port)
if ($SkipVerify) { $psArgs += '-SkipVerify' }
$out = Native 'powershell' $psArgs 'build-on-windows.ps1'
$built = (Test-Path $distSetup)
if ($null -eq $out -and -not $built) {
  if (Test-Path $notes) {
    Write-Host '        --- tail of build-notes.txt ---' -ForegroundColor DarkGray
    (Get-Content $notes -Tail 20 -ErrorAction SilentlyContinue) | ForEach-Object { Write-Host ('        ' + $_) -ForegroundColor DarkGray }
  }
  Stop-Here ('the build failed before producing ' + $distSetup + '. The 20 lines above (or build-notes.txt) are what to paste back.')
}

Head 'verifying the installer on this machine'
if ($SkipVerify) {
  Info 'verification skipped (-SkipVerify)'
} elseif (-not $built) {
  Stop-Here ('the build claimed success but ' + $distSetup + ' is not there')
} else {
  $sz = [math]::Round((Get-Item $distSetup).Length / 1MB, 1)
  if ($sz -lt 1) { Stop-Here ('MAJIN-Setup.exe is ' + $sz + ' MB - too small to contain the program; the build did not really work') }
  Good ('installer built: ' + $sz + ' MB')
  $desk = @(("$env:USERPROFILE\Desktop"), ("$env:USERPROFILE\OneDrive\Desktop")) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($desk -and (Test-Path (Join-Path $desk 'MAJIN.lnk'))) { Good ('desktop icon: ' + (Join-Path $desk 'MAJIN.lnk')) }
  else { Info 'no MAJIN.lnk on the Desktop (the verifier reports this if Inno did not create it)' }
  try {
    $h = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/healthz') -TimeoutSec 5
    if ($h.ok) { Good ('the installed program answers on port ' + $Port + ' (version ' + $h.version + ')') }
    else { Bad 'the installed program answered /healthz without ok' }
  } catch {
    Info 'the program is not listening right now - it starts on login or from the Desktop icon'
  }
}

# ------------------------------------------------------------------ 6. the result
Head 'done'
$hash = ''
if ($built) { $hash = (Get-FileHash -Algorithm SHA256 -Path $distSetup).Hash.ToLower() }
Write-Host ''
Write-Host '  YOUR FILE' -ForegroundColor Green
Write-Host ('    ' + $distSetup)
if ($built) {
  Write-Host ('    size ' + [math]::Round((Get-Item $distSetup).Length / 1MB, 1) + ' MB')
  Write-Host ('    sha256 ' + $hash)
  Write-Host '    double-click it to install MAJIN again on any Windows 10/11 machine (no node, no git needed there)' -ForegroundColor DarkGray
  Write-Host ''
  Write-Host '  what it installs: a real program in %LOCALAPPDATA%\Programs\MAJIN, a Desktop icon, a Start-menu'
  Write-Host '  entry, "majin" on the PATH, an uninstaller in Settings > Apps, and it can start at login.'
  Write-Host '  Uninstalling removes the program but keeps your settings, keys and memory.' -ForegroundColor DarkGray
}
Write-Host ''
Write-Host ('  build log:   ' + $notes) -ForegroundColor DarkGray
Write-Host ('  setup log:   ' + $log) -ForegroundColor DarkGray
if ($problems.Count -gt 0) {
  Write-Host ''
  Write-Host ('  ' + $problems.Count + ' problem(s) above.') -ForegroundColor Yellow
  if (-not $NoPause) { Read-Host '  press Enter to close' }
  exit 1
}
if (-not $NoPause) {
  $answer = Read-Host '  press Enter to open the folder with MAJIN-Setup.exe (or Ctrl+C to leave it)'
  if ($answer -ne $null -and $built) { Start-Process explorer.exe -ArgumentList ('/select,"' + $distSetup + '"') }
}
Write-Host ''
exit 0
