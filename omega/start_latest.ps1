# Studdy Buddy Omega — stable Windows launcher.
# Gets the newest verified main checkout without rewriting local work.
$ErrorActionPreference = "Stop"

$repo = Join-Path $HOME "ai-teammates"
$python = Join-Path $env:APPDATA "StuddyBuddy\venv\Scripts\python.exe"
if (!(Test-Path $python)) { throw "Buddys Python saknas: $python" }
if (!(Test-Path (Join-Path $repo ".git"))) { throw "Repo saknas: $repo" }

git -C $repo fetch origin main
if ($LASTEXITCODE -ne 0) { throw "Git fetch failed" }
$sha = (git -C $repo rev-parse origin/main).Trim()
if ($LASTEXITCODE -ne 0 -or $sha -notmatch '^[0-9a-f]{40}$') {
    throw "Kunde inte läsa giltig origin/main SHA"
}
$root = Join-Path $env:LOCALAPPDATA "StuddyBuddy\releases"
New-Item -ItemType Directory -Path $root -Force | Out-Null
$release = Join-Path $root $sha

if (!(Test-Path (Join-Path $release "omega\buddy.py"))) {
    if (Test-Path $release) {
        throw "Release folder finns men är inte en riktig checkout: $release"
    }
    git -C $repo worktree add --detach $release $sha
    if ($LASTEXITCODE -ne 0) { throw "Git worktree failed" }
}
$actual = (git -C $release rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actual -ne $sha) {
    throw "Release checkout matchar inte origin/main"
}

$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONPATH = Join-Path $release "omega"
Write-Host ("OMEGA RELEASE: " + $sha.Substring(0, 12)) -ForegroundColor Magenta
Write-Host "Use /models to choose provider; /api to save keys; /worker status for VM." -ForegroundColor Cyan
& $python (Join-Path $release "omega\buddy.py")
exit $LASTEXITCODE
