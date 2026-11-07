<#
  MAJIN installer -- the part that majin-setup.exe hands over to.

  It is a plain script on purpose: read it before you run it, and it is still
  here in %LOCALAPPDATA%\MAJIN afterwards if you want to run it again with other
  switches. Nothing needs admin: it writes inside its own folder, adds the user
  PATH entry, and drops one .lnk on the Desktop.

    powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1 -DryRun
    powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1 -NoStart -NoPath
#>
param(
  [string]$Target = $PSScriptRoot,
  [string]$NodeUrl = 'https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-x64.zip',
  [switch]$NoStart,
  [switch]$NoPath,
  [switch]$NoShortcut,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
function Ok([string]$m)   { Write-Host "  ok      $m" -ForegroundColor Green }
function Info([string]$m) { Write-Host "  ..      $m" -ForegroundColor DarkGray }
function Warn([string]$m) { Write-Host "  note    $m" -ForegroundColor Yellow }
function Do([string]$what, [scriptblock]$body) {
  if ($DryRun) { Write-Host "  dry     $what" -ForegroundColor Cyan; return }
  & $body | Out-Null
  Ok $what
}

$Target = (Resolve-Path $Target).Path
$Dist = Join-Path $Target 'dist'
$Bundle = Join-Path $Dist 'majin.cjs'
$Bin = Join-Path $Target 'bin'
$Ico = Join-Path $Dist 'assets\majin.ico'

if (-not (Test-Path $Bundle)) {
  Write-Host "  fail    no dist\majin.cjs under $Target -- run majin-setup.exe, not this script alone" -ForegroundColor Red
  exit 1
}
Write-Host 'MAJIN setup'
Write-Host "  folder  $Target"

# --- 1. a node to run it with -------------------------------------------------
$Local = Join-Path $Target 'node\node.exe'
$Node = $null
if (Test-Path $Local) { $Node = $Local }
else {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) {
    $ver = [version]((& $cmd.Source --version).TrimStart('v').Split('-')[0])
    if ($ver.Major -ge 22) { $Node = $cmd.Source }
    else { Warn "node $ver is too old (need >= 22.0) -- will use its own copy" }
  }
}
if (-not $Node) {
  Info 'node not found -- downloading the LTS binaries into this folder (no admin)'
  $tmp = Join-Path $env:TEMP ('majin-node-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $zip = "$tmp.zip"
  try {
    Do 'fetch node' {
      New-Item -ItemType Directory -Force -Path $tmp | Out-Null
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -Uri $NodeUrl -OutFile $zip -UseBasicParsing
      Push-Location $tmp
      tar -xf $zip
      Pop-Location
      $inner = Get-ChildItem $tmp -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'node.exe') } | Select-Object -First 1
      if (-not $inner) { throw 'the node archive did not contain node.exe' }
      New-Item -ItemType Directory -Force -Path (Split-Path $Local) | Out-Null
      Move-Item (Join-Path $inner.FullName 'node.exe') $Local -Force
      Remove-Item $tmp, $zip -Recurse -Force -ErrorAction SilentlyContinue
    }
    $Node = $Local
    Ok "node $(& $Node --version) in $(Split-Path $Local)"
  } catch {
    Warn "could not fetch node from $NodeUrl -- $($_.Exception.Message)"
    Warn 'install it yourself instead:  winget install -e --id OpenJS.NodeJS.LTS'
    if (-not $DryRun) { exit 1 }
  }
} else {
  $which = if ($Node -eq $Local) { 'local copy' } else { 'from PATH' }
  Ok "node $(& $Node --version) ($which)"
}

# --- 2. the `majin` command ---------------------------------------------------
$Wrapper = @"
@echo off
setlocal
if "%MAJIN_HOME%"=="" set "MAJIN_HOME=$env:LOCALAPPDATA\MAJIN"
if "%MAJIN_WORKSPACE%"=="" set "MAJIN_WORKSPACE=%USERPROFILE%"
"$Node" "%~dp0..\dist\majin.cjs" %*
"@
Do "majin.cmd written to $Bin" {
  New-Item -ItemType Directory -Force -Path $Bin | Out-Null
  Set-Content -Path (Join-Path $Bin 'majin.cmd') -Value $Wrapper -Encoding ASCII
}

# --- 3. PATH (user scope; not setx, which truncates at 1024 chars) -----------
if ($NoPath) { Warn 'PATH left alone (-NoPath)' }
else {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($userPath -split ';') -contains $Bin) { Ok "$Bin already on the user PATH" }
  else {
    $new = if ($userPath) { "$Bin;$userPath" } else { $Bin }
    Do "PATH += $Bin (user)" { [Environment]::SetEnvironmentVariable('Path', $new, 'User') }
    Warn 'a new terminal window is needed before "majin" is found'
  }
}

# --- 4. one Desktop icon -----------------------------------------------------
if ($NoShortcut) { Warn 'no shortcut (-NoShortcut)' }
else {
  $desk = @(
    (Join-Path $env:USERPROFILE 'Desktop'),
    (Join-Path $env:USERPROFILE 'OneDrive\Desktop'),
    (Join-Path $env:USERPROFILE 'Skrivbord')
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $desk) { Warn 'no Desktop folder found -- skipping the shortcut' }
  else {
    $lnk = Join-Path $desk 'MAJIN.lnk'
    $icon = if (Test-Path $Ico) { $Ico } else { $Node }
    Do "MAJIN.lnk on $desk" {
      $ws = New-Object -ComObject WScript.Shell
      $s = $ws.CreateShortcut($lnk)
      $s.TargetPath = (Join-Path $Bin 'majin.cmd')
      $s.Arguments = 'start'
      $s.WorkingDirectory = $Target
      $s.IconLocation = "$icon,0"
      $s.Description = 'MAJIN - your own agent, on this machine'
      $s.WindowStyle = 1
      $s.Save()
    }
  }
}

# --- 5. run it ---------------------------------------------------------------
if ($NoStart) { Warn 'not started (-NoStart) -- run:  majin start' }
else {
  Write-Host ''
  Info 'starting MAJIN (a browser window opens; Ctrl-C in that window stops it)'
  if (-not $DryRun) { & (Join-Path $Bin 'majin.cmd') start }
}
