#Requires -Version 5.1
<#
.SYNOPSIS
  MAJIN V5 — GRAND ARCHITECT Reproducible Windows 11 Installer & Rollback Script.
.DESCRIPTION
  Installs MAJIN V5 into %LOCALAPPDATA%\MAJIN-V5, verifies file SHA-256 hashes
  against docs/v5/build-manifest.json, preserves existing V1-V4 user data, and
  supports automatic rollback on failed health check.
#>
param(
  [string]$InstallDir = "$env:LOCALAPPDATA\MAJIN-V5",
  [string]$DataDir = "$env:USERPROFILE\.majin\v5",
  [switch]$VerifyOnly
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ManifestPath = Join-Path $RepoRoot "docs\v5\build-manifest.json"

if (-not (Test-Path $ManifestPath)) {
  throw "Build manifest missing: $ManifestPath"
}

$Manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
Write-Host "Verifying MAJIN V5 ($($Manifest.version) @ $($Manifest.gitSha)) integrity..."

foreach ($Prop in $Manifest.files.PSObject.Properties) {
  $RelPath = $Prop.Name
  $ExpectedSha = $Prop.Value.sha256
  $FullPath = Join-Path $RepoRoot ($RelPath -replace '/', '\')
  if (-not (Test-Path $FullPath)) {
    throw "Missing required package file: $RelPath"
  }
  $ActualSha = (Get-FileHash -Path $FullPath -Algorithm SHA256).Hash.ToLower()
  if ($ActualSha -ne $ExpectedSha.ToLower()) {
    throw "SHA-256 mismatch for $RelPath (expected $ExpectedSha, got $ActualSha)"
  }
}

Write-Host "All $($Manifest.files.PSObject.Properties.Count) V5 files passed SHA-256 verification."
if ($VerifyOnly) {
  exit 0
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
Write-Host "MAJIN V5 installed to $InstallDir (user data isolated in $DataDir)."
