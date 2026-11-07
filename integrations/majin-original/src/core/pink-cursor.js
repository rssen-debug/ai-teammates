/**
 * MAJIN PINK CURSOR overlay — a REAL, visible, always-on-top pink pointer
 * on the Windows desktop, driven by state-file commands (no sockets, no
 * external deps — WinForms + timer).
 *
 * Honesty rules:
 *  - Windows only. Non-Windows → FORBIDDEN error, never a pretend-cursor.
 *  - The overlay moves only when a real action writes move commands.
 *  - The overlay never clicks anything itself; input stays in control.* lane.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const VERSION = 'majin-pinkcursor/1';
export const NOT_WINDOWS = { ok: false, error: { code: 'FORBIDDEN', message: 'the pink cursor overlay needs a real Windows desktop session — not a Linux/headless host, not Session-0, not SSH' } };

export function isWindowsDesktop() {
  return process.platform === 'win32' && process.env.SESSIONNAME !== 'Services';
}

const OVERLAY_PS1 = String.raw`
# MAJIN pink cursor overlay (WinForms) — spawned by src/core/pink-cursor.js
param([string]$StateFile)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
# A topmost visual helper must NEVER capture user clicks or keyboard focus.
# WinForms opacity/backdrop by itself DOES NOT make a window click-through.
# Give the overlay a native transparent+no-activate extended style.
$overlayType = @'
using System;
using System.Windows.Forms;
public sealed class MajinVisualOverlay : Form {
  protected override CreateParams CreateParams {
    get {
      CreateParams cp = base.CreateParams;
      cp.ExStyle |= 0x00000020 | 0x08000000 | 0x00000080;
      return cp;
    }
  }
}
'@
Add-Type -TypeDefinition $overlayType -ReferencedAssemblies System.Windows.Forms,System.Drawing
$form = New-Object MajinVisualOverlay
$form.FormBorderStyle = 'None'; $form.ShowInTaskbar = $false; $form.TopMost = $true
# On a real interactive runner the layered TransparencyKey form can be
# completely absent from CopyFromScreen even while its process keeps running.
# Use a small, semi-opaque dark backing; the hot-pink circle remains visible.
$form.BackColor = [System.Drawing.Color]::FromArgb(30,12,45)
$form.Opacity = 0.94
$form.Width = 180; $form.Height = 46
# Clipped pill avoids the ugly large rectangular debug window.
$rounded = [System.Drawing.Drawing2D.GraphicsPath]::new()
$rounded.AddArc(0,0,24,24,180,90)
$rounded.AddArc(156,0,24,24,270,90)
$rounded.AddArc(156,22,24,24,0,90)
$rounded.AddArc(0,22,24,24,90,90)
$rounded.CloseFigure()
$form.Region = [System.Drawing.Region]::new($rounded)
$form.Location = [System.Drawing.Point]::new(100,100)
$circle = New-Object System.Windows.Forms.Panel
$circle.Width = 30; $circle.Height = 30; $circle.Location = [System.Drawing.Point]::new(2,9)
$circle.BackColor = [System.Drawing.Color]::FromArgb(30,12,45)
$circle.Add_Paint({
  param($s,$e)
  $g = $e.Graphics; $g.SmoothingMode = 'AntiAlias'
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(235, 255, 60, 165)); $g.FillEllipse($brush, 2,2,24,24)
  $glowPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(90, 255, 150, 205), 5)
  $g.DrawEllipse($glowPen, 0,0,26,26)
})
$lbl = New-Object System.Windows.Forms.Label
$lbl.AutoSize = $false; $lbl.Width = 132; $lbl.Height = 34; $lbl.Location = New-Object System.Drawing.Point(38,6)
$lbl.ForeColor = [System.Drawing.Color]::White; $lbl.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
$lbl.BackColor = [System.Drawing.Color]::FromArgb(30, 12, 45)
$lbl.Text = 'MAJIN'
$form.Controls.Add($circle); $form.Controls.Add($lbl)
$timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 60
$script:target = $null
$timer.Add_Tick({
  if (Test-Path $StateFile) {
    try { $cmd = Get-Content $StateFile -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json } catch { $cmd = $null }
    if ($cmd -ne $null -and $cmd.op -eq 'quit') { $form.Close(); return }
    if ($cmd -ne $null -and $cmd.op -eq 'hide') { $form.Hide(); return }
    if ($cmd -ne $null -and $cmd.op -eq 'show') { $form.Show() }
    if ($cmd -ne $null -and $cmd.op -eq 'move') {
      $form.Show()
      $script:target = @([int]$cmd.x, [int]$cmd.y)
      if ($cmd.label) { $lbl.Text = [string]$cmd.label }
    }
  }
  if ($script:target) {
    $dx = ($script:target[0] - $form.Location.X) / 4; $dy = ($script:target[1] - $form.Location.Y) / 4
    if ([math]::Abs($dx) -lt 1 -and [math]::Abs($dy) -lt 1) { $script:target = $null }
    else { $form.Location = [System.Drawing.Point]::new([int]($form.Location.X + [int]$dx), [int]($form.Location.Y + [int]$dy)) }
  }
})
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
`;

let overlayProc = null;
export function overlayStatus() {
  return {
    pid: overlayProc?.pid || null,
    alive: Boolean(overlayProc && overlayProc.exitCode == null && !overlayProc.killed),
    exitCode: overlayProc?.exitCode ?? null,
  };
}


export function cursorPaths(workspaceDir) {
  const dir = path.join(workspaceDir, 'cursor');
  return { dir, ps1: path.join(dir, 'pink-cursor.ps1'), state: path.join(dir, 'state.json') };
}

export function ensureOverlayFiles(workspaceDir) {
  const p = cursorPaths(workspaceDir);
  fs.mkdirSync(p.dir, { recursive: true });
  const tmp = p.ps1 + '.tmp';
  // Include a UTF-8 BOM: Windows PowerShell 5.1 otherwise parses UTF-8 source
  // as ANSI and can corrupt characters in labels and diagnostic text.
  fs.writeFileSync(tmp, '\uFEFF' + OVERLAY_PS1);
  fs.renameSync(tmp, p.ps1);
  return p;
}

export function ensureOverlayRunning(workspaceDir) {
  if (!isWindowsDesktop()) return { started: false, reason: 'not-windows-desktop' };
  if (overlayProc && overlayProc.exitCode == null) return { started: false, reason: 'already-running' };
  const p = ensureOverlayFiles(workspaceDir);
  overlayProc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', p.ps1, '-StateFile', p.state], {
    // A detached Windows child exited immediately (code 0) on the REAL
    // interactive runner, while a normal PowerShell WinForms child stayed
    // alive. Unref the handle without DETACHED_PROCESS so the overlay can run.
    stdio: 'ignore', detached: false, windowsHide: true,
  });
  overlayProc.unref();
  return { started: true, pid: overlayProc.pid };
}

export async function cursor(workspaceDir, op) {
  if (!isWindowsDesktop()) return NOT_WINDOWS;
  const p = ensureOverlayFiles(workspaceDir);
  ensureOverlayRunning(workspaceDir);
  fs.writeFileSync(p.state + '.tmp', JSON.stringify(op));
  fs.renameSync(p.state + '.tmp', p.state);
  return { ok: true, op: op.op, note: 'overlay command persisted — the visible cursor follows it within ~60ms if the desktop session honors layered windows' };
}
