# MAJIN V4 — Windows host installer.
#
# What this does:
#   1. verifies Node >= 22
#   2. installs the repo's npm dependencies if they are missing
#   3. writes a launcher (start-majin-v4.cmd) that runs the V4 host in this repo
#   4. optionally registers a per-user Scheduled Task at logon
#
# What this does NOT do:
#   - no machine-wide changes, no service account, no firewall rule
#   - no silent configuration of providers or keys
#   - no tunnel, no port forwarding, no RDP
#
# Usage (PowerShell, normal user):
#   powershell -ExecutionPolicy Bypass -File .\scripts\v4\install-v4-windows.ps1
#   ... -AutoStart        register the logon task
#   ... -Uninstall        remove the logon task and launcher
param(
  [switch]$AutoStart,
  [switch]$AutoUpdate,
  [string]$UpdateTime = '04:00',
  [switch]$Uninstall,
  [int]$Port = 7373,
  # Lanes granted at install time. Defaults to the lanes that only READ from the
  # network; anything that touches the machine (files, shell, desktop) is left
  # for the owner to grant from the phone, where the consequence is visible.
  [string[]]$GrantLanes = @('web', 'research', 'jobs'),
  [string[]]$GrantFolders = @()
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$TaskName = 'MAJIN V4 Host'
$UpdateTaskName = 'MAJIN V4 Update'
$Launcher = Join-Path $RepoRoot 'start-majin-v4.cmd'
$DataHome = if ($env:MAJIN_HOME) { $env:MAJIN_HOME } else { Join-Path $env:LOCALAPPDATA 'MAJIN' }

function Write-Step($text) { Write-Host "  $text" }
function Fail($text) { Write-Host "  FEL: $text" -ForegroundColor Red; exit 1 }

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Step "Tog bort den schemalagda uppgiften '$TaskName'."
  }
  if (Get-ScheduledTask -TaskName $UpdateTaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $UpdateTaskName -Confirm:$false
    Write-Step "Tog bort den schemalagda uppgiften '$UpdateTaskName'."
  }
  if (Test-Path $Launcher) { Remove-Item $Launcher -Force; Write-Step "Tog bort $Launcher." }
  $OwnerMode = Join-Path $DataHome 'v4\owner-mode.json'
  if (Test-Path $OwnerMode) { Remove-Item $OwnerMode -Force; Write-Step 'Återkallade alla behörigheter (owner-mode.json borttagen).' }
  Write-Step 'Avinstallerat. Data i %LOCALAPPDATA%\MAJIN\v4 ligger kvar.'
  exit 0
}

Write-Host "`nMAJIN V4 — Windows host`n" -ForegroundColor Magenta

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js saknas. Installera Node 22 LTS från https://nodejs.org och kör igen.' }
$nodeVersion = (& node -p "process.versions.node").Trim()
$major = [int]($nodeVersion.Split('.')[0])
if ($major -lt 22) { Fail "Node $nodeVersion är för gammalt. MAJIN V4 kräver >= 22." }
Write-Step "Node $nodeVersion"

if (-not (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
  Write-Step 'Installerar npm-beroenden (npm ci, inga skript)...'
  Push-Location $RepoRoot
  try { & npm ci --ignore-scripts --no-audit --no-fund | Out-Null } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { Fail 'npm ci misslyckades. Kör npm ci manuellt för att se felet.' }
}
Write-Step 'Beroenden finns.'

$nodePath = $node.Source
@"
@echo off
rem MAJIN V4 host — startad av användaren, inte av systemet.
set MAJIN_V4_PORT=$Port
set "MAJIN_HOME=$DataHome"
cd /d "$RepoRoot"
"$nodePath" scripts\v4\supervise.mjs %*
"@ | Set-Content -Path $Launcher -Encoding ASCII
Write-Step "Launcher: $Launcher"

# --- 4b. Owner Mode seed ----------------------------------------------------
# Written, not implied: the file records exactly what was granted, when, and why.
$OwnerMode = Join-Path $DataHome 'v4\owner-mode.json'
if ((Test-Path -LiteralPath $OwnerMode) -and -not $PSBoundParameters.ContainsKey('GrantLanes') -and -not $PSBoundParameters.ContainsKey('GrantFolders')) {
  Write-Step 'Existing Owner Mode permissions preserved.'
} elseif (Test-Path -LiteralPath $OwnerMode) {
  Fail 'Owner Mode already exists. Change grants through the authenticated Permissions panel; the installer will not replace them.'
} elseif ($GrantLanes.Count -gt 0) {
  $dir = Split-Path -Parent $OwnerMode
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $seed = @{
    schema    = 'majin.v4.owner-mode/v1'
    version   = 1
    lanes     = @($GrantLanes)
    folders   = @($GrantFolders)
    grantedAt = (Get-Date).ToUniversalTime().ToString('o')
    revokedAt = $null
    history   = @(@{ at = (Get-Date).ToUniversalTime().ToString('o'); action = 'grant'; lanes = @($GrantLanes); folders = @($GrantFolders); reason = 'installer' })
  }
  $seed | ConvertTo-Json -Depth 6 | Set-Content -Path $OwnerMode -Encoding UTF8
  Write-Step "Behörigheter vid installation: $($GrantLanes -join ', ')"
  if ($GrantFolders.Count -gt 0) { Write-Step "Mappar: $($GrantFolders -join ', ')" }
  Write-Step 'Filer, terminal och skrivbord slås på från telefonen under Behörigheter.'
} else {
  Write-Step 'Inga behörigheter gavs vid installation (använd -GrantLanes för att sätta dem).'
}

Write-Step 'Kör host-doctor...'
Push-Location $RepoRoot
try { & node scripts/v4/host-doctor.mjs } finally { Pop-Location }

if ($AutoStart) {
  # Task settings reuse V1's proven choices (install.ps1, the 'MAJIN' task):
  #   -AllowStartIfOnBatteries / -DontStopIfGoingOnBatteries
  #       A host on a laptop must keep running when the charger is unplugged.
  #       Without these, Task Scheduler's default stops it on battery.
  #   -ExecutionTimeLimit ([TimeSpan]::Zero)
  #       Zero means NO limit. Omitted, the default is 72 hours and Windows
  #       kills the host after three days of uptime.
  # V4 adds -StartWhenAvailable and restart-on-failure, which V1 does not have.
  $escapedLauncher = $Launcher.Replace("'", "''")
  $hiddenArguments = "-NoProfile -NonInteractive -WindowStyle Hidden -Command `"& '$escapedLauncher'; exit `$LASTEXITCODE`""
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $hiddenArguments -WorkingDirectory $RepoRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Starts the MAJIN V4 host when the user logs in' -Force | Out-Null
  Write-Step "Scheduled task '$TaskName' registered for $env:USERNAME (logon only, no machine-wide change)."
  Write-Step 'Runs on battery, no 72-hour limit, restarts up to 3 times on failure.'
} else {
  Write-Step 'Ingen automatisk start vald. Kör med -AutoStart för en inloggningstask.'
}

if ($AutoUpdate) {
  # Automatic updates are only meaningful with a channel and a pinned key.
  # Both are written by `npm run v4:setup`, so this task is registered by the
  # same flow the owner already runs — never as a separate command.
  $UpdateConfig = Join-Path $DataHome 'v4\update.json'
  if (-not (Test-Path $UpdateConfig)) {
    Write-Step 'VARNING: ingen uppdateringskanal är konfigurerad (v4\update.json saknas).'
    Write-Step 'Kör: npm run v4:setup -- --release-url https://... --auto-update'
  }
  if (-not (Test-Path (Join-Path $DataHome 'v4\release-key.json'))) {
    Write-Step 'VARNING: ingen release-nyckel är pinnad. Signerade uppdateringar kan inte verifieras.'
  }
  $nodeExe = (Get-Command node).Source
  $escapedHome = $DataHome.Replace("'", "''")
  $escapedNode = $nodeExe.Replace("'", "''")
  $escapedUpdateScript = (Join-Path $RepoRoot 'scripts\v4\update.mjs').Replace("'", "''")
  $updateArguments = "-NoProfile -NonInteractive -WindowStyle Hidden -Command `"`$env:MAJIN_HOME = '$escapedHome'; & '$escapedNode' '$escapedUpdateScript' apply --quiet --log; exit `$LASTEXITCODE`""
  $updateAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument $updateArguments `
    -WorkingDirectory $RepoRoot
  $updateTrigger = New-ScheduledTaskTrigger -Daily -At $UpdateTime
  $updateSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
    -MultipleInstances IgnoreNew `
    -RunOnlyIfNetworkAvailable
  Register-ScheduledTask -TaskName $UpdateTaskName -Action $updateAction -Trigger $updateTrigger `
    -Settings $updateSettings `
    -Description 'Checks the signed MAJIN V4 release channel, verifies the signature, installs and rolls back on a failed health check' `
    -Force | Out-Null
  Write-Step "Scheduled task '$UpdateTaskName' registered: daily at $UpdateTime."
  Write-Step 'A release is installed only if its signature matches the pinned public key; a failed health check rolls back.'
} else {
  Write-Step 'Ingen automatisk uppdatering vald. Kör med -AutoUpdate (och sätt en kanal med v4:setup).'
}

Write-Host "`nKlart. Starta med: $Launcher" -ForegroundColor Green
Write-Host 'Parkoden skrivs ut i konsolen första gången. Dela den aldrig i chat eller e-post.'
Write-Host 'Publikt HTTPS: se docs/v4/DEPLOYMENT.md (Cloudflare Tunnel + Access).'
