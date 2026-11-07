<#
  MAJIN LIVE ACCEPTANCE RUN — the one-command package for the user's Windows machine.
  Produces real evidence files under docs/evidence/ so the 100/100 gate can close
  with receipts, never words.

  Usage:  powershell -File scripts/windows/live-acceptance-run.ps1

  Lanes:
    A) W11-live desktop eval (rename-file-dialog-win on REAL %TEMP% + screenshot contract)
    B) W2 DDG/Bing live research (full egress on this machine)
    C) W12 interactive pink-cursor evidence scaffold (template + steps; human observation required)

  Honest rules baked in:
    - Lane A 'manual-reference' rename is REAL file ops verified by the bench verifier —
      it is NOT agent credit. Agent credit requires the interactive agent lane (see guide).
    - Empty/absent evidence => failed lane, printed loudly. The script refuses to
      fabricate: every artifact it writes, it re-reads before counting.
    - Nothing containing credentials is written anywhere. The opencode key is only used
      in-memory by the agent session YOU start — this script never touches it.
#>
$ErrorActionPreference = 'Continue'
$stamp = Get-Date -Format 'yyyy-MM-dd'
$evo = Join-Path $PSScriptRoot "..\..\docs\evidence\live-run-$stamp"
$evo = [System.IO.Path]::GetFullPath($evo)
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
Push-Location $root
$summary = [ordered]@{ at = (Get-Date).ToString('o'); host = $env:COMPUTERNAME; lanes = [ordered]@{} }

function Say([string]$t) { Write-Host "[live-run] $t" }
function LaneResult([string]$lane, [bool]$ok, [string]$note) {
  $summary.lanes[$lane] = [ordered]@{ ok = $ok; note = $note }
  if ($ok) { Say "  [PASS] $lane — $note" } else { Say "  [FAIL] $lane — $note" }
}

Say "MAJIN live acceptance run $stamp on $env:COMPUTERNAME"

# ---------- preflight ----------
$nodeOk = $false
try {
  $nv = (node --version).TrimStart('v') -split '\.' 2>$null
  $nodeOk = ($null -ne $nv) -and ($nv.Count -gt 0) -and ([int]$nv[0] -ge 22)
} catch { $nodeOk = $false }
if (-not $nodeOk) { Say "FATAL: Node 22+ required (found node? $($null -ne (Get-Command node -ErrorAction SilentlyContinue)))"; Pop-Location; exit 1 }
if (-not (Test-Path 'package.json')) { Say "FATAL: run from the repository root (package.json not found)"; exit 1 }
if (-not (Test-Path 'node_modules')) { Say "node_modules missing — running npm ci first..."; npm ci --silent }

New-Item -ItemType Directory -Force -Path $evo | Out-Null
Say "evidence dir: $evo"

# ---------- Lane A: W11-live desktop eval ----------
Say "Lane A: W11-live desktop eval (real %TEMP%)"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\windows\desktop-eval-setup.ps1') 2>&1 | Out-File (Join-Path $evo 'laneA-setup.log')
# manual reference rename (NOT agent credit): real file ops, then the bench verifier measures the real file system
$doc = Join-Path $env:TEMP 'majin-eval-doc.txt'
$ren = Join-Path $env:TEMP 'majin-eval-renamed.txt'
$aNote = ''
try {
  if (Test-Path $ren) { Remove-Item $ren -Force }
  Rename-Item -LiteralPath $doc -NewName 'majin-eval-renamed.txt' -ErrorAction Stop
  $back = Get-Content -LiteralPath $ren -Raw
  if ($back -notlike '*majin-eval doc*') { throw 'read-back of renamed file failed' }
  $ver = node benchmark\desktop-tasks\rename-file-dialog-win\verify.mjs 2>&1
  $ver | Out-File (Join-Path $evo 'laneA-verifier.txt')
  if ($LASTEXITCODE -eq 0) { $aNote = "verifier PASS on real %TEMP% (manual-reference rename; agent credit remains interactive lane): $ver" } else { $aNote = "verifier exit $LASTEXITCODE : $ver" }
  LaneResult 'W11-manual-reference' ($LASTEXITCODE -eq 0) $aNote
  $summary.lanes['W11-agent-live'] = [ordered]@{ ok = $false; status = 'BLOCKED'; note = 'No autonomous agent desktop execution was observed by this script' }
} catch {
  LaneResult 'W11-manual-reference' $false "rename/verify failed: $($_.Exception.Message)"
  $summary.lanes['W11-agent-live'] = [ordered]@{ ok = $false; status = 'BLOCKED'; note = 'No autonomous agent desktop execution was observed by this script' }
}
node scripts\desktop-bench.mjs --save 2>&1 | Out-File (Join-Path $evo 'laneA-desktop-bench.log')
if ($LASTEXITCODE -eq 0) { Say "  desktop-bench re-verified on win32 (see laneA-desktop-bench.log)" }

# ---------- Lane B: W2 DDG/Bing live research ----------
Say "Lane B: W2 live research via duckduckgo/bing (this machine's egress)"
$researchOut = (Join-Path $evo 'laneB-research-ddgbing.json')
node src\cli\majin.js research "Which free MMLU benchmark suites ship verifiable tooling?" --json 2>&1 | Out-File $researchOut
$bRaw = Get-Content $researchOut -Raw
$bOk = ($LASTEXITCODE -eq 0) -and ($bRaw -match 'sources') -and ($bRaw -match '"ok":\s*true' -or $bRaw -match '"ok":true')
LaneResult 'W2-research-ddgbing' $bOk ($(if ($bOk) { 'research.run returned ok with real sources (see laneB-research-ddgbing.json)' } else { 'research.run failed or thin — check laneB-research-ddgbing.json' }))

# ---------- Lane C: W12 interactive scaffold ----------
Say "Lane C: W12 interactive pink-cursor evidence scaffold"
$checklist = Join-Path $evo 'w12-interactive-checklist.md'
@"
# W12 interactive acceptance — $stamp (host: $env:COMPUTERNAME)

Engine is verified (7/7 offline + WIN-CI A5 dry-plan). What remains is ONLY human
observation on a real interactive desktop. Each item below must be checked BY YOU
while watching the screen — a checked box without observed evidence is fabrication
and the CAP stays at 99 by design.

## steps
1. Start an agent session that has the computer.* tools:
   `$env:OPENCODE_KEY = 'oc_sk_...' ; node src/cli/majin.js` (REPL) — never paste the
   key anywhere it can be written to disk or chat.
2. Ask the agent: "move the pink cursor to 640,400 labelled 'W12-TEST'".
3. Observe on screen: a pink pointer bubble appears and sits at those coordinates.
4. Ask it to move again (e.g. 900,600); observe the overlay update.
5. Freeze a screenshot (Win+Shift+S), save it next to this file as `w12-pink-visual.png`.

## human checklist (tick only what you OBSERVED)
- [ ] overlay appeared visually (real pixels, topmost)
- [ ] move command actually moved the bubble to the new coordinates
- [ ] label text updated
- [ ] overlay never took over the mouse itself (input stayed yours)
- [ ] overlay closed on request (quit) without leftovers
- [ ] screenshot saved as w12-pink-visual.png next to this file

## commit to close the CAP
- [ ] this checklist (all boxes ticked from observed reality)
- [ ] w12-pink-visual.png
- [ ] laneA + laneB outputs from this same folder

Then: git add docs/evidence/live-run-$stamp docs/evidence/desktop-bench-$stamp.* ; git commit ; git push
"@ | Out-File $checklist -Encoding utf8
if ((Test-Path $checklist) -and ((Get-Content $checklist -Raw).Length -gt 400)) {
  LaneResult 'W12-scaffold' $true "PREPARED ONLY: checklist written; W12 interactive acceptance is NOT VERIFIED"
  $summary.lanes['W12-interactive'] = [ordered]@{ ok = $false; status = 'BLOCKED'; note = 'Requires independent visual observation and screenshot on interactive Windows desktop' }
} else {
  LaneResult 'W12-scaffold' $false "checklist template failed to write"
  $summary.lanes['W12-interactive'] = [ordered]@{ ok = $false; status = 'BLOCKED'; note = 'Checklist generation failed; interactive verification not performed' }
}

# ---------- summary ----------
$summary['release_ready'] = $false
$summary['release_blockers'] = @('W11-agent-live', 'W12-interactive')
$sumFile = Join-Path $evo 'RUN-SUMMARY.json'
($summary | ConvertTo-Json -Depth 6) | Out-File $sumFile -Encoding utf8
$readBack = $null
$SummOk = $false
try {
  $readBack = Get-Content $sumFile -Raw
  $SummOk = $readBack.Length -gt 80
} catch {}
if (-not $SummOk) { Say "FATAL: RUN-SUMMARY could not be read back"; exit 1 }
Say "RUN-SUMMARY: $sumFile"
Say "RELEASE GATE: BLOCKED until real interactive W12 visual evidence and agent-driven W11 evidence are independently verified."
Say "Scaffold PASS is preparation only, not release acceptance."
Say "Done. Open docs/LIVE-RUN-GUIDE.md, finish the interactive steps, then review evidence before committing."
Pop-Location
