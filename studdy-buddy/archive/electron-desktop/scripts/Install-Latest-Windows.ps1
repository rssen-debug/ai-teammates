# STUDDY BUDDY — safe one-time updater bootstrap (PowerShell 5.1+)
# Downloads the latest public, tested GitHub Release, verifies SHA-256, and
# installs it per user. No API key, GH CLI, Administrator or background service.
# This is needed ONCE for old installations that don't have built-in auto-update.
$ErrorActionPreference = 'Stop'
$repo = 'rssen-debug/ai-teammates'
$minVersion = [version]'0.1.112'
$root = Join-Path $env:LOCALAPPDATA 'Studdy-Buddy\Bootstrap'
New-Item -ItemType Directory -Force -Path $root | Out-Null

function Step([string] $message) { Write-Host "[Buddy] $message" -ForegroundColor Cyan }
function StopWith([string] $message) { throw "[Buddy] $message" }

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$headers = @{ 'User-Agent' = 'Studdy-Buddy-Windows-Installer'; Accept = 'application/vnd.github+json' }
Step 'Kontrollerar godkänd GitHub Release...'
$release = Invoke-RestMethod -Method Get -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers $headers -TimeoutSec 30
if ($release.draft -or $release.prerelease) { StopWith 'Senaste release är inte verifierad för installation.' }
if ($release.tag_name -notmatch '^studdy-buddy-v(\d+\.\d+\.\d+)$') {
    StopWith "Oväntat versionsnamn: $($release.tag_name)"
}
$version = [version]$Matches[1]
if ($version -lt $minVersion) {
    StopWith "Nya uppdateringen är ännu inte publicerad. Senast godkänd: $version. Kräver minst: $minVersion. Kontrollera GitHub Actions och kör sedan samma fil igen."
}
$assets = @($release.assets)
$expectedName = "Studdy-Buddy-$version-x64.exe"
$installerAsset = @($assets | Where-Object { $_.name -eq $expectedName }) | Select-Object -First 1
$hashAsset = @($assets | Where-Object { $_.name -eq "$expectedName.sha256" }) | Select-Object -First 1
if (-not $installerAsset -or -not $hashAsset) { StopWith 'Installationsfil eller SHA256 saknas i den godkända releasen.' }
$validPrefix = "https://github.com/$repo/releases/download/$($release.tag_name)/"
foreach ($asset in @($installerAsset, $hashAsset)) {
    if (-not [string]$asset.browser_download_url -or -not ([string]$asset.browser_download_url).StartsWith($validPrefix)) {
        StopWith 'GitHub gav en oväntad nedladdningsadress. Avbryter.'
    }
}
$hashPath = Join-Path $root "$expectedName.sha256"
$exePath = Join-Path $root $expectedName
Step "Hämtar version $version..."
Invoke-WebRequest -Uri $hashAsset.browser_download_url -OutFile $hashPath -Headers $headers -UseBasicParsing -TimeoutSec 120
$expected = ((Get-Content $hashPath -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
if ($expected -notmatch '^[a-f0-9]{64}$') { StopWith 'Ogiltig checksumma.' }
if ($installerAsset.digest -and $installerAsset.digest -ne "sha256:$expected") { StopWith 'GitHub-digest matchar inte SHA256-filen.' }
Invoke-WebRequest -Uri $installerAsset.browser_download_url -OutFile $exePath -Headers $headers -UseBasicParsing -TimeoutSec 420
$actual = (Get-FileHash -Algorithm SHA256 -Path $exePath).Hash.ToLowerInvariant()
if ($actual -ne $expected) { Remove-Item $exePath -ErrorAction SilentlyContinue; StopWith 'SHA256-kontroll misslyckades. Inget installerades.' }
Step 'SHA256 godkänd. Stänger gamla Buddy och installerar uppdateringen...'
$existing = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -in @('Studdy Buddy', 'Studdy-Buddy')
})
foreach ($process in $existing) {
    try { [void]$process.CloseMainWindow() } catch {}
}
Start-Sleep -Seconds 2
foreach ($process in $existing) {
    try {
        if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    } catch {}
}
$done = Start-Process -FilePath $exePath -ArgumentList '/S' -Wait -PassThru
if ($done.ExitCode -ne 0) { StopWith "Installationen misslyckades med exit code $($done.ExitCode)." }
Step "Installerad version: $version"
$possibilities = @(
    "$env:LOCALAPPDATA\Programs\studdy-buddy\Studdy Buddy.exe",
    "$env:LOCALAPPDATA\Programs\Studdy Buddy\Studdy Buddy.exe",
    "$env:LOCALAPPDATA\Programs\studdy-buddy\Studdy-Buddy.exe"
)
$appPath = @($possibilities | Where-Object { Test-Path $_ }) | Select-Object -First 1
if ($appPath) {
    Start-Process -FilePath $appPath
    Step 'Buddy är startad. Kommande verifierade releaser kontrolleras automatiskt.'
} else {
    Step 'Installationen är klar. Starta Buddy via Start-menyn om den inte öppnades.'
}
Write-Host "Version $version - kontrollerad SHA256: $expected" -ForegroundColor Green
