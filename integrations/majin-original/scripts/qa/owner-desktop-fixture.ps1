[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Title,
  [Parameter(Mandatory=$true)][string]$OutFile
)
# Disposable test-only window. It never reads, writes or targets user files.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.Width=390
$form.Height=170
$form.ShowInTaskbar=$false
# Controlled synthetic pink background: proves CopyFromScreen can observe
# a real test window (no private desktop screenshot is retained).
$form.BackColor=[System.Drawing.Color]::FromArgb(255,60,165)
$form.TopMost=$true
$form.StartPosition='Manual'
$form.Location = New-Object System.Drawing.Point(24,24)
$edit = New-Object System.Windows.Forms.TextBox
$edit.Name='MAJIN_QA_Edit'
$edit.Width=325
$edit.Location = New-Object System.Drawing.Point(18,20)
$button = New-Object System.Windows.Forms.Button
$button.Text='Save QA'
$button.Width=110
$button.Location = New-Object System.Drawing.Point(18,64)
$button.Add_Click({
  # OutFile points exclusively into the runner's newly created temp test dir.
  [System.IO.File]::WriteAllText($OutFile,$edit.Text,[System.Text.UTF8Encoding]::new($false))
})
$form.Controls.Add($edit)
$form.Controls.Add($button)
[System.Windows.Forms.Application]::Run($form)
