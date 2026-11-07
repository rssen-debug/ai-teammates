# MAJIN local pre-CI verification (ASCII only on purpose: this file must survive
# any encoding round-trip on Windows PowerShell 5.1 without mangling).
#
# Purpose: run the exact checks of .github/workflows/majin-owner-interactive-desktop.yml
# LOCALLY before pushing, so the self-hosted runner only sees code that is already
# green. Requires: run in an INTERACTIVE session on the MAJIN machine.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\qa\precheck-interactive-desktop.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\qa\precheck-interactive-desktop.ps1 -Live
#
# -Live additionally runs scripts/qa/owner-desktop-live.mjs (synthetic QA window,
# pink overlay pixels, OpenCode Go planner). Needs $env:OPENCODE_API_KEY set.
# Exit code 0 = everything that ran has passed.

[CmdletBinding()]
param(
  [switch]$Live
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $repoRoot

$results = [System.Collections.Generic.List[object]]::new()
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

function Add-Result([string]$Name, [string]$Status, [string]$Detail) {
  $results.Add([pscustomobject]@{ Step = $Name; Status = $Status; Detail = $Detail })
  Write-Host "[$Status] $Name - $Detail"
}

# --- Step 1: interactive session preflight probe (read-only, same as CI) ------
function Invoke-Preflight {
  Add-Type -AssemblyName System.Windows.Forms
  $sessionId = (Get-Process -Id $PID).SessionId
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $interactive = [Environment]::UserInteractive
  $ok = $interactive -and ($sessionId -gt 0) -and ($bounds.Width -ge 600) -and ($bounds.Height -ge 400)
  $detail = "interactive=$interactive sessionId=$sessionId screen=$($bounds.Width)x$($bounds.Height)"
  Add-Result -Name 'interactive-session-preflight' -Status ($(if ($ok) { 'PASS' } else { 'FAIL' })) -Detail $detail
  return $ok
}

# --- Step 2: node --check on the computer tool (same as CI) -------------------
function Invoke-SyntaxCheck {
  node --check src/core/tools/computer.js
  if ($LASTEXITCODE -eq 0) { Add-Result 'node-check computer.js' 'PASS' 'syntax ok' ; return $true }
  Add-Result 'node-check computer.js' 'FAIL' 'node --check exit ' + $LASTEXITCODE ; return $false
}

# --- Step 3: contract tests (exact same files as CI) --------------------------
function Invoke-ContractTests {
  if (-not (Test-Path 'node_modules')) {
    Add-Result 'contract-tests' 'SKIP' 'node_modules missing - run npm ci first'
    return $false
  }
  node --test test/computer-use-live-contract.test.js test/computer-use.test.js test/wincontrol.test.js *>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { Add-Result 'contract-tests' 'PASS' 'computer-use + wincontrol contracts green' ; return $true }
  Add-Result 'contract-tests' 'FAIL' 'node --test exit ' + $LASTEXITCODE ; return $false
}

# --- Step 4 (optional): the real live desktop QA (same script as CI) ----------
function Invoke-LiveDesktopQa {
  if (-not $Live) {
    Add-Result 'owner-desktop-live' 'SKIP' 'run with -Live to include synthetic-window + pink-pixel QA'
    return $true
  }
  if ([string]::IsNullOrWhiteSpace($env:OPENCODE_API_KEY)) {
    Add-Result 'owner-desktop-live' 'SKIP' 'OPENCODE_API_KEY not set in this session'
    return $true
  }
  $env:MAJIN_LLM_TIMEOUT = '45000'
  node scripts/qa/owner-desktop-live.mjs
  if ($LASTEXITCODE -eq 0) { Add-Result 'owner-desktop-live' 'PASS' 'real desktop QA green' ; return $true }
  Add-Result 'owner-desktop-live' 'FAIL' 'scripts/qa/owner-desktop-live.mjs exit ' + $LASTEXITCODE ; return $false
}

$ok = $true
$ok = (Invoke-Preflight) -and $ok
$ok = (Invoke-SyntaxCheck) -and $ok
$ok = (Invoke-ContractTests) -and $ok
$ok = (Invoke-LiveDesktopQa) -and $ok
$stopwatch.Stop()

Write-Host ''
Write-Host ('=== LOCAL PRE-CI SUMMARY (' + [int]$stopwatch.Elapsed.TotalSeconds + 's) ===')
foreach ($r in $results) { Write-Host (" {0,-5} {1,-30} {2}" -f $r.Status, $r.Step, $r.Detail) }
if ($ok) {
  Write-Host 'VERDICT: PASS - safe to push; the self-hosted runner should now see the same green result.'
  exit 0
}
Write-Host 'VERDICT: FAIL - fix locally before pushing; this is exactly what CI will reject.'
exit 1
