<#
  MAJIN — installation on Windows.
  Needs no admin rights, no build toolchain, no npm churn for the core.

    powershell -ExecutionPolicy Bypass -File .\install.ps1              # install (PATH + shortcuts + start menu)
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -WhatsApp   # + Baileys for a personal WhatsApp number
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Dataset    # + let MAJIN keep redacted logs of your turns (opt-in, local only)
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -NoPath     # do not touch PATH
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall  # pilla bort det igen
#>
[CmdletBinding()]
param(
  [switch]$WhatsApp,
  [switch]$Dataset,
  [switch]$NoPath,
  [switch]$NoTask,
  [switch]$Uninstall,
  [switch]$Legacy,
  [string]$Home = "$env:LOCALAPPDATA\MAJIN"
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$Bin = Join-Path $Home 'bin'

# V4 packages must never install the old V1 server by accident.
if (-not $Legacy) {
  if ($WhatsApp -or $Dataset) { throw 'These V1 installer switches require -Legacy. V4 channel/dataset setup must use its own authenticated configuration.' }
  $env:MAJIN_HOME = $Home
  & (Join-Path $Repo 'scripts\v4\install-v4-windows.ps1') -AutoStart:(-not $NoTask) -Uninstall:$Uninstall
  if (-not $?) { exit 1 }
  if (-not $Uninstall) {
    New-Item -ItemType Directory -Force -Path $Bin | Out-Null
    $entry = Join-Path $Repo 'bin\majin.mjs'
    foreach ($launcher in @(@{ Name = 'majin.cmd'; Command = '' }, @{ Name = 'majin-start.cmd'; Command = 'start' }, @{ Name = 'majin-serve.cmd'; Command = 'serve' })) {
      $launcherPath = Join-Path $Bin $launcher.Name
      if ((Test-Path -LiteralPath $launcherPath) -and -not (Test-Path -LiteralPath "$launcherPath.pre-v4")) {
        Copy-Item -LiteralPath $launcherPath -Destination "$launcherPath.pre-v4"
      }
      $launchCommand = $launcher.Command
      @"
@echo off
if "%MAJIN_HOME%"=="" set "MAJIN_HOME=$Home"
node "$entry" $launchCommand %*
"@ | Set-Content -LiteralPath $launcherPath -Encoding ASCII
    }
    if (-not $NoPath) {
      $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
      if ($Bin -notin ($userPath -split ';')) { [Environment]::SetEnvironmentVariable('Path', "$Bin;$userPath", 'User') }
    }
    Write-Host 'V4 host installed. Install the V4 desktop package to use majin start/window; majin serve runs the shared host.'
  }
  exit 0
}

function Write-Step([string]$m) { Write-Host "  · $m" -ForegroundColor DarkGray }
function Write-Ok([string]$m) { Write-Host "✔ $m" -ForegroundColor Green }
function Write-Bad([string]$m) { Write-Host "✖ $m" -ForegroundColor Red }

if ($Uninstall) {
  Write-Host "removing MAJIN (data in $Home is left alone)" -ForegroundColor Cyan
  Get-ScheduledTask -TaskName 'MAJIN' -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false
  Write-Step 'login task removed'
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -and $userPath -like "*$Bin*") {
    $new = ($userPath -split ';' | Where-Object { $_ -ne $Bin }) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $new, 'User')
    Write-Step "PATH: $Bin removed"
  }
  foreach ($s in @("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\MAJIN", "$env:USERPROFILE\Desktop\MAJIN.lnk")) {
    if (Test-Path $s) { Remove-Item $s -Recurse -Force; Write-Step "removed $s" }
  }
  Write-Ok 'MAJIN uninstalled. Config/keys remain in' $Home
  exit 0
}

Write-Host "Installing MAJIN from $Repo" -ForegroundColor Cyan
Write-Host "data + config: $Home`n" -ForegroundColor DarkCyan

# --- 1. Node ---------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Bad 'Node was not found in PATH.'
  Write-Host '  Install the LTS (>= 22): winget install OpenJS.NodeJS.LTS' -ForegroundColor Yellow
  Write-Host '  Restart PowerShell and run install.ps1 again.' -ForegroundColor Yellow
  exit 1
}
$ver = (& node -v) -replace '^v', ''
$parts = $ver.Split('.')
$okNode = [int]$parts[0] -ge 22
if (-not $okNode) {
  Write-Bad "Node $ver is too old — MAJIN requires Node.js 22 or later."
  exit 1
}
Write-Ok "Node $ver ($($node.Source))"

# --- 2. Datakataloger ------------------------------------------------------
foreach ($d in @('', 'workspace', 'memory', 'sessions', 'skills', 'rules', 'logs', 'out', 'uploads', 'cache', 'creds', 'bin')) {
  $p = Join-Path $Home $d
  if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
}
Write-Step "data directories ready in $Home"

# --- 3. start-skript + PATH -------------------------------------------------
if (-not $NoPath) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -notlike "*$Bin*") {
    [Environment]::SetEnvironmentVariable('Path', "$Bin;$userPath", 'User')
    Write-Step "PATH (user): prepended $Bin"
  } else { Write-Step 'PATH: already installed' }
}
$cmd = @"
@echo off
rem MAJIN — start the agent (server + window)
setlocal
if "%MAJIN_HOME%"=="" set "MAJIN_HOME=$Home"
where node >nul 2>nul || (echo Node is missing - install Node LTS 22+ from nodejs.org & exit /b 1)
pushd "$Repo"
node "src\cli\majin.js" start %*
popd
"@
Set-Content -Path (Join-Path $Bin 'majin-start.cmd') -Value $cmd -Encoding ASCII
$shellRc = @"
@echo off
setlocal
if "%MAJIN_HOME%"=="" set "MAJIN_HOME=$Home"
pushd "$Repo"
node "src\cli\majin.js" start --no-window %*
popd
"@
Set-Content -Path (Join-Path $Bin 'majin-serve.cmd') -Value $shellRc -Encoding ASCII
$wrapper = @"
@echo off
setlocal
if "%MAJIN_HOME%"=="" set "MAJIN_HOME=$Home"
pushd "$Repo"
node "src\cli\majin.js" %*
popd
"@
Set-Content -Path (Join-Path $Bin 'majin.cmd') -Value $wrapper -Encoding ASCII
Write-Ok 'majin.cmd / majin-start.cmd / majin-serve.cmd written to' $Bin

# --- 4. Icon + shortcuts ----------------------------------------------------
if (Test-Path (Join-Path $Repo 'assets\majin.ico')) {
  Copy-Item (Join-Path $Repo 'assets\majin.ico') (Join-Path $Home 'majin.ico') -Force
  Write-Ok 'MAJIN icon installed'
}
$startMenu = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\MAJIN"
if (-not (Test-Path $startMenu)) { New-Item -ItemType Directory -Path $startMenu -Force | Out-Null }
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path $startMenu 'MAJIN.lnk'))
$lnk.TargetPath = Join-Path $Bin 'majin-start.cmd'
$lnk.WorkingDirectory = $Repo
$lnk.Description = 'Starts the MAJIN agent and opens the window'
$lnk.IconLocation = (Join-Path $Home 'majin.ico') + ',0'
$lnk.Save()
$desk = $ws.CreateShortcut("$env:USERPROFILE\Desktop\MAJIN.lnk")
$desk.TargetPath = Join-Path $Bin 'majin-start.cmd'
$desk.WorkingDirectory = $Repo
$desk.Description = 'MAJIN — the agent on your own machine'
$desk.IconLocation = (Join-Path $Home 'majin.ico') + ',0'
$desk.Save()
Write-Ok 'desktop shortcut + start menu entry'

# --- 5. Autostart (optional) ------------------------------------------------
if (-not $NoTask) {
  try {
    $action = New-ScheduledTaskAction -Execute (Join-Path $Bin 'majin-serve.cmd')
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName 'MAJIN' -Action $action -Trigger $trigger -Settings $settings -Description 'Starts the MAJIN agent in the background' -Force | Out-Null
    Write-Ok 'MAJIN starts at logon (Task Scheduler)'
  } catch {
    Write-Step "skipping autostart: $($_.Exception.Message)"
  }
} else { Write-Step 'autostart skipped (-NoTask)' }

# --- 6. Optional dependencies -----------------------------------------------
if ($WhatsApp) {
  Write-Host "`ninstalling WhatsApp support (Baileys) …" -ForegroundColor Cyan
  Push-Location $Repo
  try {
    & npm install --no-audit --no-fund @whiskeysockets/baileys@7.0.0-rc14 qrcode@1.5.4
    if ($LASTEXITCODE -eq 0) { Write-Ok 'Baileys installed — run: majin pair whatsapp' }
    else { Write-Bad 'npm install failed — the WhatsApp cloud transport still works (no dependency)' }
  } catch {
    Write-Bad "npm error: $($_.Exception.Message)"
  }
  Pop-Location
}

# --- 6.5 Learning from your own runs (opt-in) --------------------------------
if ($Dataset) {
  Write-Host "`nenabling the local dataset …" -ForegroundColor Cyan
  Push-Location $Repo
  $env:MAJIN_HOME = $Home
  try {
    & node 'src\cli\majin.js' config set dataset.capture true | Out-Host
    if ($LASTEXITCODE -eq 0) { Write-Ok 'dataset on — redacted turns in the data folder, nothing ever leaves this machine' }
    else { Write-Bad 'could not set dataset.capture — run: majin config set dataset.capture true' }
  } catch { Write-Bad "dataset: $($_.Exception.Message)" }
  Pop-Location
} else {
  Write-Step 'dataset left off (it is opt-in: install.ps1 -Dataset, or "majin dataset on")'
}

# --- 7. Verify --------------------------------------------------------------
Write-Host "`nverifying …" -ForegroundColor Cyan
Push-Location $Repo
$env:MAJIN_HOME = $Home
& node 'src\cli\majin.js' doctor
$doctorExit = $LASTEXITCODE
Write-Host ''
& node 'src\cli\majin.js' url
Pop-Location
Write-Host ''
if ($doctorExit -ne 0) { Write-Host 'doctor reported issues — fix the lines above (an API key is the usual one).' -ForegroundColor Yellow }
Write-Host 'DONE. Open a new terminal and run:  majin' -ForegroundColor Green
Write-Host '   (or double-click MAJIN on the desktop. Ctrl+C stops it.)' -ForegroundColor DarkGray
