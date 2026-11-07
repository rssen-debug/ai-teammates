param(
    [string]$CliRoot = "",
    [ValidateSet("", "opencode-go", "deepseek")][string]$Provider = "",
    [string]$ModelId = ""
)
$ErrorActionPreference = "Stop"
$nodeCommand = Get-Command node.exe -ErrorAction Stop
$gitCommand = Get-Command git.exe -ErrorAction Stop
$npmCommand = Get-Command npm.cmd -ErrorAction Stop
if (-not $CliRoot) {
    $installBase = Join-Path $env:LOCALAPPDATA "MAJIN"
    $CliRoot = Get-ChildItem -LiteralPath $installBase -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "cli-*" -and (Test-Path -LiteralPath (Join-Path $_.FullName "bin\majin-v5.mjs")) } |
        Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
    if (-not $CliRoot -and (Test-Path -LiteralPath "C:\MAJINCLI\bin\majin-v5.mjs")) { $CliRoot = "C:\MAJINCLI" }
}
if (-not $CliRoot) { throw "Hittar inte MAJINCLI. Ange -CliRoot med installationskatalogen." }
$CliRoot = [IO.Path]::GetFullPath($CliRoot)
if ($env:MAJIN_V5_DATA_DIR) { $majinData = [IO.Path]::GetFullPath($env:MAJIN_V5_DATA_DIR) }
elseif ($env:MAJIN_HOME) { $majinData = Join-Path $env:MAJIN_HOME "v5" }
else { $majinData = Join-Path $env:LOCALAPPDATA "MAJIN\v5" }
$previousData = $env:MAJIN_V5_DATA_DIR
$env:MAJIN_V5_DATA_DIR = $majinData
Push-Location $CliRoot
try {
    $branch = & $gitCommand.Source branch --show-current
    if ($LASTEXITCODE -ne 0 -or $branch.Trim() -ne "main") { throw "CLI-katalogen maste vara pa main. Ingen branch andrades." }
    $changes = & $gitCommand.Source status --porcelain --untracked-files=no
    if ($LASTEXITCODE -ne 0) { throw "Kunde inte kontrollera Git-status." }
    if ($changes) { throw "Lokala kodandringar finns. Spara dem innan uppdatering; inget har skrivits over." }
    & $gitCommand.Source pull --ff-only origin main
    if ($LASTEXITCODE -ne 0) { throw "Uppdateringen misslyckades." }
    & $npmCommand.Source ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "Installation av beroenden misslyckades." }
    $cliBin = Join-Path $CliRoot "bin\majin-v5.mjs"
    & $nodeCommand.Source $cliBin grants full --data-dir $majinData
    if ($LASTEXITCODE -ne 0) { throw "Full atkomst kunde inte sparas." }
    $stateJson = & $nodeCommand.Source $cliBin model status --data-dir $majinData --json
    if ($LASTEXITCODE -ne 0) { throw "Kunde inte lasa modellinstallningar." }
    $state = ($stateJson -join "`n") | ConvertFrom-Json
    if (-not $Provider) {
        $candidates = @($state.activeProvider, "opencode-go", "deepseek") | Select-Object -Unique
        $Provider = $candidates | Where-Object {
            $_ -in @("opencode-go", "deepseek") -and $state.providers.$_.hasKey
        } | Select-Object -First 1
    }
    if (-not $Provider -or -not $state.providers.$Provider.hasKey) {
        throw "Ingen sparad nyckel for OpenCode Go/DeepSeek hittades. Konfigurera leverantoren lokalt; skicka inte nyckeln i chatten."
    }
    $catalogJson = & $nodeCommand.Source $cliBin model verify --provider $Provider --data-dir $majinData --timeout-ms 30000 --json
    if ($LASTEXITCODE -ne 0) { throw "Kunde inte hamta modellistan fran $Provider." }
    $catalog = ($catalogJson -join "`n") | ConvertFrom-Json
    $models = @($catalog.discovery.models | Where-Object { $_ -match "deepseek" })
    if (-not $ModelId) {
        if ($state.activeProvider -eq $Provider -and $state.activeModelId -in $models) { $ModelId = $state.activeModelId }
        elseif ("deepseek-v4-pro" -in $models) { $ModelId = "deepseek-v4-pro" }
        else { $ModelId = $models | Select-Object -First 1 }
    }
    if (-not $ModelId -or $ModelId -notin $models) { throw "Den valda DeepSeek-modellen finns inte i leverantorens aktuella modellista." }
    Write-Host "Vald modell: $Provider/$ModelId" -ForegroundColor Cyan
    & $nodeCommand.Source $cliBin model select $ModelId --provider $Provider --require-discovered --data-dir $majinData
    if ($LASTEXITCODE -ne 0) { throw "Modellvalet misslyckades." }
    Write-Host "Testar CLI och webblasare mot lokala testformular..." -ForegroundColor Cyan
    & $nodeCommand.Source (Join-Path $CliRoot "scripts\v5\cli-browser-accept.mjs")
    if ($LASTEXITCODE -ne 0) { throw "CLI/webblasarprovet misslyckades. Las felet ovan." }
    Write-Host "Testar din sparade DeepSeek-modell med verkliga API-anrop..." -ForegroundColor Cyan
    & $nodeCommand.Source (Join-Path $CliRoot "scripts\v5\owner-cli-accept.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Liveprovet misslyckades. Ingen modell byttes ut; las felet ovan." }
    Write-Host "Proven passerade. Startar MAJIN med synlig webblasare." -ForegroundColor Green
    Write-Host "CLI: $CliRoot`nData: $majinData"
    & $nodeCommand.Source $cliBin chat --data-dir $majinData --browser-visible
}
finally {
    Pop-Location
    $env:MAJIN_V5_DATA_DIR = $previousData
}
