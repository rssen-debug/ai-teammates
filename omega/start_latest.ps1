# Omega Bring Your Own Key (BYOK) - versioned Windows beta launcher.
# Run from a trusted checkout with: powershell -NoProfile -ExecutionPolicy Bypass -File .\omega\start_latest.ps1
# This launcher does not download unverified binaries or request administrator access.
[CmdletBinding()]
param(
    [switch]$WithVoice,
    [switch]$WithBrowser,
    [switch]$DoctorOnly,
    [switch]$NoInstall
)
$ErrorActionPreference = "Stop"

function Assert-Exit([string]$label) {
    if ($LASTEXITCODE -ne 0) { throw "$label failed (exit code $LASTEXITCODE)" }
}
function Find-Python {
    if (Get-Command py -ErrorAction SilentlyContinue) {
        foreach ($version in @("-3.13", "-3.12", "-3.11", "-3.10")) {
            & py $version -c "import sys; print(sys.version_info[:2])" *> $null
            if ($LASTEXITCODE -eq 0) { return @("py", $version) }
        }
    }
    if (Get-Command python -ErrorAction SilentlyContinue) {
        & python -c "import sys; raise SystemExit(0 if (3,10) <= sys.version_info[:2] < (3,14) else 1)" *> $null
        if ($LASTEXITCODE -eq 0) { return @("python") }
    }
    throw "Python 3.10-3.13 saknas. Installera en stödd Python-version från python.org."
}

if ($env:OS -ne "Windows_NT") { throw "Denna beta-launcher är avsedd för Windows." }
if (!(Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git saknas. Installera Git for Windows innan Omega."
}

$repo = Join-Path $HOME "ai-teammates"
$repoUrl = "https://github.com/rssen-debug/ai-teammates.git"
if (!(Test-Path (Join-Path $repo ".git"))) {
    if ($NoInstall) { throw "Repo saknas: $repo" }
    if (Test-Path $repo) { throw "Sökvägen är upptagen, vägrar skriva över: $repo" }
    git clone --origin origin -- $repoUrl $repo
    Assert-Exit "Git clone"
}
$remote = (git -C $repo remote get-url origin).Trim()
Assert-Exit "Git origin"
if ($remote -notin @($repoUrl, "git@github.com:rssen-debug/ai-teammates.git")) {
    throw "Git origin är inte det förväntade Omega-repot. Avbryter."
}

git -C $repo fetch --no-tags origin main
Assert-Exit "Git fetch"
$sha = (git -C $repo rev-parse --verify "refs/remotes/origin/main^{commit}").Trim()
Assert-Exit "Git rev-parse"
if ($sha -notmatch '^[0-9a-f]{40}$') { throw "Ogiltig commit SHA" }

$releases = Join-Path $env:LOCALAPPDATA "StuddyBuddy\releases"
New-Item -ItemType Directory -Path $releases -Force | Out-Null
$release = Join-Path $releases $sha
$entry = Join-Path $release "omega\buddy.py"
if (!(Test-Path $entry)) {
    if (Test-Path $release) { throw "Ofullständig release finns redan: $release" }
    git -C $repo worktree add --detach $release $sha
    Assert-Exit "Git worktree"
}
$actual = (git -C $release rev-parse HEAD).Trim()
Assert-Exit "Git release check"
if ($actual -ne $sha) { throw "Fel releaseversion; vägrar starta." }

$venv = Join-Path $env:APPDATA "StuddyBuddy\venv"
$python = Join-Path $venv "Scripts\python.exe"
if (!(Test-Path $python)) {
    if ($NoInstall) { throw "Python-venv saknas: $venv" }
    $cmd = Find-Python
    $exe = $cmd[0]
    $prefix = @()
    if ($cmd.Count -gt 1) { $prefix = @($cmd[1]) }
    & $exe @prefix -m venv $venv
    Assert-Exit "Python virtual environment"
}
& $python -c "import sys; raise SystemExit(0 if (3,10) <= sys.version_info[:2] < (3,14) else 1)"
Assert-Exit "Supported Python version"

# Install only declared and auditable packages, never shell-piped downloads.
$deps = @("prompt-toolkit>=3.0,<4", "pillow", "uiautomation")
if ($WithVoice) { $deps += @("sounddevice", "numpy", "faster-whisper") }
if ($WithBrowser) { $deps += @("websocket-client") }
if (-not $NoInstall) {
    & $python -m pip install --disable-pip-version-check @deps
    Assert-Exit "Python dependencies"
}
& $python -m py_compile $entry (Join-Path $release "omega\live_panel.py") (Join-Path $release "omega\voice_study.py")
Assert-Exit "Python syntax"

$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONPATH = Join-Path $release "omega"
Write-Host "OMEGA BYOK BETA  |  $($sha.Substring(0,12))" -ForegroundColor Green
Write-Host "Local data/keys preserved. Keys are entered inside Omega; never paste them in a public issue." -ForegroundColor Cyan
Write-Host "/models -> /api openrouter or /api go -> /testapi. Voice: /voice study on; /voice on." -ForegroundColor Cyan

if ($DoctorOnly) {
    & $python $entry doctor
} else {
    & $python $entry
}
exit $LASTEXITCODE
