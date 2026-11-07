<#
.SYNOPSIS
  MAJIN V6 test-environment launcher (Windows PowerShell 5.1+).

.DESCRIPTION
  Safe by construction:
    - never installs, upgrades or removes any package;
    - never writes OpenCode settings, models, sessions or credentials;
    - never writes the V5 data directory;
    - creates only the V6 home (%LOCALAPPDATA%\MAJIN\v6 by default);
    - prints the exact OpenCode MCP registration instead of applying it.

  Run the registration script separately if you decide to connect the bridge.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\v6\start-v6.ps1 -Action Doctor

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\v6\start-v6.ps1 -Action Worker -MaxTasks 10 -MaxRuntimeMinutes 15
#>
[CmdletBinding()]
param(
  [ValidateSet('Doctor', 'Status', 'Worker', 'Inventory', 'Config')]
  [string]$Action = 'Doctor',

  [string]$Workspace = (Get-Location).Path,
  [string]$V5DataDir = (Join-Path $env:LOCALAPPDATA 'MAJIN\v5'),
  [string]$V6Home = (Join-Path $env:LOCALAPPDATA 'MAJIN\v6'),

  [ValidateRange(1, 500)]
  [int]$MaxTasks = 10,

  [ValidateRange(1, 720)]
  [int]$MaxRuntimeMinutes = 15,

  [switch]$DryRun
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
$workspacePath = Resolve-FullPath $Workspace
$v5Path = Resolve-FullPath $V5DataDir
$v6Path = Resolve-FullPath $V6Home

Write-Host 'MAJIN V6 - safe test environment' -ForegroundColor Cyan
Write-Host "Repository: $repoRoot"
Write-Host "Workspace:  $workspacePath"
Write-Host "V5 data:    $v5Path (read-only)"
Write-Host "V6 home:    $v6Path (all V6 writes)"
Write-Host ''

if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
  throw "majin-v6.mjs not found at $script. Run this from a complete MAJINCLI checkout."
}
if (-not (Test-Path -LiteralPath $workspacePath -PathType Container)) {
  throw "Workspace does not exist: $workspacePath"
}
if ((Test-PathInside $v6Path $v5Path)) {
  throw 'Refusing to run: the V6 home must not be the V5 data directory or inside it.'
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js was not found in PATH. Install Node 22+ separately; this launcher does not install it.' }
& node -e "process.exit(Number(process.versions.node.split('.')[0]) -ge 22 ? 0 : 1)"
if ($LASTEXITCODE -ne 0) {
  $version = (& node --version)
  throw "Node $version is too old. V6 requires Node 22+."
}

if (-not (Test-Path -LiteralPath $v5Path -PathType Container)) {
  Write-Host 'BLOCKED: the existing V5 data directory was not found.' -ForegroundColor Yellow
  Write-Host 'V6 will not create it. Set -V5DataDir to the real profile if it lives elsewhere.'
} elseif (-not (Test-Path -LiteralPath (Join-Path $v5Path 'owner-mode.json') -PathType Leaf)) {
  Write-Host 'NOTE: owner-mode.json is absent in the V5 profile; no MAJIN tools will be authorized until the owner grants lanes.' -ForegroundColor Yellow
}

if (-not (Test-Path -LiteralPath $v6Path -PathType Container)) {
  if ($DryRun) {
    Write-Host "[DryRun] would create V6 home: $v6Path"
  } else {
    New-Item -ItemType Directory -Path $v6Path -Force | Out-Null
    Write-Host "Created V6 home: $v6Path"
  }
}

$commonArgs = @(
  '--workspace', $workspacePath,
  '--data-dir', $v5Path,
  '--v6-home', $v6Path
)

switch ($Action) {
  'Config' {
    $entry = [ordered]@{
      type        = 'local'
      command     = @('node', $script, 'mcp', '--workspace', $workspacePath, '--data-dir', $v5Path, '--v6-home', $v6Path)
      enabled     = $true
      timeout     = 300000
      environment = [ordered]@{ MAJIN_V6_HOME = $v6Path }
    }
    $snippet = [ordered]@{
      '$schema' = 'https://opencode.ai/config.json'
      mcp       = [ordered]@{ majin = $entry }
    }
    Write-Host 'OpenCode MCP registration (NOT applied by this launcher):' -ForegroundColor Cyan
    $snippet | ConvertTo-Json -Depth 20
    Write-Host ''
    Write-Host 'Apply it with scripts\v6\register-opencode-mcp.ps1 (dry-run by default, backs up the config).'
    Write-Host 'The 300000 ms timeout is deliberate: browser and job operations exceed OpenCode''s 5 s default.'
  }

  'Doctor' {
    $cmd = @($script, 'doctor') + $commonArgs
    Write-Host "Running: node $($cmd -join ' ')"
    if ($DryRun) { Write-Host '[DryRun] doctor not executed'; exit 0 }
    & node @cmd
    exit $LASTEXITCODE
  }

  'Status' {
    $cmd = @($script, 'status') + $commonArgs
    Write-Host "Running: node $($cmd -join ' ')"
    if ($DryRun) { Write-Host '[DryRun] status not executed'; exit 0 }
    & node @cmd
    exit $LASTEXITCODE
  }

  'Inventory' {
    $cmd = @($script, 'inventory', '--deep')
    if ($DryRun) { Write-Host "[DryRun] would run: node $($cmd -join ' ')" -ForegroundColor Yellow; exit 0 }
    & node @cmd
    exit $LASTEXITCODE
  }

  'Worker' {
    $runtimeMs = $MaxRuntimeMinutes * 60 * 1000
    $cmd = @($script, 'worker') + $commonArgs + @(
      '--max-tasks', [string]$MaxTasks,
      '--max-runtime-ms', [string]$runtimeMs
    )
    Write-Host "Running a bounded worker: node $($cmd -join ' ')" -ForegroundColor Green
    Write-Host 'This is not OpenCode. Keep using the OpenCode CLI for chat; this process continues queued work.'
    if ($DryRun) { Write-Host '[DryRun] worker not executed' -ForegroundColor Yellow; exit 0 }
    & node @cmd
    exit $LASTEXITCODE
  }
}
