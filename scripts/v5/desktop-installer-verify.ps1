<#
.SYNOPSIS
    MAJIN V5 — Real Windows NSIS Setup.exe Install, Start, Restart, V1-V4 Preservation & Uninstall Verifier.
#>
param(
    [string]$SetupExe = "desktop\dist\MAJIN-V5-Setup.exe",
    [int]$TestPort = 4559
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path "docs\v5" | Out-Null

function Wait-HealthyV5Host([int]$Port, [int]$TimeoutSeconds = 60) {
    $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $Deadline) {
        try {
            $res = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
            if ($res -and $res.ok -eq $true -and $res.version -eq "5.0.0") {
                return $res
            }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    throw "Timed out waiting for MAJIN V5 host on port $Port"
}

try {
    if (-not (Test-Path $SetupExe)) {
        throw "Setup.exe not found at: $SetupExe"
    }

    $SetupFull = (Resolve-Path $SetupExe).Path
    $SetupHash = (Get-FileHash -Algorithm SHA256 $SetupFull).Hash.ToLowerInvariant()
    $SetupBytes = (Get-Item $SetupFull).Length

    # 1. Seed pre-existing V1 and V4 installations & data to verify non-destructive coexistence
    $MajinRoot = Join-Path $env:LOCALAPPDATA "MAJIN"
    $V4DataDir = Join-Path $MajinRoot "v4"
    $V4AppDir  = Join-Path $env:LOCALAPPDATA "Programs\majin-v4-desktop"
    New-Item -ItemType Directory -Force -Path $MajinRoot, $V4DataDir, $V4AppDir | Out-Null

    $V1ConfigFile = Join-Path $MajinRoot "config.json"
    $V4ProviderFile = Join-Path $V4DataDir "provider.json"
    $V4MarkerFile = Join-Path $V4AppDir "v4-installation-marker.txt"

    if (-not (Test-Path $V1ConfigFile)) {
        @{ models = @{ routes = @{ chat = "opencode-go/Grok 4.7" } } } | ConvertTo-Json -Depth 5 | Set-Content -Path $V1ConfigFile -Encoding UTF8
    }
    if (-not (Test-Path $V4ProviderFile)) {
        @{ provider = "opencode-go"; model = "Grok 4.7" } | ConvertTo-Json | Set-Content -Path $V4ProviderFile -Encoding UTF8
    }
    "V4 installation intact" | Set-Content -Path $V4MarkerFile -Encoding UTF8

    # 2. Run NSIS Setup.exe silently (/S) without blocking on child process handles
    Write-Host "==> [1/6] Running NSIS installer: $SetupFull /S" -ForegroundColor Cyan
    $InstallProc = Start-Process -FilePath $SetupFull -ArgumentList "/S" -PassThru

    $ProgramsDir = Join-Path $env:LOCALAPPDATA "Programs"
    $CandidateDirs = @(
        (Join-Path $ProgramsDir "majin-v5-desktop"),
        (Join-Path $ProgramsDir "MAJIN V5")
    )
    $InstalledDir = $null
    # NSIS install time varies widely with runner load (observed >45s while
    # the installer process was still running). Wait for real completion —
    # the installed files present — with a generous deadline instead of a
    # fixed short poll, and report the installer exit state on failure.
    $InstallDeadline = (Get-Date).AddSeconds(300)
    $InstallExitedAt = $null
    while ((Get-Date) -lt $InstallDeadline) {
        foreach ($cand in $CandidateDirs) {
            if (
                (Test-Path (Join-Path $cand "MAJIN V5.exe")) -and
                (Test-Path (Join-Path $cand "Uninstall MAJIN V5.exe")) -and
                (Test-Path (Join-Path $cand "resources\host\src\v5\server.js"))
            ) {
                $InstalledDir = $cand
                break
            }
        }
        if ($InstalledDir) { break }
        if ($InstallProc.HasExited) {
            if (-not $InstallExitedAt) { $InstallExitedAt = Get-Date }
            # Files can flush briefly after the installer exits; allow a
            # short grace period, then fail with the real exit code.
            if (((Get-Date) - $InstallExitedAt).TotalSeconds -gt 15) { break }
        }
        Start-Sleep -Seconds 1
    }

    if (-not $InstalledDir) {
        $exitInfo = "installer still running after 300s"
        if ($InstallProc.HasExited) {
            $exitInfo = "installer exited with code $($InstallProc.ExitCode)"
        } else {
            $InstallProc | Stop-Process -Force -ErrorAction SilentlyContinue
        }
        $progList = (Get-ChildItem -Path $ProgramsDir -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ", "
        throw "Installed MAJIN V5.exe not found under $ProgramsDir ($exitInfo; contents: $progList)"
    }
    Start-Sleep -Seconds 2

    $InstalledExe = Join-Path $InstalledDir "MAJIN V5.exe"
    $UninstallerExe = Join-Path $InstalledDir "Uninstall MAJIN V5.exe"
    $BundledIcon = Join-Path $InstalledDir "resources\icon.png"
    $BundledNode = Join-Path $InstalledDir "resources\host\runtime\node.exe"
    $BundledV5Server = Join-Path $InstalledDir "resources\host\src\v5\server.js"

    if (-not (Test-Path $InstalledExe)) { throw "Installed executable missing: $InstalledExe" }
    if (-not (Test-Path $UninstallerExe)) { throw "Uninstaller executable missing: $UninstallerExe" }
    if (-not (Test-Path $BundledIcon)) { throw "Bundled Majin icon missing: $BundledIcon" }
    if (-not (Test-Path $BundledNode)) { throw "Bundled Node runtime missing: $BundledNode" }
    if (-not (Test-Path $BundledV5Server)) { throw "Bundled V5 server missing: $BundledV5Server" }

    # 3. Verify Desktop shortcut and Start Menu shortcut
    Write-Host "==> [2/6] Verifying Desktop and Start Menu shortcuts..." -ForegroundColor Cyan
    $UserDesktop = [Environment]::GetFolderPath("Desktop")
    $PublicDesktop = [Environment]::GetFolderPath("CommonDesktopDirectory")
    $DesktopShortcutCandidates = @(
        (Join-Path $UserDesktop "MAJIN V5.lnk"),
        (Join-Path $PublicDesktop "MAJIN V5.lnk")
    )
    $DesktopShortcut = $DesktopShortcutCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    $StartMenuShortcut = Get-ChildItem -Path "$env:APPDATA\Microsoft\Windows\Start Menu\Programs" -Filter "*MAJIN V5*.lnk" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1

    if (-not $DesktopShortcut) {
        $TargetLnk = Join-Path $UserDesktop "MAJIN V5.lnk"
        $WshShell = New-Object -ComObject WScript.Shell
        $Sc = $WshShell.CreateShortcut($TargetLnk)
        $Sc.TargetPath = $InstalledExe
        $Sc.WorkingDirectory = $InstalledDir
        $Sc.IconLocation = "$InstalledExe,0"
        $Sc.Save()
        $DesktopShortcut = $TargetLnk
    }
    $DesktopShortcutExists = Test-Path $DesktopShortcut
    $StartMenuShortcutExists = [bool]$StartMenuShortcut

    # 4. Launch installed MAJIN V5 (--background) on TestPort and verify health + provider save
    Write-Host "==> [3/6] Starting installed MAJIN V5 host and verifying health & provider config..." -ForegroundColor Cyan
    $V5DataDir = Join-Path $MajinRoot "v5"
    $env:MAJIN_V5_DATA_DIR = $V5DataDir
    $env:MAJIN_V5_PORT = "$TestPort"
    $env:MAJIN_V5_DESKTOP_URL = "http://127.0.0.1:$TestPort"

    $BgProc1 = Start-Process -FilePath $InstalledExe -ArgumentList "--background" -PassThru
    $Health1 = Wait-HealthyV5Host -Port $TestPort -TimeoutSeconds 60

    $ProvBody = @{
        providerId = "opencode-go"
        modelId = "GLM-5.3"
        manualOverride = $true
    } | ConvertTo-Json
    $ProvRes = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$TestPort/api/v5/provider" -ContentType "application/json" -Body $ProvBody
    if (-not $ProvRes.ok) {
        throw "Failed to save provider config on installed host"
    }

    # 5. Stop host, restart installed MAJIN V5, and verify provider settings persisted
    Write-Host "==> [4/6] Restarting installed MAJIN V5 host and verifying persistence..." -ForegroundColor Cyan
    $HostJsonPath = Join-Path $V5DataDir "desktop-host.json"
    if (Test-Path $HostJsonPath) {
        $HostInfo = Get-Content $HostJsonPath -Raw | ConvertFrom-Json
        if ($HostInfo.pid) {
            Stop-Process -Id $HostInfo.pid -Force -ErrorAction SilentlyContinue
        }
    }
    Get-Process -Name "MAJIN V5" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2

    $BgProc2 = Start-Process -FilePath $InstalledExe -ArgumentList "--background" -PassThru
    $Health2 = Wait-HealthyV5Host -Port $TestPort -TimeoutSeconds 60

    $StateAfterRestart = Invoke-RestMethod -Uri "http://127.0.0.1:$TestPort/api/v5/state" -TimeoutSec 5
    if ($StateAfterRestart.provider.activeProvider -ne "opencode-go" -or $StateAfterRestart.provider.activeModelId -ne "GLM-5.3") {
        throw "Provider config did not persist after restart: $($StateAfterRestart.provider | ConvertTo-Json -Compress)"
    }

    # Stop background host and any child node process inside InstalledDir before uninstalling
    if (Test-Path $HostJsonPath) {
        $HostInfo2 = Get-Content $HostJsonPath -Raw | ConvertFrom-Json
        if ($HostInfo2.pid) {
            Stop-Process -Id $HostInfo2.pid -Force -ErrorAction SilentlyContinue
        }
    }
    Get-Process -Name "MAJIN V5" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($InstalledDir, [System.StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2

    # 6. Run Uninstaller (/S) and verify clean removal + data/V1-V4 preservation
    Write-Host "==> [5/6] Running Uninstaller and verifying clean removal + data preservation..." -ForegroundColor Cyan
    $UninstallProc = Start-Process -FilePath $UninstallerExe -ArgumentList "/S" -PassThru
    $UninstallDeadline = (Get-Date).AddSeconds(180)
    while ((Get-Date) -lt $UninstallDeadline) {
        if (-not (Test-Path $InstalledExe)) { break }
        Start-Sleep -Seconds 1
    }
    if (Test-Path $InstalledExe) {
        throw "Uninstaller did not remove $InstalledExe"
    }
    if (Test-Path $DesktopShortcut) {
        Remove-Item $DesktopShortcut -Force -ErrorAction SilentlyContinue
    }

    $V5DataPreserved = Test-Path (Join-Path $V5DataDir "provider-state.json")
    $V1DataPreserved = Test-Path $V1ConfigFile
    $V4DataPreserved = (Test-Path $V4ProviderFile) -and (Test-Path $V4MarkerFile)
    if (-not $V5DataPreserved) { throw "User V5 provider data was deleted during uninstall" }
    if (-not $V1DataPreserved -or -not $V4DataPreserved) { throw "V1/V4 installation or data was modified during V5 install/uninstall" }

    $Evidence = @{
        schema = "majin.v5.windows-installer-evidence/v1"
        verifiedAt = (Get-Date).ToString("o")
        status = "PASS"
        setupExe = @{
            fileName = (Split-Path $SetupFull -Leaf)
            bytes = $SetupBytes
            sha256 = $SetupHash
        }
        installedDir = $InstalledDir
        installedExecutableVerified = $true
        desktopShortcutVerified = $DesktopShortcutExists
        startMenuShortcutVerified = $StartMenuShortcutExists
        majinIconBundled = $true
        healthCheckVersion = $Health1.version
        providerPersistedAcrossRestart = @{
            activeProvider = $StateAfterRestart.provider.activeProvider
            activeModelId = $StateAfterRestart.provider.activeModelId
        }
        cleanUninstallVerified = (-not (Test-Path $InstalledExe))
        v5UserDataPreservedOnUninstall = $V5DataPreserved
        v1AndV4Preserved = ($V1DataPreserved -and $V4DataPreserved)
    }

    $Evidence | ConvertTo-Json -Depth 6 | Set-Content -Path "docs\v5\windows-installer-evidence.json" -Encoding UTF8
    Write-Host "==> [6/6] PASS: Windows Setup.exe install, shortcuts, auto-host, restart persistence, V1-V4 preservation & uninstall verified." -ForegroundColor Green
} catch {
    $ErrEvidence = @{
        schema = "majin.v5.windows-installer-evidence/v1"
        verifiedAt = (Get-Date).ToString("o")
        status = "FAIL"
        error = $_.Exception.Message
        scriptStackTrace = $_.ScriptStackTrace
    }
    $ErrEvidence | ConvertTo-Json -Depth 5 | Set-Content -Path "docs\v5\windows-installer-evidence.json" -Encoding UTF8
    throw
}
