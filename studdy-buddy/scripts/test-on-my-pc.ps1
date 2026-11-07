<#
  test-on-my-pc.ps1 — installerar och bevisar Studdy Buddy på DIN Windows-dator.

  Inget här gissar. Varje steg skriver ut vad det faktiskt svarade, och
  sammanfattningen byggs av de riktiga svaren — inte av förhoppningar.

  Kör (PowerShell, ingen admin krävs):

      powershell -ExecutionPolicy Bypass -File .\test-on-my-pc.ps1

  Flaggor:
      -SkipInstall   installera inte om, testa versionen som redan finns
      -Screen        ta en riktig skärmbild som bevis
      -NoPause       stäng inte fönstret i slutet
      -NoVoice       hoppa över röststegen (om du inte vill ha ljud just nu)
#>
[CmdletBinding()]
param(
  [switch]$SkipInstall,
  [switch]$Screen,
  [switch]$NoPause,
  [switch]$NoVoice
)

$ErrorActionPreference = 'Continue'
$ProgressPreference   = 'SilentlyContinue'   # annars blir nedladdningar löjligt långsamma

# ------------------------------------------------------------------ rapport
$stamp     = Get-Date -Format 'yyyyMMdd-HHmmss'
$reportDir = Join-Path $env:USERPROFILE "studdy-rapport\$stamp"
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$reportFile = Join-Path $reportDir 'rapport.txt'
$results    = New-Object System.Collections.ArrayList
$tmp        = Join-Path $reportDir 'tmp'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

function Say  ($m) { Write-Host $m }
function Head ($m) { Write-Host ''; Write-Host ("=== $m " + ('=' * [Math]::Max(0, 58 - $m.Length))) -ForegroundColor DarkGray }

# Kör en extern process, fånga stdout och stderr, få RIKTIG exitkod.
function Run-Step {
  param([string]$Name, [string]$Exe, [string[]]$Args, [switch]$Quiet, [int]$TimeoutSec = 180)
  Head $Name
  $o = Join-Path $tmp 'out.txt'; $e = Join-Path $tmp 'err.txt'
  $code = -1
  try {
    $p = Start-Process -FilePath $Exe -ArgumentList $Args -NoNewWindow -PassThru `
         -RedirectStandardOutput $o -RedirectStandardError $e -ErrorAction Stop
    # WaitForExit(int) finns i både Windows PowerShell 5.1 och PowerShell 7.
    # Start-Process -TimeoutSec finns bara i 7, så den får inte användas här.
    if (-not $p.WaitForExit($TimeoutSec * 1000)) {
      try { $p.Kill() } catch { }
      Set-Content -Path $o -Value "TIMEOUT efter $TimeoutSec s" -Encoding UTF8
      $code = 124
    } else {
      $p.WaitForExit()   # låt omdirigerade strömmar bli klara
      $code = $p.ExitCode
    }
  } catch {
    Set-Content -Path $o -Value "KUNDE INTE KÖRAS: $($_.Exception.Message)" -Encoding UTF8
    $code = 127
  }
  $stdout = if (Test-Path $o) { (Get-Content $o -Raw -ErrorAction SilentlyContinue) } else { '' }
  $stderr = if (Test-Path $e) { (Get-Content $e -Raw -ErrorAction SilentlyContinue) } else { '' }
  $combined = (@($stdout, $stderr) -join "`n").Trim()
  if (-not $Quiet -and $combined) { Write-Host $combined }
  [void]$results.Add([pscustomobject]@{ Step = $Name; Exit = $code; Output = $combined })
  return [pscustomobject]@{ Exit = $code; Output = $combined }
}

# Läs JSON ur utdata utan att krascha på färgkod eller skräp runtom.
function As-Json ($text) {
  if (-not $text) { return $null }
  $esc = [char]27
  $clean = $text -replace "$esc\[[0-9;]*m", ''
  $start = $clean.IndexOf('{')
  if ($start -lt 0) { return $null }
  try { return ($clean.Substring($start) | ConvertFrom-Json) } catch { return $null }
}

Say ''
Say '  Studdy Buddy — test på din dator'
Say "  Rapport sparas i: $reportDir"

# ------------------------------------------------------------------ 0. miljö
Head '0. Miljö'
$osDesc = (Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).Caption
if (-not $osDesc) { $osDesc = [System.Environment]::OSVersion.VersionString }
Say "  Windows    : $osDesc"
Say "  PowerShell : $($PSVersionTable.PSVersion)"

$nodeOk = $false; $nodeVer = 'SAKNAS'
try {
  $nodeVer = (& node --version 2>&1 | Out-String).Trim()
  if ($nodeVer -match '^v(\d+)\.') {
    $nodeOk = [int]$Matches[1] -ge 22
  }
} catch { }
Say ("  Node       : {0}  {1}" -f $nodeVer, $(if ($nodeOk) { 'OK (>=22)' } else { 'kräver >=22.13' }))

if ($env:OS -ne 'Windows_NT') {
  Say '  Det här skriptet är för Windows. Kör det i PowerShell på din PC.' -ForegroundColor Red
  if (-not $NoPause) { Read-Host 'Tryck Enter för att stänga' | Out-Null }
  exit 2
}
if (-not $nodeOk) {
  Say ''
  Say '  Node 22+ krävs. Kör ett av dessa och sedan om skriptet:' -ForegroundColor Yellow
  Say '    winget install OpenJS.NodeJS.LTS'
  Say '    eller hämta från https://nodejs.org'
  Say ''
  Say '  Avbryter — utan Node går inget att bevisa.' -ForegroundColor Yellow
  if (-not $NoPause) { Read-Host 'Tryck Enter för att stänga' | Out-Null }
  exit 2
}

# ------------------------------------------------------------------ 1. release
Head '1. Senaste release'
$tag = $null; $url = $null; $name = $null
try {
  $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/rssen-debug/ai-teammates/releases/latest' `
         -Headers @{ 'User-Agent' = 'studdy-test-script' } -TimeoutSec 30
  $tag   = $rel.tag_name
  $asset = $rel.assets | Where-Object { $_.name -like '*.tgz' } | Select-Object -First 1
  if ($asset) { $url = $asset.browser_download_url; $name = $asset.name }
} catch {
  Say "  Kunde inte fråga GitHub: $($_.Exception.Message)" -ForegroundColor Yellow
}
if (-not $url) {
  Say '  Hittade inget .tgz i senaste release — avbryter.' -ForegroundColor Red
  if (-not $NoPause) { Read-Host 'Tryck Enter för att stänga' | Out-Null }
  exit 1
}
Say "  Release : $tag"
Say "  Paket   : $name"

# ------------------------------------------------------------------ 2. install
if ($SkipInstall) {
  Head '2. Installation (hoppas över)'
  Say '  -SkipInstall angavs.'
} else {
  Run-Step -Name 'npm install -g' -Exe 'npm' `
    -Args @('install','-g',$url,'--no-audit','--no-fund','--loglevel=error') -TimeoutSec 300 | Out-Null
}

# npm:s globala prefix ligger inte alltid i PATH i den här processen än.
$npmPrefix = ''
try { $npmPrefix = (& npm prefix -g 2>&1 | Out-String).Trim() } catch { }
if ($npmPrefix -and $env:PATH -notlike "*$npmPrefix*") {
  $env:PATH = "$npmPrefix;$env:PATH"
  Say "  Lade till npm-prefix i PATH för denna session: $npmPrefix"
}
$cmd = Get-Command studdy -ErrorAction SilentlyContinue
if (-not $cmd) {
  Say ''
  Say '  Hittar inte studdy i PATH.' -ForegroundColor Red
  Say '  Stäng fönstret, öppna ett NYTT PowerShell och kör skriptet igen.' -ForegroundColor Yellow
  Say "  Eller kör direkt: node `"$npmPrefix\node_modules\studdy-buddy\dist\cli\studdy.mjs`" status" -ForegroundColor Yellow
  $results | ForEach-Object { "`n### $($_.Step) (exit $($_.Exit))`n$($_.Output)" } | Add-Content -Path $reportFile -Encoding UTF8
  if (-not $NoPause) { Read-Host 'Tryck Enter för att stänga' | Out-Null }
  exit 1
}
Say "  studdy  : $($cmd.Source)"

# ------------------------------------------------------------------ 3. version
$ver = Run-Step -Name 'studdy --version' -Exe 'studdy' -Args @('--version')
$verOk = ($ver.Exit -eq 0 -and $ver.Output -match '\d+\.\d+\.\d+')

# ------------------------------------------------------------------ 4. setup
# Beviljar full åtkomst inne i appen. OS-behörigheter kan ett skript inte ge —
# rapporten visar vad appen svarar om dem, ordagrant.
Run-Step -Name 'studdy setup' -Exe 'studdy' -Args @('setup') | Out-Null

# ------------------------------------------------------------------ 5. doctor
$doctor = Run-Step -Name 'studdy doctor' -Exe 'studdy' -Args @('doctor') -Quiet
Say $doctor.Output

# ------------------------------------------------------------------ 6. behörigheter
Head '6. Behörigheter — vad appen faktiskt har beviljat'
$accessOut = ''
try {
  $accessOut = ((@('/access','/exit') -join "`n") | & studdy repl 2>&1 | Out-String)
  Write-Host $accessOut.Trim()
} catch {
  Say "  Kunde inte läsa behörigheter: $($_.Exception.Message)" -ForegroundColor Yellow
}
$granted = ([regex]::Matches($accessOut, '●\s+([a-z][a-z.]+)')).Count
$denied  = ([regex]::Matches($accessOut, '○\s+([a-z][a-z.]+)')).Count
Say "  Beviljade: $granted   Nekade: $denied"

# ------------------------------------------------------------------ 7. fönster
$winJson = Run-Step -Name 'studdy windows --json' -Exe 'studdy' -Args @('windows','--json') -Quiet
$winData = As-Json $winJson.Output
$winList = @()
if ($winData -and $winData.windows) { $winList = @($winData.windows) }
$winError = if ($winData) { $winData.error } else { $null }
Say ("  Fönster hittade : {0}" -f $winList.Count)
Say ("  Fel/svar        : {0}" -f $(if ($winError) { $winError } else { 'inget' }))
$winList | Select-Object -First 8 | ForEach-Object { Say ("    - {0}  [{1}]  id={2}" -f $_.title, $_.processName, $_.id) }

# ------------------------------------------------------------------ 8. live-bevis
Head '8. Live-bevis — starta, läs och skriv i en riktig app'
$proveOk = $false; $proveApp = $null; $proveOut = ''
foreach ($candidate in @('Notepad','Anteckningar')) {
  $p = Run-Step -Name "studdy prove --app `"$candidate`"" -Exe 'studdy' -Args @('prove','--app',$candidate,'--no-write') -TimeoutSec 180 -Quiet
  $proveOut = $p.Output
  Say $proveOut
  if ($p.Output -match 'Live verifierat med riktiga verktygssvar') { $proveOk = $true; $proveApp = $candidate; break }
}
if (-not $proveOk) { Say '  Inget appnamn gav ett verifierat live-bevis — se raderna ovan.' -ForegroundColor Yellow }

# ------------------------------------------------------------------ 9. skärmbild
if ($Screen) {
  Head '9. Skärmbild som bevis'
  $targetId = if ($winList.Count -gt 0) { [string]$winList[0].id } else { '' }
  if ($targetId) {
    $shot = Join-Path $reportDir 'skarm-app.png'
    $sh = Run-Step -Name "studdy screenshot $targetId" -Exe 'studdy' -Args @('screenshot',$targetId,$shot) -Quiet
    Say $sh.Output
  } else {
    Say '  Inget window-id att fota — hoppar över appens bild.' -ForegroundColor Yellow
  }
  # Oberoende bild via .NET: bevisar att skärmen är läsbar, oavsett appen
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b   = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $dotnetShot = Join-Path $reportDir 'skarm-dotnet.png'
    $bmp.Save($dotnetShot, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    $fi = Get-Item $dotnetShot
    Say ("  Sparad: {0} ({1} kB)" -f $fi.FullName, [math]::Round($fi.Length / 1KB))
  } catch {
    Say "  .NET-skärmbild misslyckades: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

# ------------------------------------------------------------------ 10. röst
$voiceSynthOk = $false; $voicePlayOk = $false; $voiceDetail = 'hoppades över'
if (-not $NoVoice) {
  Head '10. Röst — bevisa att den syntetiserar'
  $vc = Run-Step -Name 'studdy voice-check' -Exe 'studdy' -Args @('voice-check') -Quiet -TimeoutSec 120
  Say $vc.Output
  $vj = As-Json $vc.Output
  $voiceSynthOk = [bool]($vj -and $vj.ok -eq $true -and [int]$vj.bytes -gt 0)
  $voiceDetail  = if ($vj) { "voice=$($vj.voice) bytes=$($vj.bytes) ms=$($vj.ms)" } else { 'inget JSON-svar' }

  Head '10b. Hörs den i högtalarna?'
  $sp = Run-Step -Name 'studdy voice' -Exe 'studdy' `
        -Args @('voice','Hej, det här är Buddy som talar med naturlig röst på din dator.') -Quiet -TimeoutSec 120
  Say $sp.Output
  $sj = As-Json $sp.Output
  $voicePlayOk = [bool]($sj -and $sj.ok -eq $true)
  if ($sj) {
    Say ("  Motor: {0}" -f $sj.engine)
    if ($sj.fallenBackBecause) { Say ("  Föll tillbaka för att: {0}" -f $sj.fallenBackBecause) -ForegroundColor Yellow }
  }
}

# ------------------------------------------------------------------ sammanfattning
Head 'Sammanfattning — byggd på svaren ovan'
function Verdict ($label, $ok, $detail) {
  Write-Host ("  [{0}] {1,-24} {2}" -f $(if ($ok) { 'JA ' } else { 'NEJ' }), $label, $detail) `
    -ForegroundColor $(if ($ok) { 'Green' } else { 'Red' })
}
Verdict 'Installerad'            $verOk         (($ver.Output -replace '\s+',' ').Trim())
Verdict 'App-behörigheter'       ($granted -gt 0) "$granted beviljade, $denied nekade"
Verdict 'Fönster synliga'        ($winList.Count -gt 0 -and -not $winError) "$($winList.Count) fönster, fel: $winError"
Verdict 'Live datorstyrning'     $proveOk       $(if ($proveOk) { "verifierat med $proveApp" } else { 'inget verifierat — se steg 8' })
if (-not $NoVoice) {
  Verdict 'Röst syntetiserar'     $voiceSynthOk  $voiceDetail
  Verdict 'Röst spelades upp'     $voicePlayOk   $(if ($voicePlayOk) { 'spelaren svarade ok' } else { 'spelaren svarade fel — se steg 10b' })
}
Say ''
Say '  Vad detta INTE bevisar:'
Say '   - Att agenten ser ALLT: lösenordsfält, bank och incognito filtreras medvetet bort.'
Say '   - Att köp/betalningar går igenom: de kräver din bekräftelse varje gång.'
Say '   - Att Windows-tillgänglighet är på: det är en OS-inställning — se raden Native helper i doctor.'

# ------------------------------------------------------------------ spara
@(
  'Studdy Buddy — testrapport',
  "Tid     : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
  "Dator   : $env:COMPUTERNAME",
  "Windows : $osDesc",
  "Release : $tag",
  "Paket   : $name",
  '',
  'Sammanfattning:',
  "  Installerad        : $verOk  $(($ver.Output -replace '\s+',' ').Trim())",
  "  Behörigheter       : $granted beviljade / $denied nekade",
  "  Fönster            : $($winList.Count) (fel: $winError)",
  "  Live datorstyrning : $proveOk $(if ($proveApp) { "($proveApp)" })",
  "  Röst syntetiserar  : $voiceSynthOk $voiceDetail",
  "  Röst spelades upp  : $voicePlayOk"
) | Set-Content -Path $reportFile -Encoding UTF8
$results | ForEach-Object { "`n### $($_.Step) (exit $($_.Exit))`n$($_.Output)" } | Add-Content -Path $reportFile -Encoding UTF8

Say ''
Say "  Full rapport: $reportFile" -ForegroundColor Cyan
Say '  Skicka rapporten till mig — då vet vi exakt vad som fungerar hos dig.'
try { Start-Process notepad.exe $reportFile } catch { }

if (-not $NoPause) { Read-Host 'Tryck Enter för att stänga' | Out-Null }
