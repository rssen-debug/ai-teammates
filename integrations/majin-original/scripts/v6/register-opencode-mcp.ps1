<#
.SYNOPSIS
  Register the MAJIN V6 MCP server in an existing OpenCode config.

.DESCRIPTION
  Dry-run by default. With -Apply it:
    1. parses the existing JSON config (JSONC is refused, not rewritten);
    2. copies the file to a timestamped .bak next to it;
    3. verifies the backup exists;
    4. adds/updates ONLY mcp.majin, preserving every other key;
    5. re-parses the written file and restores the backup on any failure.

  It never touches providers, models, auth, sessions, themes or permissions.
  Restart OpenCode afterwards; running sessions keep their old tool list.

.PARAMETER Apply
  Actually write the config. Without it, the proposed JSON is printed only.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\v6\register-opencode-mcp.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\v6\register-opencode-mcp.ps1 -Apply
#>
[CmdletBinding()]
param(
  [string]$ConfigPath = (Join-Path $env:USERPROFILE '.config\opencode\opencode.json'),
  [string]$Workspace = (Get-Location).Path,
  [string]$V5DataDir = (Join-Path $env:LOCALAPPDATA 'MAJIN\v5'),
  [string]$V6Home = (Join-Path $env:LOCALAPPDATA 'MAJIN\v6'),
  [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-FullPath([string]$PathValue) {
  return [System.IO.Path]::GetFullPath($PathValue)
}

function Test-PathInside([string]$Child, [string]$Parent) {
  $childFull = (Resolve-FullPath $Child).TrimEnd('\')
  $parentFull = (Resolve-FullPath $Parent).TrimEnd('\')
  return $childFull.Equals($parentFull, [System.StringComparison]::OrdinalIgnoreCase) -or
         $childFull.StartsWith($parentFull + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

$repoRoot = Resolve-FullPath (Join-Path $PSScriptRoot '..\..')
$script = Join-Path $repoRoot 'bin\majin-v6.mjs'
$configFull = Resolve-FullPath $ConfigPath
$workspacePath = Resolve-FullPath $Workspace
$v5Path = Resolve-FullPath $V5DataDir
$v6Path = Resolve-FullPath $V6Home

if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
  throw "majin-v6.mjs not found at $script. Refusing to register a broken command."
}
if ((Test-PathInside $v6Path $v5Path)) {
  throw 'Refusing to register: V6 home must not be inside the V5 data directory.'
}
if ($configFull.EndsWith('.jsonc', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'JSONC configs are not edited automatically because comments would be lost. Use the snippet from start-v6.ps1 -Action Config and add it manually.'
}

$entry = [ordered]@{
  type        = 'local'
  command     = @('node', $script, 'mcp', '--workspace', $workspacePath, '--data-dir', $v5Path, '--v6-home', $v6Path)
  enabled     = $true
  timeout     = 300000
  environment = [ordered]@{ MAJIN_V6_HOME = $v6Path }
}

$hadConfig = Test-Path -LiteralPath $configFull -PathType Leaf
if ($hadConfig) {
  $raw = Get-Content -LiteralPath $configFull -Raw
  if ([string]::IsNullOrWhiteSpace($raw)) {
    $config = [ordered]@{ '$schema' = 'https://opencode.ai/config.json' }
  } else {
    if ($raw -match '(?m)^\s*//') {
      throw 'The config contains line comments (JSONC). Refusing to rewrite it; add the MCP entry manually.'
    }
    try {
      $parsed = $raw | ConvertFrom-Json
    } catch {
      throw "The existing OpenCode config could not be parsed ($($_.Exception.Message)). Nothing was changed."
    }
    $config = @{}
    foreach ($property in $parsed.PSObject.Properties) { $config[$property.Name] = $property.Value }
    if (-not $config.ContainsKey('$schema')) { $config['$schema'] = 'https://opencode.ai/config.json' }
  }
} else {
  $config = [ordered]@{ '$schema' = 'https://opencode.ai/config.json' }
}

if (-not $config.ContainsKey('mcp') -or $null -eq $config['mcp']) {
  $config['mcp'] = @{}
}
$mcp = $config['mcp']
if ($mcp -is [System.Management.Automation.PSCustomObject]) {
  $mcpObject = @{}
  foreach ($property in $mcp.PSObject.Properties) { $mcpObject[$property.Name] = $property.Value }
  $mcp = $mcpObject
  $config['mcp'] = $mcp
}
$mcp['majin'] = $entry

$json = $config | ConvertTo-Json -Depth 50

Write-Host "OpenCode config: $configFull"
Write-Host "Existing file:   $hadConfig"
Write-Host ''
Write-Host 'Proposed mcp.majin entry (other keys are preserved):' -ForegroundColor Cyan
$entry | ConvertTo-Json -Depth 10

if (-not $Apply) {
  Write-Host ''
  Write-Host 'DRY RUN. Nothing was written. Re-run with -Apply to write the change.' -ForegroundColor Yellow
  Write-Host 'A timestamped backup is created before writing; restart OpenCode afterwards.'
  exit 0
}

$backup = $null
if ($hadConfig) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = "$configFull.bak-$stamp"
  Copy-Item -LiteralPath $configFull -Destination $backup -Force
  if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) {
    throw "Backup was not created at $backup. Refusing to modify the config."
  }
  Write-Host "Backup written: $backup"
} else {
  $parent = Split-Path -Parent $configFull
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
}

try {
  Set-Content -LiteralPath $configFull -Value $json -Encoding UTF8
  $verify = Get-Content -LiteralPath $configFull -Raw | ConvertFrom-Json
  if (-not $verify.mcp.majin -or $verify.mcp.majin.type -ne 'local') {
    throw 'Post-write verification failed: mcp.majin is not present.'
  }
  Write-Host 'Config written and re-parsed successfully.' -ForegroundColor Green
} catch {
  if ($backup -and (Test-Path -LiteralPath $backup -PathType Leaf)) {
    Copy-Item -LiteralPath $backup -Destination $configFull -Force
    Write-Host "Write failed; original config restored from $backup" -ForegroundColor Yellow
  } else {
    Remove-Item -LiteralPath $configFull -Force -ErrorAction SilentlyContinue
    Write-Host 'Write failed; newly created config removed.' -ForegroundColor Yellow
  }
  throw
}

Write-Host ''
Write-Host 'Next: restart OpenCode, then ask it to show the MAJIN tools (majin_status).' -ForegroundColor Cyan
Write-Host 'OpenCode''s default MCP timeout is 5 s; this entry sets 300 s for browser/job work.'
