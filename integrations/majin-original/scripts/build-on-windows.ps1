<#
.SYNOPSIS
  Build and verify MAJIN-Setup.exe on a Windows machine -- the whole chain in one
  command, with the checks CI runs, so a green local run means the same thing as a
  green CI run.

.DESCRIPTION
  What it does, in order, and stops at the first failure with the log it captured:

    1. preflight      node >= 22.0 (or the winget line to fix it), npm, git
    2. npm install    devDependencies only: esbuild, @yao-pkg/pkg, resedit
    3. build the app  dist/majin-win-x64.exe  (bundle -> pkg -> M icon embedded)
    4. build installer  dist/installer/MAJIN-Setup.exe  (Inno Setup, installed if missing)
    5. install it      silent, to the per-user location, with the Desktop icon
    6. verify it       run the installed exe, start the installed program, talk to its
                       own API, read the served window, change config, restart, stop
    7. uninstall test  uninstall silently, assert the program is gone AND that
                       config/keys/memory survived; then reinstall so you keep MAJIN

  -SkipVerify stops after step 4: you get MAJIN-Setup.exe built and size-checked, and nothing is
  installed on the machine. -SkipInstaller means "exe only", and then steps 5-7 are skipped too,
  because there is no installer to install.
    8. report          file sizes, sha256 for both artifacts, where the logs are

  Two guards worth knowing about: the installed app is bound to -Port through its own
  config (so -Port is not decorative), and the run stops if something already answers on
  that port before we start -- a server left over from an earlier attempt would fake
  every check in step 6 and report a green install.

  It never needs admin. Nothing is published to GitHub by this script -- printing the
  upload command is as far as it goes.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-on-windows.ps1
.EXAMPLE
  ... -SkipBuild -VerifyOnly        # just run steps 5-7 against what is already built
  ... -Ci                           # GitHub-actions flavour: ::error:: markers, no desktop copy
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$SkipInstaller,
  [switch]$SkipVerify,
  [switch]$VerifyOnly,
  [switch]$NoUninstallTest,
  [switch]$LeaveUninstalled,
  [switch]$Ci,
  [string]$Port = '8787'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$log = Join-Path $root 'build-notes.txt'
$env:MAJIN_HOME = Join-Path $env:LOCALAPPDATA 'MAJIN-setup-verify'
$appDir = Join-Path $env:LOCALAPPDATA 'Programs\MAJIN'
$exeName = 'majin-win-x64.exe'
$setupExe = Join-Path $root 'dist\installer\MAJIN-Setup.exe'
$appExe = Join-Path $root "dist\$exeName"
$fails = 0

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "  ok      $m" -ForegroundColor Green }
function Note($m) { Write-Host "  note    $m" -ForegroundColor Yellow }
function Fail($m) {
  $script:fails++
  $line = "::error::$m"
  if ($Ci) { Write-Host $line }
  Write-Host "  FAIL    $m" -ForegroundColor Red
}
function Tell($m) { Write-Host "  ..      $m" -ForegroundColor DarkGray }
function Log($m) { Add-Content -Path $log -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) }
function Ver($exe) {
  # a version probe must never be the thing that stops a build; report '?' and move on
  $ErrorActionPreference = 'Continue'
  try { return ((& $exe --version 2>&1) | Select-Object -First 1) } catch { return '?' }
}
function Run($file, $argv, $blurb) {
  # Windows PowerShell 5.1 turns ANY stderr line from a native command into a terminating
  # NativeCommandError when the merged preference is Stop -- and `npm install` writes perfectly
  # normal deprecation warnings to stderr. So this function runs its command under Continue and
  # decides from $LASTEXITCODE instead. Without this the build dies on its first step, on a machine
  # where the build is fine.
  $ErrorActionPreference = 'Continue'
  Tell "$blurb  ($file $(($argv | Select-Object -First 2) -join ' '))"
  $out = & $file @argv 2>&1
  $code = $LASTEXITCODE
  ($out | Out-String) | Add-Content -Path $log
  if ($code -ne 0) {
    $tail = ($out | Select-Object -Last 12 | Out-String).Trim()
    Fail "$blurb exited $code -- last lines:`n$tail"
    return $null
  }
  return $out
}

Set-Location $root
("=== MAJIN windows build " + (Get-Date -Format 's') + " ===") | Set-Content -Path $log
Log "root=$root ci=$Ci skipBuild=$SkipBuild verifyOnly=$VerifyOnly"

# ---------------------------------------------------------------- 1. preflight
Step 'preflight: what this machine has'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail 'node is not on PATH -- install it:  winget install -e --id OpenJS.NodeJS.LTS   (then open a new terminal)'
} else {
  $nv = (Ver 'node') -replace '^v', ''
  $parts = $nv.Split('-')[0].Split('.')
  if ([int]$parts[0] -lt 22) {
    Fail "node $nv is too old for MAJIN (need >= 22.0):  winget install -e --id OpenJS.NodeJS.LTS"
  } else { Ok "node $nv" }
}
foreach ($tool in @(@{ n = 'npm'; i = 'bundled with node' }, @{ n = 'tar'; i = 'ships with Windows 10/11' })) {
  if (-not (Get-Command $tool.n -ErrorAction SilentlyContinue)) { Fail "$($tool.n) is missing ($($tool.i))" }
  else { Ok "$($tool.n) $(Ver $tool.n)" }
}
if (-not (Test-Path (Join-Path $root 'package.json'))) { Fail "this is not the MAJIN checkout: $root" }
if ($fails) { Write-Host "`nfix the above and re-run" -ForegroundColor Red; exit 1 }

if ($SkipBuild -or $VerifyOnly) {
  Step 'using what is already built'
} else {
  # ------------------------------------------------------------ 2. devDependencies
  Step 'devDependencies (esbuild, pkg, resedit, js-yaml)'
  if (-not (Test-Path (Join-Path $root 'node_modules\esbuild'))) {
    $null = Run 'npm' @('install', '--no-audit', '--no-fund') 'npm install'
    if ($fails) { exit 1 }
  } else { Ok 'node_modules present' }

  # --------------------------------------------------------------- 3. build the app
  Step "build $exeName (bundle + pkg + embedded M icon)"
  $out = Run 'node' @('scripts/build-exe.mjs') 'build-exe'
  if ($null -eq $out) {
    Fail 'the single-file exe could not be built. Most likely cause: pkg could not fetch its node host binary. The small installer still works from the bundle: re-run with -SkipBuild after "node scripts/build-exe.mjs --no-pkg".'
    exit 1
  }
  if (-not (Test-Path $appExe)) { Fail "no $appExe after a build that claimed success"; exit 1 }
  $sz = [math]::Round((Get-Item $appExe).Length / 1MB, 1)
  if ($sz -lt 20) { Fail "$exeName is only $sz MB -- too small to contain node"; exit 1 }
  Ok "$exeName $sz MB"
  if (($out | Out-String) -notmatch 'icon:\s*(majin|ok|embedded|.*size)') {
    Note 'the icon step did not report embedding -- the taskbar will use the default glyph'
  }
  $v = Run $appExe @('version') 'the built exe must run'
  if ($null -eq $v) { exit 1 }
  Ok "version: $v"

  # ------------------------------------------------------------- 4. build installer
  Step 'MAJIN-Setup.exe (Inno Setup)'
  $iscc = Get-Command iscc -ErrorAction SilentlyContinue
  if (-not $iscc) {
    foreach ($cand in @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe")) {
      if (Test-Path $cand) { $iscc = $cand; break }
    }
  }
  if (-not $iscc) {
    Note 'Inno Setup not found -- installing it (this is the only thing the script downloads)'
    $null = Run 'winget' @('install', '-e', '--id', 'JRSoftware.InnoSetup', '--silent') 'winget install innosetup'
    foreach ($cand in @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe")) {
      if (Test-Path $cand) { $iscc = $cand; break }
    }
  }
  if (-not $iscc) {
    Fail 'iscc.exe still not found. Install Inno Setup by hand (https://jrsoftware.org/isdl.php), then:  npm run installer'
    exit 1
  }
  Ok "iscc: $iscc"
  $env:ISCC = "$iscc"
  $out = Run 'node' @('scripts/build-installer.mjs') 'build-installer'
  if ($null -eq $out) { exit 1 }
  if (-not (Test-Path $setupExe)) { Fail "no $setupExe after iscc said OK"; exit 1 }
}

if ($SkipInstaller) { Step 'installer build skipped (-SkipInstaller)' }
if ($VerifyOnly -or $SkipInstaller) { Ok 'verification only' }

$installState = @{ installed = $false; served = $false; dataKept = $false; iconGone = $null }

if ($SkipVerify) {
  Step 'install and uninstall tests skipped (-SkipVerify)'
} elseif ($SkipInstaller -and -not (Test-Path $setupExe)) {
  Step 'no installer to install (-SkipInstaller) -- skipping install, verify and uninstall'
  Note "the single-file exe was still built and checked: dist\$exeName"
} else {

# ------------------------------------------------------------------ 5. install it
Step 'install silently, the way the user will get it'
if (-not (Test-Path $setupExe)) {
  Fail "no $setupExe -- run without -SkipBuild"
  exit 1
}
$setupLog = Join-Path $env:TEMP 'majin-setup-run.log'
Remove-Item $setupLog -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $setupExe -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/TASKS=desktopicon', "/LOG=$setupLog" -Wait
if (-not (Test-Path (Join-Path $appDir $exeName))) {
  Get-Content $setupLog -Tail 25 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" }
  Fail "the installer finished but $appDir\$exeName is not there (see $setupLog)"
  exit 1
}
$installState.installed = $true
Ok "installed to $appDir"
$desk = @("$env:USERPROFILE\Desktop", "$env:USERPROFILE\OneDrive\Desktop") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($desk -and (Test-Path (Join-Path $desk 'MAJIN.lnk'))) { Ok "desktop icon: $desk\MAJIN.lnk" } else { Note 'no MAJIN.lnk on the Desktop' }
$sm = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\MAJIN'
if (Test-Path (Join-Path $sm 'MAJIN.lnk')) { Ok 'Start-menu entry present' } else { Note "no Start-menu entry in $sm" }
# -Port has to mean something: the app reads its port from config, so write it before the first start.
$null = Run (Join-Path $appDir $exeName) @('config', 'set', 'server.port', $Port) "the installed app must accept -Port"
# A server left over from an earlier run would answer everything below and make a broken install look green.
try {
  $stale = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 3
  Fail "port $Port is already serving (name=$($stale.name), version=$($stale.version)) -- run 'majin stop' first, or pass another -Port"
  exit 1
} catch { Ok "port $Port is free" }
$ver = Run (Join-Path $appDir $exeName) @('version') 'the installed exe must run'
if ($null -eq $ver) { exit 1 }
Ok "installed version: $ver"

# ------------------------------------------------------------------ 6. verify it
Step 'start the installed program and talk to it'
$env:MAJIN_WORKSPACE = Join-Path $env:LOCALAPPDATA 'MAJIN-setup-verify-ws'
$appOut = Join-Path (Get-Location) 'majin-app-out.log'
$appErr = Join-Path (Get-Location) 'majin-app-err.log'
Remove-Item $appOut, $appErr -Force -ErrorAction SilentlyContinue
$appProc = Start-Process -FilePath (Join-Path $appDir $exeName) -ArgumentList 'start', '--no-window' -RedirectStandardOutput $appOut -RedirectStandardError $appErr -PassThru
$state = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 2
  try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 4
    if ($h.ok) { $state = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/state?tools=0" -TimeoutSec 8; break }
  } catch { }
}
if (-not $state) {
  Fail "the installed program never answered on :$Port within 80s"
  if ($appProc.HasExited) { Write-Host ("  app process exited early, exit code: " + $appProc.ExitCode) }
  Write-Host '--- majin-app-out.log (tail) ---'
  Get-Content $appOut -Tail 30 -ErrorAction SilentlyContinue
  Write-Host '--- majin-app-err.log (tail) ---'
  Get-Content $appErr -Tail 30 -ErrorAction SilentlyContinue
} else {
  $installState.served = $true
  Ok "state: version=$($state.version) up=$($state.up)s needsSetup=$($state.needsSetup) presets=$($state.presets.Count) tools=$($state.tools.count)"
  if (-not $state.version) { Fail '/api/state came back without a version' }
  try {
    $html = (Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing).Content
    if ($html -notmatch 'id="composer"') { Fail 'the served page is not the MAJIN window (no #composer chat input)' }
    elseif ($html -notmatch 'c-update') { Fail 'the served window is missing the update chip' }
    else { Ok "window served: $($html.Length) bytes, header chips present" }
    $logo = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/logo.png" -UseBasicParsing
    if ($logo.RawContentLength -lt 5000) { Fail "the M in the window is $($logo.RawContentLength) bytes -- too small to be the icon" }
    else { Ok "logo: $($logo.RawContentLength) bytes" }
  } catch { Fail "fetching the window failed: $($_.Exception.Message)" }
}

Step 'restart keeps the config'
$cfgFile = Join-Path $env:MAJIN_HOME 'config.json'
$marker = 'verify-' + (Get-Date -Format 'HHmmss')
$null = Run (Join-Path $appDir $exeName) @('config', 'set', 'name', $marker) 'config set'
if (Test-Path $cfgFile) { Ok "config.json written ($((Get-Content $cfgFile -Raw).Length) bytes)" } else { Fail 'config.json is missing after a write' }
$null = Run (Join-Path $appDir $exeName) @('stop') 'majin stop'
Start-Sleep -Seconds 3
try {
  $again = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 3
  Fail 'the program still answers after stop -- it should have exited'
} catch { Ok 'stopped cleanly (port closed)' }
$back = $null
if (Test-Path $cfgFile) { $back = (Get-Content $cfgFile -Raw | ConvertFrom-Json).name }
if ($back -ne $marker) { Fail "config did not survive the restart (name=$back, wanted $marker)" } else { Ok "config survived: name=$back" }

# --------------------------------------------------------------- 7. uninstall test
Step 'uninstall must remove the program and keep the data'
if ($NoUninstallTest) {
  Note 'skipped (-NoUninstallTest)'
  $installState.dataKept = $true
} else {
  $hadIcon = [bool]($desk -and (Test-Path (Join-Path $desk 'MAJIN.lnk')))
  $unins = Join-Path $appDir 'unins000.exe'
  if (-not (Test-Path $unins)) {
    Fail 'no unins000.exe -- Add/Remove programs cannot remove this install'
  } else {
    Start-Process -FilePath $unins -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait
    Start-Sleep -Seconds 3
    if (Test-Path (Join-Path $appDir $exeName)) { Fail 'uninstall left the program in place' } else { Ok 'program files removed' }
    if (-not (Test-Path $cfgFile)) { Fail 'uninstall DELETED the user config -- config, keys and memory must survive' }
    else {
      $kept = (Get-Content $cfgFile -Raw | ConvertFrom-Json).name
      if ($kept -ne $marker) { Fail "config survived but lost its content (name=$kept)" } else { Ok "user data kept: name=$kept" }
      $installState.dataKept = $true
    }
    if ($hadIcon) {
      if (Test-Path (Join-Path $desk 'MAJIN.lnk')) { Fail 'uninstall left the Desktop icon behind -- an app the user cannot remove cleanly is not done' }
      else { $installState.iconGone = $true; Ok 'Desktop icon removed with the program' }
    }
    if (-not $LeaveUninstalled) {
      Tell 'reinstalling so you are left with a working MAJIN'
      Start-Process -FilePath $setupExe -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/TASKS=desktopicon' -Wait
      if (Test-Path (Join-Path $appDir $exeName)) { Ok 'reinstalled: MAJIN is on this machine, Desktop icon included' } else { Fail 'the reinstall did not put the program back' }
    }
  }
}

}

# ------------------------------------------------------------------- 8. report
Step 'result'
foreach ($f in @($setupExe, $appExe)) {
  if (Test-Path $f) {
    $h = (Get-FileHash -Algorithm SHA256 -Path $f).Hash.ToLower()
    $b = [math]::Round((Get-Item $f).Length / 1MB, 1)
    Ok "$f -- $b MB"
    Write-Host "          sha256 $h"
    Log "sha256 $h $f"
  } else { Note "not built: $f" }
}
Write-Host ''
Write-Host ("  installed    : " + $installState.installed)
Write-Host ("  window served: " + $installState.served)
Write-Host ("  data kept    : " + $installState.dataKept)
Write-Host ("  icon removed : " + $installState.iconGone)
Write-Host ("  log          : " + $log)
if ($fails -eq 0) {
  Write-Host "`n  MAJIN-Setup.exe is verified on this machine.`n" -ForegroundColor Green
  if ($Ci) {
    Write-Host '  CI smoke test only: a pull request does not publish a GitHub release.'
  } else {
    $appVersion = [string]((Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version)
    Write-Host '  To publish a new version, first bump the app version and merge to main.'
    Write-Host '  Then run this command from a clean checkout of main:'
    Write-Host "    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\publish.ps1 -Version $appVersion -Branch main"
    Write-Host "  Only after CI succeeds: https://github.com/rssen-debug/MAJINCLI/releases/tag/v$appVersion"
  }
  Write-Host ''
  exit 0
}
Write-Host "`n  $fails check(s) failed -- paste the block above (or $log) back to the agent.`n" -ForegroundColor Red
exit 1
