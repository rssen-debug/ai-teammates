<#
  MAJIN W11 — desktop-eval setup for the live Windows lane (user's machine).
  Seeds %TEMP%\majin-eval-doc.txt so the benchmark/rename-file-dialog-win task
  has a deterministic target. Idempotent: reseeds with the seeded content.
  Exit 0 when the seed is verifiably on disk (we read it back, never trust).
#>
$ErrorActionPreference = 'Stop'
$doc = Join-Path $env:TEMP 'majin-eval-doc.txt'
Set-Content -LiteralPath $doc -Value 'majin-eval doc — seeded by scripts/windows/desktop-eval-setup.ps1' -Encoding UTF8
$readBack = Get-Content -LiteralPath $doc -Raw
if ($readBack -notlike '*majin-eval doc*') { Write-Error 'seed failed: read-back mismatch'; exit 1 }
Write-Output "seeded+verified: $doc"
if (Test-Path (Join-Path $env:TEMP 'majin-eval-renamed.txt')) {
  Remove-Item (Join-Path $env:TEMP 'majin-eval-renamed.txt') -Force
  Write-Output 'cleared stale renamed file for a clean measurement'
}
exit 0
