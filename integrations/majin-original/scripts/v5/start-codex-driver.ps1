param(
  [string]$Workspace = (Join-Path $PSScriptRoot '../../.codex-driver/workspace'),
  [string]$StateDir = (Join-Path $PSScriptRoot '../../.codex-driver/state'),
  [switch]$Register,
  [switch]$HostServer,
  [switch]$ProcessAccess,
  [switch]$Accept
)
$ErrorActionPreference = 'Stop'
$taskRepo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskNode = (Get-Command node -ErrorAction Stop).Source
$taskMcp = Join-Path $taskRepo 'bin/majin-codex-mcp.mjs'
if ($Accept) {
  & $taskNode (Join-Path $taskRepo 'scripts/v5/codex-accept.mjs') $Workspace
} elseif ($HostServer) {
  $taskExtra = @()
  if ($ProcessAccess) { $taskExtra += '--process' }
  & $taskNode (Join-Path $taskRepo 'bin/majin-codex-host.mjs') --workspace $Workspace --state-dir $StateDir --desktop --browser @taskExtra
} elseif ($Register) {
  $taskExtra = @()
  if ($ProcessAccess) { $taskExtra += '--process' }
  & codex mcp add majin -- $taskNode $taskMcp --workspace $Workspace --state-dir $StateDir --desktop --browser @taskExtra
} else {
  & $taskNode $taskMcp --workspace $Workspace --state-dir $StateDir --desktop --browser
}
exit $LASTEXITCODE
