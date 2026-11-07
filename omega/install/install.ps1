<#
  STUDDY BUDDY OMEGA — one-command installation on Windows.

    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Verify      # report only, change nothing
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Migrate     # + import legacy memory (verified backup first)
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Rollback    # undo the last install's changes
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall   # remove the install, KEEP your data

  What this does, in one command: finds a supported Python (it does not demand one
  specific version — the previous installer hard-required 3.12 and failed on
  machines with a perfectly good 3.11 or 3.13), builds an isolated venv, installs
  dependencies, detects Node for the MAJIN V6 subsystem, writes a `buddy`
  launcher, puts it on PATH, optionally enables autostart, scans for legacy memory
  and runs the diagnostics. No admin rights and no manual multi-command setup.

  Your data is never destroyed. An upgrade keeps %APPDATA%\StuddyBuddy exactly as
  it is; only the disposable venv and the launcher are rewritten, and the previous
  launcher is backed up so -Rollback can restore it.

  Nothing here is a user-specific path: every location is derived from the
  environment or from where this script lives.
#>
[CmdletBinding()]
param(
  [switch]$Verify,        # read-only: report whether the install is healthy
  [switch]$Uninstall,     # remove launcher/PATH/venv/autostart, keep data
  [switch]$Rollback,      # restore what the previous install replaced
  [switch]$Migrate,       # import legacy memory (scan always runs; this writes)
  [switch]$NoPath,        # do not touch the user PATH
  [switch]$NoAutoStart,   # do not register a log-in start
  [switch]$NoVoice,       # skip the heavy speech packages (voice stays off)
  [switch]$NoNode,        # skip Node/MAJIN setup
  [switch]$SkipDeps,      # do not pip install anything
  [switch]$NoWinget,      # never offer to install Python via winget
  [string]$Python = '',   # use this interpreter instead of discovering one
  [string]$DataHome = ''  # data directory (default %APPDATA%\StuddyBuddy)
)

$ErrorActionPreference = 'Stop'

# ── locations, all derived — never a hardcoded user path ──────────────────────
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$Omega    = Split-Path -Parent $ScriptDir
$Repo     = Split-Path -Parent $Omega
$Entry    = Join-Path $Omega 'buddy.py'
if (-not $DataHome) {
  $AppData = $env:APPDATA
  if (-not $AppData) { $AppData = Join-Path $env:USERPROFILE 'AppData\Roaming' }
  $DataHome = Join-Path $AppData 'StuddyBuddy'
}
$Venv      = Join-Path $DataHome 'venv'
$VenvPy    = Join-Path $Venv 'Scripts\python.exe'
$BinDir    = Join-Path $DataHome 'bin'
$Launcher  = Join-Path $BinDir 'buddy.cmd'
$LauncherPs= Join-Path $BinDir 'buddy.ps1'
$Manifest  = Join-Path $DataHome 'install-manifest.json'
$LogDir    = Join-Path $DataHome 'logs'
$MajinRoot = Join-Path $Repo 'integrations\majin-original'

$Script:Problems = New-Object System.Collections.Generic.List[string]
$Script:Notes    = New-Object System.Collections.Generic.List[string]

function Write-Step([string]$m) { Write-Host "  . $m" -ForegroundColor DarkGray }
function Write-Ok([string]$m)   { Write-Host "  + $m" -ForegroundColor Green }
function Write-Warn([string]$m) { Write-Host "  ! $m" -ForegroundColor Yellow }
function Write-Bad([string]$m)  { Write-Host "  x $m" -ForegroundColor Red }
function Add-Problem([string]$m) { $Script:Problems.Add($m); Write-Bad $m }
function Add-Note([string]$m)    { $Script:Notes.Add($m) }

function Stop-Install([string]$m) {
  Write-Host ''
  Write-Bad $m
  Write-Host "  Diagnostics: run 'buddy doctor' once the install succeeds, or re-run with -Verify." -ForegroundColor DarkGray
  exit 1
}

# ── Python discovery ──────────────────────────────────────────────────────────
# The supported range is owned by the product, not by this script: `buddy deps
# --json` publishes the minimum, the recommendation and the tested ceiling, so
# installer and runtime can never disagree. Until an interpreter exists we use
# these fallbacks, which are the same numbers buddy.py enforces at import.
$FallbackMin = @(3, 10)
$FallbackMax = @(3, 13)

function Get-PythonVersion([string]$exe) {
  if (-not $exe) { return $null }
  if (-not (Test-Path -LiteralPath $exe)) { return $null }
  # The Microsoft Store alias prints nothing and opens the Store instead.
  if ($exe -like '*WindowsApps*') { return $null }
  try {
    $raw = & $exe -c "import sys;print('%d.%d.%d' % sys.version_info[:3])" 2>$null
  } catch { return $null }
  if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
  $line = ($raw | Select-Object -First 1)
  if ("$line" -notmatch '^(\d+)\.(\d+)\.(\d+)') { return $null }
  return @{ Major = [int]$Matches[1]; Minor = [int]$Matches[2]; Patch = [int]$Matches[3]; Text = "$line"; Exe = $exe }
}

function Get-PythonCandidates {
  $out = New-Object System.Collections.Generic.List[string]
  if ($Python) { $out.Add($Python) }

  # 1. the `py` launcher: the most reliable path on Windows, newest first
  $py = Get-Command py -ErrorAction SilentlyContinue
  if ($py) {
    foreach ($flag in @('-3.13', '-3.12', '-3.11', '-3.10')) {
      try { $found = & py $flag -c "import sys;print(sys.executable)" 2>$null } catch { $found = $null }
      if ($LASTEXITCODE -eq 0 -and $found) { $out.Add((($found | Select-Object -First 1)).Trim()) }
    }
  }

  # 2. whatever is on PATH
  foreach ($name in @('python', 'python3')) {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if ($c -and $c.Source) { $out.Add($c.Source) }
  }

  # 3. the standard per-user and machine-wide install roots
  $roots = @()
  if ($env:LOCALAPPDATA) { $roots += (Join-Path $env:LOCALAPPDATA 'Programs\Python') }
  if ($env:ProgramFiles) { $roots += $env:ProgramFiles }
  $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  if ($pf86) { $roots += $pf86 }
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    foreach ($dir in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
      if ($dir.Name -notmatch '^Python3\d+$' -and $dir.Name -notmatch '^Python 3') { continue }
      $cand = Join-Path $dir.FullName 'python.exe'
      if (Test-Path -LiteralPath $cand) { $out.Add($cand) }
    }
  }

  # de-duplicate, preserving order
  $seen = @{}
  $uniq = New-Object System.Collections.Generic.List[string]
  foreach ($c in $out) {
    if (-not $c) { continue }
    $full = $c
    try { $full = (Resolve-Path -LiteralPath $c).Path } catch { }
    $key = "$full".ToLowerInvariant()
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    $uniq.Add($full)
  }
  return $uniq
}

function Find-SupportedPython {
  $best = $null
  foreach ($cand in (Get-PythonCandidates)) {
    $v = Get-PythonVersion $cand
    if (-not $v) { continue }
    $tooOld = ($v.Major -lt $FallbackMin[0]) -or ($v.Major -eq $FallbackMin[0] -and $v.Minor -lt $FallbackMin[1])
    $tooNew = ($v.Major -gt $FallbackMax[0]) -or ($v.Major -eq $FallbackMax[0] -and $v.Minor -gt $FallbackMax[1])
    if ($tooOld) { Write-Step "skipping $($v.Text) at $cand (older than the $($FallbackMin[0]).$($FallbackMin[1]) minimum)"; continue }
    if ($tooNew) { Write-Warn "$($v.Text) at $cand is newer than the tested ceiling $($FallbackMax[0]).$($FallbackMax[1]); it may work but it is not proven" }
    # prefer the newest supported interpreter we have seen
    if (-not $best) { $best = $v; continue }
    if ($v.Major -gt $best.Major -or ($v.Major -eq $best.Major -and $v.Minor -gt $best.Minor)) { $best = $v }
  }
  return $best
}

function Invoke-Buddy {
  param([string]$PyExe, [string[]]$BuddyArgs, [int]$TimeoutSec = 900)
  $env:BUDDY_HOME = $DataHome
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $PyExe $Entry @BuddyArgs 2>&1
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
  return @{ ExitCode = $code; Output = ($output -join "`n") }
}

# ── -Verify: read-only health report ──────────────────────────────────────────
function Invoke-Verify {
  Write-Host ''
  Write-Host 'STUDDY BUDDY OMEGA - install verification' -ForegroundColor Cyan
  Write-Host "  data home : $DataHome" -ForegroundColor DarkCyan
  Write-Host "  entrypoint: $Entry" -ForegroundColor DarkCyan
  Write-Host ''

  if (-not (Test-Path -LiteralPath $Entry)) { Add-Problem "entrypoint missing: $Entry" }
  else { Write-Ok 'entrypoint present' }

  $found = Find-SupportedPython
  if (-not $found) { Add-Problem "no supported Python found (need $($FallbackMin[0]).$($FallbackMin[1]) to $($FallbackMax[0]).$($FallbackMax[1]))" }
  else { Write-Ok "system Python $($found.Text) at $($found.Exe)" }

  if (Test-Path -LiteralPath $VenvPy) {
    $vv = Get-PythonVersion $VenvPy
    if ($vv) { Write-Ok "venv Python $($vv.Text) at $VenvPy" } else { Add-Problem "venv exists but its interpreter does not run: $VenvPy" }
  } else { Add-Problem "no venv at $Venv" }

  if (Test-Path -LiteralPath $Launcher) { Write-Ok "launcher present: $Launcher" } else { Add-Problem "launcher missing: $Launcher" }

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($NoPath) { Write-Step 'PATH check skipped (-NoPath)' }
  elseif ($userPath -and ($userPath -split ';' | Where-Object { $_ -eq $BinDir })) { Write-Ok "PATH contains $BinDir" }
  else { Add-Problem "PATH does not contain $BinDir (open a new terminal, or re-run without -NoPath)" }

  # the real check: does the installed product actually answer?
  $probePy = $VenvPy
  if (-not (Test-Path -LiteralPath $probePy)) { $probePy = '' }
  if (-not $probePy -and $found) { $probePy = $found.Exe }
  if ($probePy) {
    $ver = Invoke-Buddy $probePy @('version') 60
    if ($ver.ExitCode -eq 0 -and $ver.Output -match 'Omega') { Write-Ok "product responds: $($ver.Output.Trim())" }
    else { Add-Problem "'buddy version' failed (exit $($ver.ExitCode)): $($ver.Output)" }

    $deps = Invoke-Buddy $probePy @('deps') 120
    if ($deps.ExitCode -eq 0) { Write-Ok 'all required dependencies import' }
    else { Add-Problem "required dependencies are missing:`n$($deps.Output)" }

    $doc = Invoke-Buddy $probePy @('doctor', 'runtime') 300
    if ($doc.ExitCode -eq 0) { Write-Ok 'buddy doctor runtime is clean' }
    else { Add-Problem "buddy doctor runtime reported problems (exit $($doc.ExitCode)):`n$($doc.Output)" }
  }

  if (Test-Path -LiteralPath (Join-Path $DataHome 'buddy.db')) { Write-Ok 'existing data preserved (buddy.db present)' }
  else { Write-Step 'no database yet - it is created on first run' }

  Write-Host ''
  foreach ($n in $Script:Notes) { Write-Step $n }
  if ($Script:Problems.Count -gt 0) {
    Write-Bad "verification FAILED: $($Script:Problems.Count) problem(s)"
    Write-Host '  Re-run without -Verify to repair, or `buddy doctor` for detail.' -ForegroundColor DarkGray
    return 1
  }
  Write-Ok 'verification passed'
  return 0
}

# ── uninstall: remove the install, never the data ─────────────────────────────
function Invoke-Uninstall {
  Write-Host ''
  Write-Host 'Removing Studdy Buddy Omega' -ForegroundColor Cyan
  Write-Host "  Your data in $DataHome is KEPT." -ForegroundColor DarkCyan
  Write-Host ''
  try { Invoke-Buddy $VenvPy @('autostart', 'off') 60 | Out-Null } catch { }
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -and ($userPath -split ';' | Where-Object { $_ -eq $BinDir })) {
    $newPath = ($userPath -split ';' | Where-Object { $_ -ne $BinDir }) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Step "PATH: removed $BinDir"
  }
  foreach ($f in @($Launcher, $LauncherPs)) {
    if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force; Write-Step "removed $f" }
  }
  if (Test-Path -LiteralPath $Venv) { Remove-Item -LiteralPath $Venv -Recurse -Force; Write-Step 'removed the venv' }
  Write-Ok "uninstalled. Data, memory and backups remain in $DataHome"
  return 0
}

# ── rollback ──────────────────────────────────────────────────────────────────
function Invoke-Rollback {
  Write-Host ''
  Write-Host 'Rolling back the last install' -ForegroundColor Cyan
  if (-not (Test-Path -LiteralPath $Manifest)) { Stop-Install "no install manifest at $Manifest - nothing to roll back to" }
  $man = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
  if ($man.previousPath) {
    [Environment]::SetEnvironmentVariable('Path', $man.previousPath, 'User')
    Write-Ok "PATH restored to its previous value"
  } else { Write-Step 'PATH had no previous value recorded; left alone' }
  foreach ($b in (Get-ChildItem -LiteralPath $BinDir -Filter '*.pre-install' -ErrorAction SilentlyContinue)) {
    $target = $b.FullName -replace '\.pre-install$', ''
    Copy-Item -LiteralPath $b.FullName -Destination $target -Force
    Write-Ok "restored $target"
  }
  if ($man.autostartWasOn -eq $false) {
    try { Invoke-Buddy $VenvPy @('autostart', 'off') 60 | Out-Null; Write-Ok 'autostart turned back off' } catch { }
  }
  Write-Ok "rollback complete. Data in $DataHome was never touched."
  return 0
}

# ── install ───────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host 'STUDDY BUDDY OMEGA - install' -ForegroundColor Cyan
Write-Host "  repository : $Repo" -ForegroundColor DarkCyan
Write-Host "  data home  : $DataHome  (preserved across upgrades)" -ForegroundColor DarkCyan
Write-Host ''

if ($Verify)    { exit (Invoke-Verify) }
if ($Uninstall) { exit (Invoke-Uninstall) }
if ($Rollback)  { exit (Invoke-Rollback) }

if (-not (Test-Path -LiteralPath $Entry)) { Stop-Install "entrypoint not found: $Entry - run this script from inside the repository checkout" }

# 1. record what we are about to replace, so -Rollback is real
$previousPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$autostartWasOn = $false
New-Item -ItemType Directory -Force -Path $DataHome | Out-Null
New-Item -ItemType Directory -Force -Path $BinDir   | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir   | Out-Null
foreach ($f in @($Launcher, $LauncherPs)) {
  if (Test-Path -LiteralPath $f) {
    Copy-Item -LiteralPath $f -Destination "$f.pre-install" -Force
    Write-Step "backed up the existing $(Split-Path -Leaf $f)"
  }
}

# 2. Python - detect, and only install when genuinely absent
Write-Host 'Python' -ForegroundColor White
$found = Find-SupportedPython
if (-not $found) {
  if (-not $NoWinget) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
      Write-Warn 'no supported Python found; installing 3.12 for the current user via winget'
      $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      & winget install --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements 2>&1 |
        ForEach-Object { Write-Step "$_" }
      $ErrorActionPreference = $prev
      $found = Find-SupportedPython
    }
  }
  if (-not $found) {
    Stop-Install ("no supported Python interpreter was found. Install CPython " +
      "$($FallbackMin[0]).$($FallbackMin[1]) or newer (up to $($FallbackMax[0]).$($FallbackMax[1]) is tested) from " +
      "https://www.python.org/downloads/windows/ and re-run, or pass -Python C:\path\to\python.exe. " +
      "This installer deliberately accepts a RANGE of versions: requiring one specific release is what broke the previous one.")
  }
}
Write-Ok "using Python $($found.Text) at $($found.Exe)"
$SysPy = $found.Exe

# 3. the product publishes its own dependency and interpreter policy - ask it
Write-Host 'Policy' -ForegroundColor White
$policy = $null
try {
  $env:BUDDY_HOME = $DataHome
  $rawPolicy = (& $SysPy $Entry 'deps' '--json' 2>$null) -join ''
  if ($rawPolicy) { $policy = $rawPolicy | ConvertFrom-Json }
} catch { $policy = $null }
if ($policy) {
  $minTxt = "$($policy.python_min[0]).$($policy.python_min[1])"
  $maxTxt = "$($policy.python_max_tested[0]).$($policy.python_max_tested[1])"
  Write-Ok "product policy: minimum $minTxt, tested up to $maxTxt, $($policy.deps.Count) dependencies"
  $FallbackMin = @($policy.python_min[0], $policy.python_min[1])
  $FallbackMax = @($policy.python_max_tested[0], $policy.python_max_tested[1])
  if ($found.Major -lt $FallbackMin[0] -or ($found.Major -eq $FallbackMin[0] -and $found.Minor -lt $FallbackMin[1])) {
    Stop-Install "the product requires Python $minTxt or newer; the interpreter found is $($found.Text)"
  }
} else {
  Write-Warn "could not read the product's own dependency policy; falling back to the installer's defaults"
}

# 4. isolated venv - disposable, so an upgrade can rebuild it without risk
Write-Host 'Virtual environment' -ForegroundColor White
$venvOk = $false
if (Test-Path -LiteralPath $VenvPy) {
  $vv = Get-PythonVersion $VenvPy
  if ($vv) { Write-Ok "reusing the existing venv (Python $($vv.Text))"; $venvOk = $true }
  else { Write-Warn 'the existing venv is broken; rebuilding it' }
}
if (-not $venvOk) {
  if (Test-Path -LiteralPath $Venv) { Remove-Item -LiteralPath $Venv -Recurse -Force }
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & $SysPy -m venv $Venv 2>&1 | ForEach-Object { Write-Step "$_" }
  $ErrorActionPreference = $prev
  if (-not (Test-Path -LiteralPath $VenvPy)) {
    Stop-Install "could not create a venv at $Venv. On Debian/Ubuntu-derived setups this needs the python3-venv package; on Windows, re-run after repairing the Python install (Settings > Apps > Python > Modify)."
  }
  Write-Ok "created an isolated venv at $Venv"
}

# 5. dependencies, from the product's own list
if ($SkipDeps) {
  Write-Host 'Dependencies' -ForegroundColor White
  Write-Step 'skipped (-SkipDeps)'
} else {
  Write-Host 'Dependencies' -ForegroundColor White
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & $VenvPy -m pip install --upgrade pip 2>&1 | Select-Object -Last 2 | ForEach-Object { Write-Step "$_" }

  $required = New-Object System.Collections.Generic.List[string]
  $optional = New-Object System.Collections.Generic.List[string]
  $voiceSet = @('sounddevice', 'numpy', 'faster-whisper')
  if ($policy) {
    foreach ($d in $policy.deps) {
      if ($NoVoice -and ($voiceSet -contains $d.pip)) { Write-Step "skipping $($d.pip) (-NoVoice)"; continue }
      if ($d.required) { $required.Add($d.pip) } else { $optional.Add($d.pip) }
    }
  } else {
    # Only used if the product could not be asked. Keep in sync with buddy.DEPS.
    $required.Add('uiautomation'); $required.Add('pillow')
    foreach ($o in @('websocket-client', 'edge-tts', 'winsdk', 'sounddevice', 'numpy', 'faster-whisper')) { $optional.Add($o) }
    if ($NoVoice) { $optional = New-Object System.Collections.Generic.List[string] }
  }

  if ($required.Count -gt 0) {
    Write-Step "installing required: $($required -join ', ')"
    & $VenvPy -m pip install $required.ToArray() 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Step "$_" }
    if ($LASTEXITCODE -ne 0) {
      $ErrorActionPreference = $prev
      Stop-Install "a required dependency failed to install: $($required -join ', '). Re-run to retry; -SkipDeps installs nothing."
    }
    Write-Ok 'required dependencies installed'
  }
  foreach ($pkg in $optional) {
    Write-Step "installing optional: $pkg"
    & $VenvPy -m pip install $pkg 2>&1 | Select-Object -Last 1 | ForEach-Object { }
    if ($LASTEXITCODE -ne 0) {
      Write-Warn "$pkg did not install - the feature it enables stays off, everything else still works"
      Add-Note "optional dependency not installed: $pkg"
    } else { Write-Ok "$pkg installed" }
  }
  $ErrorActionPreference = $prev
}

# 6. Node, for the MAJIN V6 subsystem - optional, never fatal
Write-Host 'MAJIN V6 subsystem (Node)' -ForegroundColor White
$majinReady = $false
if ($NoNode) {
  Write-Step 'skipped (-NoNode)'
} else {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Write-Warn 'Node.js was not found; MAJIN V6 stays unavailable, Omega keeps its full native capability'
    Add-Note 'MAJIN V6 unavailable: Node.js not found (install Node 20+ and re-run)'
  } elseif (-not (Test-Path -LiteralPath $MajinRoot)) {
    Write-Warn "MAJIN sources not found at $MajinRoot"
    Add-Note "MAJIN V6 unavailable: sources missing at $MajinRoot"
  } else {
    $nodeVer = (& node --version 2>$null) -join ''
    Write-Ok "Node $nodeVer found"
    if (-not (Test-Path -LiteralPath (Join-Path $MajinRoot 'node_modules'))) {
      Write-Step 'installing MAJIN dependencies (this can take a minute)'
      $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      Push-Location $MajinRoot
      & npm install --no-audit --no-fund 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Step "$_" }
      $npmCode = $LASTEXITCODE
      Pop-Location
      $ErrorActionPreference = $prev
      if ($npmCode -ne 0) {
        Write-Warn "npm install failed (exit $npmCode); MAJIN V6 stays unavailable until it succeeds"
        Add-Note "MAJIN V6 unavailable: npm install exited $npmCode"
      } else { $majinReady = $true; Write-Ok 'MAJIN dependencies installed' }
    } else { $majinReady = $true; Write-Ok 'MAJIN dependencies already present' }
  }
}

# 7. the `buddy` launcher
Write-Host 'Launcher' -ForegroundColor White
$cmdBody = @"
@echo off
rem Studdy Buddy Omega launcher - generated by install.ps1, do not edit by hand.
if "%BUDDY_HOME%"=="" set "BUDDY_HOME=$DataHome"
"$VenvPy" "$Entry" %*
"@
Set-Content -LiteralPath $Launcher -Value $cmdBody -Encoding ASCII
$psBody = @"
# Studdy Buddy Omega launcher - generated by install.ps1, do not edit by hand.
if (-not `$env:BUDDY_HOME) { `$env:BUDDY_HOME = '$DataHome' }
& '$VenvPy' '$Entry' @args
exit `$LASTEXITCODE
"@
Set-Content -LiteralPath $LauncherPs -Value $psBody -Encoding UTF8
Write-Ok "wrote $Launcher and $LauncherPs"

if ($NoPath) {
  Write-Step 'PATH left alone (-NoPath)'
  Add-Note "PATH not modified; call the launcher directly: $Launcher"
} else {
  $userPathNow = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPathNow -and ($userPathNow -split ';' | Where-Object { $_ -eq $BinDir })) {
    Write-Ok "PATH already contains $BinDir"
  } else {
    $joined = if ($userPathNow) { "$BinDir;$userPathNow" } else { $BinDir }
    [Environment]::SetEnvironmentVariable('Path', $joined, 'User')
    Write-Ok "added $BinDir to the user PATH (open a new terminal for it to take effect)"
  }
}

# 8. autostart, delegated to the product so there is one implementation
Write-Host 'Autostart' -ForegroundColor White
try {
  $as = Invoke-Buddy $VenvPy @('autostart', 'status') 60
  if ($as.Output -match 'ON') { $autostartWasOn = $true }
} catch { $autostartWasOn = $false }
if ($NoAutoStart) {
  Write-Step 'not enabled (-NoAutoStart)'
} else {
  $as2 = Invoke-Buddy $VenvPy @('autostart', 'on') 60
  if ($as2.ExitCode -eq 0) { Write-Ok 'Buddy will start minimised at log-in (buddy autostart off to undo)' }
  else { Write-Warn "autostart could not be enabled: $($as2.Output)"; Add-Note 'autostart not enabled' }
}

# 9. legacy memory - always scan (read-only), only import when asked
Write-Host 'Legacy memory' -ForegroundColor White
$scan = Invoke-Buddy $VenvPy @('migrate', 'scan') 600
Write-Host $scan.Output
if ($Migrate) {
  Write-Warn 'importing legacy memory; a verified backup is taken first and originals are never modified'
  $mig = Invoke-Buddy $VenvPy @('migrate', 'run', '--yes') 1800
  Write-Host $mig.Output
  if ($mig.ExitCode -ne 0) {
    Add-Problem "migration reported problems (exit $($mig.ExitCode)); nothing was destroyed - use 'buddy migrate rollback' to undo"
  } else { Write-Ok 'migration complete' }
} else {
  Write-Step 'scan only - nothing was imported. Run with -Migrate, or `buddy migrate run --yes`, after reading the plan.'
}

# 10. Kilo Code credentials - never written to a file in plaintext by us
Write-Host 'Model gateway' -ForegroundColor White
if ($env:KILO_API_KEY) {
  Write-Ok 'KILO_API_KEY is present in the environment; Omega stores it securely on first run'
} else {
  Write-Step 'no Kilo key found. Run `buddy` once and paste your key when asked - it is stored with DPAPI, never in plaintext.'
  Add-Note 'Kilo key not configured yet: run `buddy` and paste it, or set KILO_API_KEY'
}

# 11. manifest, so an upgrade or a rollback knows what it replaced
$appVersion = 'unknown'
if ($policy -and $policy.app_version) { $appVersion = "$($policy.app_version)" }
$manifestObj = [ordered]@{
  schema          = 'studdybuddy.omega.install-manifest/v1'
  installedAt     = (Get-Date).ToUniversalTime().ToString('o')
  appVersion      = $appVersion
  systemPython    = $SysPy
  pythonVersion   = $found.Text
  venv            = $Venv
  binDir          = $BinDir
  launcher        = $Launcher
  dataHome        = $DataHome
  previousPath    = $previousPath
  autostartWasOn  = $autostartWasOn
  majinReady      = $majinReady
  pathModified    = (-not $NoPath)
  notes           = @($Script:Notes)
}
$manifestObj | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Manifest -Encoding UTF8
Write-Ok "install manifest written to $Manifest"

# 12. prove it works before declaring success
Write-Host 'Verification' -ForegroundColor White
$exitCode = Invoke-Verify
if ($exitCode -ne 0) {
  Write-Host ''
  Write-Bad 'the install completed but verification found problems - they are listed above and are not hidden.'
  Write-Host "  Undo with: powershell -NoProfile -ExecutionPolicy Bypass -File `"$ScriptDir\install.ps1`" -Rollback" -ForegroundColor DarkGray
  exit 1
}

Write-Host ''
Write-Host 'Done. Open a NEW terminal and type:  buddy' -ForegroundColor Green
Write-Host "  buddy doctor    real diagnostics" -ForegroundColor DarkGray
Write-Host "  buddy status    operational state" -ForegroundColor DarkGray
Write-Host "  buddy accept    the 20 end-to-end acceptance scenarios" -ForegroundColor DarkGray
Write-Host "  buddy stop      stop active work safely" -ForegroundColor DarkGray
exit 0
