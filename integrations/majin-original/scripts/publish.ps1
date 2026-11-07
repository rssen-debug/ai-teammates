<#
  Publish MAJIN from this working copy: push, tag, wait for CI, and prove that
  the release actually carries the files. It is deliberately annoying to use
  wrong -- every step is verified and the script exits non-zero with a reason,
  rather than leaving an empty release behind.

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\publish.ps1
    ... -Version 0.5.4 -Branch main
    ... -CheckOnly        # just report what is on GitHub right now
#>
param(
  [string]$Version = '4.0.0-alpha.3',
  [string]$Branch = 'main',
  [string]$Repo = 'rssen-debug/MAJINCLI',
  [switch]$CheckOnly,
  [switch]$SkipPush
)

$ErrorActionPreference = 'Stop'
$Tag = "v$Version"
function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  ok    $m" -ForegroundColor Green }
function Bad($m) { Write-Host "  FAIL  $m" -ForegroundColor Red; exit 1 }

Step 'prerequisites'
foreach ($tool in 'git', 'gh') { if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Bad "$tool is not on PATH (winget install GitHub.cli)" } }
gh auth status *> $null
if ($LASTEXITCODE -ne 0) { Bad 'gh is not logged in -- run: gh auth login' }
Ok "gh as $((gh api user --jq .login) -join '')"

Step 'working tree'
$dirty = (git status --porcelain) -join ''
if ($dirty -and -not $CheckOnly) { Bad "uncommitted changes -- commit them first (git status)" }
$head = (git rev-parse HEAD).Trim()
Ok "local head $head"

if (-not $CheckOnly -and -not $SkipPush) {
  Step 'push'
  git push origin "HEAD:$Branch"
  if ($LASTEXITCODE -ne 0) { Bad "git push failed (branch $Branch)" }
  Ok "origin/$Branch = $((git rev-parse "origin/$Branch").Trim())"
  if ((git rev-parse "origin/$Branch").Trim() -ne $head) { Bad 'the push did not land the local head' }

  Step "tag $Tag"
  git tag -a $Tag -m "MAJIN $Version" $head
  if ($LASTEXITCODE -ne 0) { Bad "tag $Tag already exists or could not be created — never overwrite a published release" }
  git push origin $Tag
  if ($LASTEXITCODE -ne 0) { Bad "failed to publish tag $Tag to $Repo" }
  Ok "tag $Tag -> $head (this triggers build-exe)"
}

Step 'find the run for this commit'
$runId = $null
for ($i = 0; $i -lt 40; $i++) {
  $runs = gh api "repos/$Repo/actions/workflows/build-exe.yml/runs?per_page=5" --jq '.workflow_runs[] | select(.head_sha == "' + $head + '") | .id'
  if ($runs) { $runId = ($runs -split "`n")[0].Trim(); break }
  Start-Sleep -Seconds 15
}
if (-not $runId) { Bad "no build-exe run for $head after 10 minutes -- check: gh run list --workflow build-exe.yml" }
Ok "run $runId"

Step 'watch the build'
gh run watch $runId --exit-status
if ($LASTEXITCODE -ne 0) { Bad "run $runId did not succeed -- open: gh run view $runId --log-failed or the job annotations" }
Ok 'run finished'

Step 'the release must exist and carry the files'
$rel = gh api "repos/$Repo/releases/tags/$Tag" 2>$null
if (-not $rel) { Bad "no release for tag $Tag -- the workflow never published it" }
$json = $rel | ConvertFrom-Json
$assets = @($json.assets)
if ($assets.Count -eq 0) { Bad "release '$($json.name)' is EMPTY -- that is the one thing this script refuses to report as success" }
$setup = $assets | Where-Object { $_.name -eq 'MAJIN-Setup.exe' } | Select-Object -First 1
if (-not $setup) { Bad "release has no MAJIN-Setup.exe (assets: $(($assets | ForEach-Object { $_.name }) -join ', '))" }
if ($setup.size -lt 1MB) { Bad "MAJIN-Setup.exe is only $($setup.size) bytes -- an installer that small has no program in it" }
Ok "asset MAJIN-Setup.exe, $([math]::Round($setup.size/1MB,1)) MB, download count $($setup.download_count)"
$portable = $assets | Where-Object { $_.name -eq 'majin-win-x64.exe' } | Select-Object -First 1
if ($portable) { Ok "asset majin-win-x64.exe, $([math]::Round($portable.size/1MB,1)) MB" } else { Write-Host '  note    no portable exe this run (pkg failed; the installer is enough)' -ForegroundColor Yellow }

$Url = "https://github.com/$Repo/releases/download/$Tag/MAJIN-Setup.exe"
Step 'the URL must answer'
try {
  $head2 = Invoke-WebRequest -Uri $Url -Method Head -UseBasicParsing
  if ($head2.StatusCode -ne 200) { Bad "HEAD $Url -> $($head2.StatusCode)" }
  Ok "HTTP 200, $($head2.Headers['Content-Length']) bytes"
} catch { Bad "HEAD $Url failed: $($_.Exception.Message)" }

Write-Host ''
Write-Host "  download  $Url" -ForegroundColor Green
Write-Host "  release   $($json.html_url)"
Write-Host '  on the target machine: double-click MAJIN-Setup.exe, then the MAJIN icon.'
