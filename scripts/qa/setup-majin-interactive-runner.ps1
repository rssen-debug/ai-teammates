# MAJIN — Self-hosted interactive-runner kit (Windows)
# Kör i en ELEVATED PowerShell-session på din Windows-PC (Högerklick → Kör som administratör).
# Vad den gör, mätt på ärlig plattform-sanning:
#   1. Hämtar GitHub Actions-runner och registrerar den MED label [self-hosted, windows, interactive-desktop]
#   2. SKAPAR EJ tjänst — runnern körs interaktivt (kör.cmd) i det nuvarande autologgade Windows-kontot.
#      Session 0-problemet (52 luktas finner ingen skärm) finns inte här — samma desktop som du ser.
#   3. Autologgad konto (rengör WARN ok att slippa) — LÄS AVSNITTET OM SÄKERHET FÖRE START.
#   4. Scheduled Task vid logon så runnern startar automatiskt efter omstart (interaktiv, aldrig som service).
#
# SÄKERHET (läs!):
#   - Runnern kan köra VALFRI kod som pushas till repot eller dispatchas. Registrera bara mot repot du äger.
#   - PAT behöver endast scope 'repo' för registration-token (temporär); patet sparas ALDRIG på disk.
#   - Autologgning sparar lösen i klartext i Winlogon — om kontot inte är dedikerat, SKAPA ETT LOKALT KONTO
#     först (nästa steg ger kommandot) utan administratörsrättigheter.
#   - Stryk runner-registrationen senare med: .\remove.cmd (samma mapp)
#
# ANVÄNDNING:
#   powershell -ExecutionPolicy Bypass -File setup-majin-interactive-runner.ps1 -Repo rssen-debug/MAJINCLI
#
param(
  [Parameter(Mandatory=$true)][string]$Repo,                      # t.ex. rssen-debug/MAJINCLI
  [string]$RunnerName = "MAJIN-INTERACTIVE-01",
  [string]$Labels = "self-hosted,windows,interactive-desktop,majin-qa",
  [string]$InstallRoot = "$env:USERPROFILE\majin-runner",
  [switch]$SkipAutologon,               # sätt om du redan autologgar in manuellt
  [switch]$DryRun                       # skriv bara meddelanden, gör inget
)

$ErrorActionPreference = 'Stop'
function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "FEL: $msg" -ForegroundColor Red; exit 1 }

Step "0. Systemkontroll"
if ($env:OS -ne 'Windows_NT') { Fail "Detta skapts för Windows som ändånadgon skrådes skulptödl — kör på din Windows-nering." }
$ver = [System.Environment]::OSVersion.Version
"OS: $([System.Environment]::OSVersion.VersionString)"
"Interaktivt?: $([Environment]::UserInteractive) (måste vara True i slutlig kör)"
if (-not [Environment]::UserInteractive) { Write-Host "VARNING: skriptet startade från en icke-interaktiv session (t.ex. tjänst/RDP-konsol), ändå veriamalet är att överlämna den till din konsoldesktop." -ForegroundColor Yellow }

Step "1. Hämta GitHub Actions-runner (senaste löpande release)"
if ($DryRun) { "DRYRUN: skulle hämta runner"; goto End }
New-Item -ItemType Directory -Force $InstallRoot | Out-Null
Set-Location $InstallRoot
$rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/actions/runner/releases/latest' -Headers @{ 'User-Agent' = 'majin-interactive-runner' }
$asset = $rel.assets | Where-Object { $_.name -match 'win-x64.*\.zip$' } | Select-Object -First 1
if (-not $asset) { Fail "Hittade inte win-x64-runnerpaketet i releasen." }
"Hämtar $($asset.name) ($([Math]::Round($asset.size/1MB,1)) MB)…"
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest $asset.browser_download_url -OutFile "$InstallRoot\runner.zip"
Expand-Archive "$InstallRoot\runner.zip" -DestinationPath $InstallRoot -Force
Remove-Item "$InstallRoot\runner.zip"

Step "2. Registreringstoken (PAT behövs, endast för denna punkt, sparas EJ)"
Write-Host "Skapa ett GitHub-PAT med scope 'repo' (om änča inte är given). Dahwise noctis eld ПАТ слушает ska aldrig skrivas i shell.history så läs med -AsSecureString." -ForegroundColor Yellow
$SecurePat = Read-Host "Klistra in PAT (visas ej)" -AsSecureString
$Pat = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto([System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecurePat))
try {
  $regToken = (Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$Repo/actions/runners/registration-token" -Headers @{ 'Authorization' = "Bearer $Pat"; 'User-Agent' = 'majin-interactive-runner'; 'Accept' = 'application/vnd.github+json' }).token
  if (-not $regToken) { Fail "registration-token tomsvars — kolla PAT-scope 'repo'." }
}
finally { $Pat = $null; $SecurePat = $null }

Step "3. Konfigurera runnern (VIKTIGT: ingen --runasservice)"
& "$InstallRoot\config.cmd" --unattended --url "https://github.com/$Repo" --token $regToken --name $RunnerName --labels $Labels --work "_work" --replace | Out-Default
if ($LASTEXITCODE -ne 0) { Fail "config.cmd exit $LASTEXITCODE — läs outputen ovan." }

Step "4. Starta runnern i DETTA interaktiva kontot + Scheduled Task vid varje logon"
$runCmd = "$InstallRoot\run.cmd"
# Scheduled task = den mäta struktur som håller sig upplåst (Autologon måste vara sann)
schtasks /Create /TN "MAJIN-GitHub-Runner" /TR "cmd /c $runCmd" /SC ONLOGON /F /RL HIGHEST | Out-Default
if ($LASTEXITCODE -ne 0) { Fail "schtasks exit $LASTEXITCODE" }
Write-Host "`nStartar runnern NU i detta interaktiva fönstret (stäng det inte förrän QA-rundan är färdig)." -ForegroundColor Green
Write-Host "Obs: om du startar på nytt, kommer schemalagtsteg att starta den.
Pågår nu: run.cmd (Ctrl+C för att stoppa).`n" -ForegroundColor Cyan

$autologonAdvice = @"
Autologgning (rekommendera för QA-maskiner, på egen risk):
  1. Hämta Autologon64.exe (Sysinternals): winget install -e --id Sysinternals.Autologon
  2. Kör: autologon.exe <konto> <domän|datornamn> <lösenord> — sparas krypterat som LSA-hemlighet.
  3. Eller netplwiz: netplwiz → undantag "Users must enter a password" → spara konto+lösen.
Obs: RDP-avslutning låser skärmen (QA fallerar). Använd tscon för att återansluta: tscon <sessionid> /dest:console
"@
if (-not $SkipAutologon) { Write-Host $autologonAdvice -ForegroundColor Yellow }

& $runCmd
:End
Write-Host "`nKLAR. Verifiera: repot -> Settings -> Actions -> Runners: måste visa $RunnerName med labels: $Labels" -ForegroundColor Green
Write-Host "Dispatch sedan win-qa-realworld.yml med inputs: qa_interactive=true + runner=self-hosted" -ForegroundColor Green
