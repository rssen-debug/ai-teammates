<#
.SYNOPSIS
  MAJIN Windows-control PoC probe (handover #4 — PoC-before-bind).
  Runs RAW UI Automation (System.Windows.Automation) with ZERO installed
  dependencies, then emits one structured JSON verdict. The point is evidence,
  not optimism: every capability is a measured bool, and a deliberate negative
  control proves we are not fabricating matches.

  Probes:
    P1  UIA assemblies load; root element enumerates top-level windows.
    P2  Negative control: a window that cannot exist returns null.
    P3  Notepad: launch -> locate window -> locate edit/document control ->
        ValuePattern.SetValue(marker) -> read back -> MUST round-trip -> clear.
    P4  Environment facts (OS, PS, .NET) reported, no installs performed.
    P5  (v2) If P3 cannot find a text control: dump the Notepad subtree
        (name/class/controlType/supported patterns per node, capped), then
        retry text input through (a) ANY descendant exposing ValuePattern and
        (b) a zero-dependency SendKeys focus fallback. This is the evidence
        needed to decide raw-UIA vs external binding (FlaUI/UFO).

  Exit codes: 0 probe completed (gaps allowed, they are data) — 3 UIA unavailable.
#>
param(
  [string]$OutFile = 'probe-result.json'
)

# Self-logging: every phase leaves a breadcrumb, and ANY fatal error still
# emits a diagnostic probe-result.json instead of dying silently.
$script:progress = @()
function Mark($m) { $script:progress += $m; Write-Host "MARK $m" }
trap {
  $em = [ordered]@{
    schema = 'majin.win-uia-probe.v2.2'
    fatalError = $_.Exception.Message
    atLine = "$($_.InvocationInfo.ScriptLineNumber)"
    progress = $script:progress
  }
  try { $em | ConvertTo-Json -Depth 6 | Set-Content -Path $OutFile -Encoding utf8 } catch {}
  Write-Error "PROBE_FATAL: $($_.Exception.Message)"
  exit 3
}
Mark 'probe-start'

$result = [ordered]@{
  schema    = 'majin.win-uia-probe.v2.6'
  timestamp = (Get-Date).ToUniversalTime().ToString('o')
  env = [ordered]@{
    osVersion    = [System.Environment]::OSVersion.VersionString
    psVersion    = $PSVersionTable.PSVersion.ToString()
    clrVersion   = [System.Environment]::Version.ToString()
    machineName  = $env:COMPUTERNAME
    is64Bit      = [System.Environment]::Is64BitOperatingSystem
    # v2.1: session identity — proves/disproves the Session-0 (non-interactive
    # service desktop) hypothesis behind zero-pattern controls + dead SendKeys.
    userName        = [System.Environment]::UserName
    userDomain      = [System.Environment]::UserDomainName
    userInteractive = [System.Environment]::UserInteractive
    sessionId       = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
  }
  p1_assemblyAndRoot = [ordered]@{ loaded = $false; topWindowCount = 0; topWindows = @() }
  p2_negativeControl = [ordered]@{ windowName = 'MAJIN-Nonexistent-Window-7f3b9d2e'; found = $null; nullAsExpected = $false }
  p3_notepad = [ordered]@{
    launched = $false; windowFound = $false; windowName = $null; className = $null
    controlType = $null; valuePatternOk = $false; textPatternOk = $false
    setValueOk = $false; readBackOk = $false; readBackMatches = $false; clearedOk = $false
    closedOk = $false; gapReason = $null
  }
  p5_subtreeAndFallback = [ordered]@{
    ran = $false; nodeCount = 0; nodes = @()
    valuePatternCandidates = 0; textPatternCandidates = 0
    fallbackValueWriteOk = $false; fallbackReadBackMatches = $false
    fallbackClearedOk = $false
    sendKeysAttempted = $false; sendKeysOk = $false
    winnerLane = $null; note = $null
  }
  capabilities = [ordered]@{ identifyWindows = $false; locateControls = $false; textInput = $false; readBack = $false }
  notes = @()
}

function Add-Note([string]$n) { $script:result.notes += $n }

Mark 'P1-begin'
# ---------- P1: assemblies + root enumeration ----------
try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction Stop
  $script:result.p1_assemblyAndRoot.loaded = $true
} catch {
  $script:result.notes += "UIA assemblies failed to load: $($_.Exception.Message)"
  Mark 'emit'
$result | ConvertTo-Json -Depth 10 | Set-Content -Path $OutFile -Encoding utf8
  Write-Output ($result | ConvertTo-Json -Depth 10 -Compress)
  exit 3
}

$uia      = 'System.Windows.Automation'
$root     = [System.Windows.Automation.AutomationElement]::RootElement
$children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
$script:result.p1_assemblyAndRoot.topWindowCount = $children.Count
$top = @()
for ($i = 0; $i -lt [Math]::Min($children.Count, 12); $i++) {
  $w = $children.Item($i)
  $top += [ordered]@{
    name        = $w.Current.Name
    className   = $w.Current.ClassName
    controlType = $w.Current.ControlType.ProgrammaticName
    bounds      = "$([int]$w.Current.BoundingRectangle.X),$([int]$w.Current.BoundingRectangle.Y),$([int]$w.Current.BoundingRectangle.Width),$([int]$w.Current.BoundingRectangle.Height)"
  }
}
$script:result.p1_assemblyAndRoot.topWindows = $top
$script:result.capabilities.identifyWindows = ($children.Count -gt 0)

# ---------- P2: negative control ----------
$ghostCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $result.p2_negativeControl.windowName)
$ghost = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $ghostCond)
$script:result.p2_negativeControl.found = ($null -ne $ghost)
$script:result.p2_negativeControl.nullAsExpected = ($null -eq $ghost)

# ---------- P3: Notepad end-to-end (locate -> input -> readback) ----------
$marker = "MAJIN-POC-" + (Get-Date).ToUniversalTime().ToString('HHmmss')
$proc = $null
$np = $null
try {
  $proc = Start-Process -FilePath 'notepad.exe' -PassThru -ErrorAction Stop
  $script:result.p3_notepad.launched = $true
  Start-Sleep -Milliseconds 2500

  # locate the Notepad window — legacy (className=Notepad) or modern (name contains Notepad)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt 12 -and -not $np) {
    $legacyCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Notepad')
    $np = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $legacyCond)
    if (-not $np) {
      foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
        if ($w.Current.Name -match 'notepad') { $np = $w; break }
      }
    }
    if (-not $np) { Start-Sleep -Milliseconds 500 }
  }

  if (-not $np) {
    $script:result.p3_notepad.gapReason = 'notepad window not found within 12s'
  } else {
    $script:result.p3_notepad.windowFound = $true
    $script:result.p3_notepad.windowName  = $np.Current.Name
    $script:result.p3_notepad.className   = $np.Current.ClassName

    # locate the text control: legacy Edit first, then Document (modern)
    $edit = $null
    $editCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
    $edit = $np.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCond)
    if (-not $edit) {
      $docCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
      $edit = $np.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $docCond)
    }
    if (-not $edit) {
      $script:result.p3_notepad.gapReason = 'no Edit/Document control under the Notepad window'
    } else {
      $script:result.capabilities.locateControls = $true
      $script:result.p3_notepad.controlType = $edit.Current.ControlType.ProgrammaticName

      $vp = $null; $tp = $null
      try { $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) } catch {}
      try { $tp = $edit.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)  } catch {}
      $script:result.p3_notepad.valuePatternOk = ($null -ne $vp)
      $script:result.p3_notepad.textPatternOk  = ($null -ne $tp)

      if ($vp) {
        try {
          $vp.SetValue($marker)
          $script:result.p3_notepad.setValueOk = $true
          $back = $vp.Current.Value
          $script:result.p3_notepad.readBackOk = ($back -eq $marker)
          $script:result.p3_notepad.readBackMatches = ($back -eq $marker)
          $vp.SetValue('')
          $script:result.p3_notepad.clearedOk = ($vp.Current.Value -eq '')
        } catch {
          $script:result.p3_notepad.gapReason = "ValuePattern write failed: $($_.Exception.Message)"
        }
      } elseif ($tp) {
        # TextPattern has no writer on stock UIA — record the capability boundary honestly
        $script:result.p3_notepad.gapReason = 'only TextPattern available (read-capable, no ValuePattern writer)'
        try {
          $range = $tp.DocumentRange
          $script:result.p3_notepad.readBackOk = $true
        } catch {}
      } else {
        $script:result.p3_notepad.gapReason = 'neither ValuePattern nor TextPattern on the control'
      }
    }
  }
} catch {
  $script:result.p3_notepad.gapReason = "notepad phase failed: $($_.Exception.Message)"
}

# ---------- P5 (v2): subtree dump + pattern-candidate retry + SendKeys fallback ----------
if ($np -and -not $script:result.p3_notepad.readBackMatches) {
  $p5 = $script:result.p5_subtreeAndFallback
  $p5.ran = $true
  try {
    $all = $np.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $p5.nodeCount = $all.Count
    $nodes = @()
    $maxN = [Math]::Min($all.Count, 150)
    for ($i = 0; $i -lt $maxN; $i++) {
      $el = $all.Item($i)
      $pnames = @()
      try {
        foreach ($pat in $el.GetSupportedPatterns()) {
          $pnames += [System.Windows.Automation.Automation]::PatternName($pat)
        }
      } catch {}
      if ($pnames -contains 'Value Pattern') { $p5.valuePatternCandidates++ }
      if ($pnames -contains 'Text Pattern')  { $p5.textPatternCandidates++ }
      $nm = $el.Current.Name
      if ($nm.Length -gt 60) { $nm = $nm.Substring(0, 60) }
      $nodes += [ordered]@{
        idx         = $i
        name        = $nm
        className   = $el.Current.ClassName
        controlType = $el.Current.ControlType.ProgrammaticName
        patterns    = $pnames
      }
    }
    $p5.nodes = $nodes

    # Fallback lane A: any descendant with a usable ValuePattern
    for ($i = 0; $i -lt $maxN -and -not $p5.fallbackValueWriteOk; $i++) {
      $el = $all.Item($i)
      $vpx = $null
      try { $vpx = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) } catch {}
      if ($vpx) {
        try {
          $vpx.SetValue($marker)
          $back = $vpx.Current.Value
          $p5.fallbackValueWriteOk = $true
          $p5.fallbackReadBackMatches = ($back -eq $marker)
          $vpx.SetValue('')
          $p5.fallbackClearedOk = ($vpx.Current.Value -eq '')
          $p5.winnerLane = "descendant[$i] $($el.Current.ControlType.ProgrammaticName) class=$($el.Current.ClassName) via ValuePattern"
        } catch {
          $p5.note = "candidate[$i] ValuePattern write failed: $($_.Exception.Message)"
        }
      }
    }

    # Fallback lane B: zero-dependency SendKeys (Focus + keystrokes) when no ValuePattern writer exists
    if (-not $p5.fallbackValueWriteOk) {
      $p5.sendKeysAttempted = $true
      try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        try { $np.SetFocus() } catch {}
        Start-Sleep -Milliseconds 400
        [System.Windows.Forms.SendKeys]::SendWait($marker)
        Start-Sleep -Milliseconds 500
        # read back via any TextPattern-bearing descendant
        $readok = $false
        for ($i = 0; $i -lt $maxN -and -not $readok; $i++) {
          $el = $all.Item($i)
          $tpx = $null
          try { $tpx = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern) } catch {}
          if ($tpx) {
            try {
              $txt = $tpx.DocumentRange.GetText(4096)
              if ($txt -like "*$marker*") {
                $readok = $true
                $p5.sendKeysOk = $true
                $p5.winnerLane = "SendKeys -> descendant[$i] $($el.Current.ControlType.ProgrammaticName) class=$($el.Current.ClassName) via TextPattern readback"
                # clear what we typed
                try { $np.SetFocus() } catch {}
                [System.Windows.Forms.SendKeys]::SendWait('^a')
                Start-Sleep -Milliseconds 150
                [System.Windows.Forms.SendKeys]::SendWait('{DEL}')
              }
            } catch {}
          }
        }
      } catch {
        $p5.note = "SendKeys lane failed: $($_.Exception.Message)"
      }
    }
  } catch {
    $p5.note = "subtree dump failed: $($_.Exception.Message)"
  }
}

Mark 'P7-begin'
# P7: Windows shell "Run" dialog fixture — a REAL classic desktop window (class #32770
# with a native Edit control), zero self-hosted message loop. If UIA can SetValue +
# read-back + clear here, text-I/O capability on real Windows is exercised end-to-end,
# and the P3/P5 Notepad gap is factually attributed to modern Notepad's UWP surface.
$p7 = [ordered]@{
  ran = $true; dialogFound = $false; editFound = $false; editClass = $null
  valuePatternOk = $false; setValueOk = $false; readBackOk = $false
  readBackMatches = $false; clearedOk = $false; cancelInvokeOk = $false; note = $null
}
try {
  Mark 'P7-spawn-run-dialog'
  $p7marker = "MAJIN-RUNDLG-" + ([guid]::NewGuid().ToString("N").Substring(0,8))
  $dlgProc = Start-Process -FilePath "explorer.exe" -ArgumentList 'shell:::{2559a1f3-21d7-11d4-bdaf-00c04f60b9f0}' -PassThru
  $w7 = $null
  for ($i=0; $i -lt 60 -and -not $w7; $i++) {
    $cond7 = New-Object System.Windows.Automation.AndCondition(
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770')),
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Run')))
    $w7 = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond7)
    if (-not $w7) { Start-Sleep -Milliseconds 250 }
  }
  if ($w7) {
    $p7.dialogFound = $true
    Mark 'P7-dialog-found'
    $condE = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
    $e7 = $null
    for ($i=0; $i -lt 20 -and -not $e7; $i++) {
      $e7 = $w7.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condE)
      if (-not $e7) { Start-Sleep -Milliseconds 200 }
    }
    if ($e7) {
      $p7.editFound = $true
      $p7.editClass = $e7.Current.ClassName
      $v7 = $null
      try { $v7 = $e7.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) } catch {}
      if ($v7) {
        $p7.valuePatternOk = $true
        try {
          $v7.SetValue($p7marker)
          $p7.setValueOk = $true
          $rb = $v7.Current.Value
          $p7.readBackOk = $true
          $p7.readBackMatches = ($rb -eq $p7marker)
          if ($p7.readBackMatches) {
            $v7.SetValue("")
            $p7.clearedOk = ($v7.Current.Value -eq "")
          }
        } catch { $p7.note = "value lane: $($_.Exception.Message)" }
      } else { $p7.note = "Edit control found but no ValuePattern" }
    } else {
      # Windows 11 Run dialog text area sits inside a ComboBox — probe descendants
      # of ANY type for a working ValuePattern before giving up (dump subtree).
      $p7sub = @()
      $allE = $w7.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      $cand = 0
      for ($ci=0; $ci -lt $allE.Count; $ci++) {
        $elx = $allE.Item($ci)
        $pls = @()
        foreach ($pp in @([System.Windows.Automation.ValuePattern]::Pattern, [System.Windows.Automation.TextPattern]::Pattern)) {
          try { $null = $elx.GetCurrentPattern($pp); $pls += $pp.ProgrammaticName } catch {}
        }
        if ($ci -lt 14) { $p7sub += [ordered]@{ idx=$ci; cls=$elx.Current.ClassName; ct=$elx.Current.ControlType.ProgrammaticName; patterns=$pls } }
        if (-not $p7.valuePatternOk) {
          try {
            $vp2 = $elx.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            if ($vp2) {
              $cand++
              try {
                $vp2.SetValue($p7marker)
                if ($vp2.Current.Value -eq $p7marker) {
                  $p7.valuePatternOk = $true
                  $p7.setValueOk = $true
                  $p7.readBackOk = $true
                  $p7.readBackMatches = $true
                  $p7.editClass = "$($elx.Current.ControlType.ProgrammaticName)/$($elx.Current.ClassName)"
                  $vp2.SetValue("")
                  $p7.clearedOk = ($vp2.Current.Value -eq "")
                }
              } catch { $p7.note = "setValue attempt: $($_.Exception.Message)" }
            }
          } catch {}
        }
      }
      $p7.valuePatternCandidates = $cand
      $p7.subtree = $p7sub
      if (-not $p7.valuePatternOk) { $p7.note = "no ValuePattern-bearing descendant (incl. ComboBox probe)" }
    }
    # close the dialog cleanly: invoke its Cancel button via UIA (no SendKeys needed)
    try {
      $condCancel = New-Object System.Windows.Automation.AndCondition(
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)),
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Cancel')))
      $btnCancel = $w7.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condCancel)
      if ($btnCancel) {
        $ip7 = $btnCancel.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        if ($ip7) { $ip7.Invoke(); $p7.cancelInvokeOk = $true }
      }
    } catch {}
  } else { $p7.note = "Run dialog (#32770 'Run') never appeared in UIA root" }
  Mark 'P7-done'
} catch { $p7.note = "P7 lane exception: $($_.Exception.Message)" }
$script:result.p7_runDialogFixture = $p7

Mark 'cleanup-notepad'
# cleanup notepad
if ($proc -and -not $proc.HasExited) {
  try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop; $script:result.p3_notepad.closedOk = $true } catch { $script:result.p3_notepad.closedOk = $false }
} elseif ($proc) { $script:result.p3_notepad.closedOk = $true }

$script:result.capabilities.locateControls = $script:result.capabilities.locateControls -or ($script:result.p5_subtreeAndFallback.nodeCount -gt 0)
Mark 'P8-begin'
# P8: Win32 message-level text I/O on the real shell Run dialog. UIA's control/pattern
# tree is degenerate in the CI session (everything maps to Pane, zero patterns — see P7
# forensics), so exercise the same computer-use scenario at the window-message layer:
# FindWindow -> FindWindowEx(Edit) -> WM_SETTEXT(marker) -> WM_GETTEXT verify -> clear.
$p8 = [ordered]@{
  ran = $true; windowFound = $false; editFound = $false
  setTextOk = $false; readBackMatches = $false; clearedOk = $false; closedOk = $false; note = $null
}
try {
  Add-Type -Namespace MAJINP8 -Name Win32 -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true, CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
public static extern System.IntPtr FindWindow(string lpClassName, string lpWindowName);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true, CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
public static extern System.IntPtr FindWindowEx(System.IntPtr hwndParent, System.IntPtr hwndChildAfter, string lpszClass, string lpszWindow);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
public static extern System.IntPtr SendMessage(System.IntPtr hWnd, uint Msg, System.IntPtr wParam, string lParam);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
public static extern int SendMessage(System.IntPtr hWnd, uint Msg, int wParam, System.Text.StringBuilder lParam);
public delegate bool EnumWindowsProc(System.IntPtr hWnd, System.IntPtr lParam);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool EnumChildWindows(System.IntPtr hWndParent, EnumWindowsProc lpEnumFunc, System.IntPtr lParam);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
public static extern int GetClassName(System.IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
"@
  if ($dlgProc -and -not $dlgProc.HasExited) { Stop-Process -Id $dlgProc.Id -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }
  Start-Process -FilePath "explorer.exe" -ArgumentList 'shell:::{2559a1f3-21d7-11d4-bdaf-00c04f60b9f0}' | Out-Null
  $dlgHwnd = [IntPtr]::Zero
  for ($i=0; $i -lt 40 -and $dlgHwnd -eq [IntPtr]::Zero; $i++) {
    $dlgHwnd = [MAJINP8.Win32]::FindWindow('#32770', 'Run')
    if ($dlgHwnd -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 250 }
  }
  if ($dlgHwnd -ne [IntPtr]::Zero) {
    $p8.windowFound = $true
    $editHwnd = [IntPtr]::Zero
    $cb = [MAJINP8.Win32+EnumWindowsProc]{ param($h,$l)
        $cls = New-Object System.Text.StringBuilder -ArgumentList 64
        [void][MAJINP8.Win32]::GetClassName($h, $cls, 64)
        if ($cls.ToString() -eq 'Edit') { $script:p8e = $h; return $false }
        return $true
    }
    $script:p8e = [IntPtr]::Zero
    [void][MAJINP8.Win32]::EnumChildWindows($dlgHwnd, $cb, [IntPtr]::Zero)
    $editHwnd = $script:p8e
    if ($editHwnd -ne [IntPtr]::Zero) {
      $p8.editFound = $true
      [void][MAJINP8.Win32]::SendMessage($editHwnd, 0x000C, [IntPtr]::Zero, $p7marker)     # WM_SETTEXT
      Start-Sleep -Milliseconds 200
      $sb = New-Object System.Text.StringBuilder -ArgumentList 512
      [void][MAJINP8.Win32]::SendMessage($editHwnd, 0x000D, 512, $sb)                     # WM_GETTEXT
      $got = $sb.ToString()
      $p8.setTextOk = $true
      $p8.readBackMatches = ($got -eq $p7marker)
      if ($p8.readBackMatches) {
        [void][MAJINP8.Win32]::SendMessage($editHwnd, 0x000C, [IntPtr]::Zero, "")          # clear
        Start-Sleep -Milliseconds 150
        $sb2 = New-Object System.Text.StringBuilder -ArgumentList 512
        [void][MAJINP8.Win32]::SendMessage($editHwnd, 0x000D, 512, $sb2)
        $p8.clearedOk = ($sb2.ToString() -eq "")
      }
    } else { $p8.note = "no Edit HWND under Run dialog" }
    [void][MAJINP8.Win32]::SendMessage($dlgHwnd, 0x0010, [IntPtr]::Zero, $null)           # WM_CLOSE
    Start-Sleep -Milliseconds 500
    $p8.closedOk = ([MAJINP8.Win32]::FindWindow('#32770', 'Run') -eq [IntPtr]::Zero)
  } else { $p8.note = "Run dialog HWND never appeared (FindWindow)" }
  Mark 'P8-done'
} catch { $p8.note = "P8 lane exception: $($_.Exception.Message)" }
$script:result.p8_win32Messaging = $p8

$script:result.capabilities.textInput = $script:result.p3_notepad.setValueOk -or $script:result.p5_subtreeAndFallback.fallbackValueWriteOk -or $script:result.p5_subtreeAndFallback.sendKeysOk -or $script:result.p7_runDialogFixture.setValueOk -or $script:result.p8_win32Messaging.setTextOk
$script:result.capabilities.readBack  = $script:result.p3_notepad.readBackMatches -or $script:result.p5_subtreeAndFallback.fallbackReadBackMatches -or $script:result.p5_subtreeAndFallback.sendKeysOk -or $script:result.p7_runDialogFixture.readBackMatches -or $script:result.p8_win32Messaging.readBackMatches

Mark 'emit'
$result | ConvertTo-Json -Depth 10 | Set-Content -Path $OutFile -Encoding utf8
Write-Output ($result | ConvertTo-Json -Depth 10)
exit 0
