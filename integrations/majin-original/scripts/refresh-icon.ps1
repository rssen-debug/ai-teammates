# MAJIN icon generator: the branded 512px PNG is the single source of truth.
# Compiles multi-resolution Windows ICO bytes for EXE, installer and shortcuts.
# Does not alter any user's installed application, desktop or icon cache.
param(
  [string]$Source = '',
  [string]$Destination = '',
  [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Source) { $Source = Join-Path $root 'assets\majin.png' }
if (-not $Destination) { $Destination = Join-Path $root 'dist\assets\majin.ico' }
$Source = [IO.Path]::GetFullPath($Source)
$Destination = [IO.Path]::GetFullPath($Destination)
Add-Type -AssemblyName System.Drawing
$sizes = @(16, 24, 32, 48, 64, 128, 256)

function Assert-BrandPixels([string]$IcoPath) {
  if (-not (Test-Path -LiteralPath $IcoPath)) { throw 'ICON_CHECK: generated icon missing' }
  $bytes = [IO.File]::ReadAllBytes($IcoPath)
  if ($bytes.Length -lt 500 -or [BitConverter]::ToUInt16($bytes,0) -ne 0 -or
      [BitConverter]::ToUInt16($bytes,2) -ne 1 -or
      [BitConverter]::ToUInt16($bytes,4) -ne $sizes.Count) {
    throw 'ICON_CHECK: invalid ICO header or size count'
  }
  # Every entry must contain a real sized PNG, not the stale white icon.
  foreach ($i in 0..($sizes.Count - 1)) {
    $pos = 6 + $i * 16
    $w = [int]$bytes[$pos]; if ($w -eq 0) { $w = 256 }
    if ($w -ne $sizes[$i]) { throw "ICON_CHECK: missing $($sizes[$i])px frame" }
    $n = [BitConverter]::ToUInt32($bytes, $pos+8)
    $off = [BitConverter]::ToUInt32($bytes, $pos+12)
    if ($n -lt 90 -or $off -lt 6+16*$sizes.Count -or $off+$n -gt $bytes.Length) { throw 'ICON_CHECK: invalid icon image offset' }
    $magic = [byte[]](137,80,78,71,13,10,26,10)
    for($j=0; $j -lt 8; $j++) {
      if ($bytes[[int]$off+$j] -ne $magic[$j]) { throw "ICON_CHECK: $w frame is not PNG" }
    }
  }
  # .NET Icon.ToBitmap() rejects some valid PNG-compressed ICO containers.
  # Windows Explorer and resedit consume them, but validate the source PNG
  # frame directly here: PNG bytes, dimensions and brand pixel are definitive.
  $framePos = 6 + ($sizes.Count - 1) * 16
  $frameSize = [int][BitConverter]::ToUInt32($bytes, $framePos + 8)
  $frameOffset = [int][BitConverter]::ToUInt32($bytes, $framePos + 12)
  $imageBytes = New-Object byte[] $frameSize
  [Array]::Copy($bytes, $frameOffset, $imageBytes, 0, $frameSize)
  $memory = [IO.MemoryStream]::new([byte[]]$imageBytes)
  try {
    $bmp = [System.Drawing.Bitmap]::new($memory)
    try {
      if ($bmp.Width -ne 256 -or $bmp.Height -ne 256) { throw 'ICON_CHECK: 256 frame has wrong PNG dimensions' }
      # x=12%, y=50% is the opaque pink background, outside the M glyph.
      $color = $bmp.GetPixel([int]($bmp.Width*.12), [int]($bmp.Height*.5))
      if ($color.R -lt 155 -or $color.R -le $color.G * 1.4 -or $color.B -lt 40) {
        throw "ICON_CHECK: icon has no pink MAJIN brand pixel (R=$($color.R),G=$($color.G),B=$($color.B))"
      }
    } finally { $bmp.Dispose() }
  } finally { $memory.Dispose() }
  Write-Host "ICON_VERIFIED: $($sizes.Count) PNG frames, pink MAJIN artwork, $($bytes.Length) bytes"
}

if ($VerifyOnly) {
  Assert-BrandPixels $Destination
  exit 0
}
if (-not (Test-Path -LiteralPath $Source)) { throw "MAJIN PNG not found: $Source" }
$src = [System.Drawing.Image]::FromFile($Source)
try {
  if ($src.Width -lt 256 -or $src.Height -lt 256) { throw 'MAJIN brand PNG must be at least 256px' }
  $frames = [System.Collections.Generic.List[byte[]]]::new()
  foreach($size in $sizes) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $stream = [IO.MemoryStream]::new()
    try {
      $graphics.Clear([System.Drawing.Color]::Transparent)
      $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.DrawImage($src, ([System.Drawing.Rectangle]::new(0,0,$size,$size)))
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      $frames.Add($stream.ToArray())
    } finally { $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
  }
} finally { $src.Dispose() }

$dir = [IO.Path]::GetDirectoryName($Destination)
[IO.Directory]::CreateDirectory($dir) | Out-Null
$tmp = $Destination + '.tmp'
try {
  $out = [IO.File]::Open($tmp, [IO.FileMode]::Create, [IO.FileAccess]::Write)
  $writer = [IO.BinaryWriter]::new($out)
  try {
    $writer.Write([UInt16]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($i=0; $i -lt $sizes.Count; $i++) {
      $size = $sizes[$i]
      $writer.Write([byte]$(if ($size -eq 256) {0} else {$size}))
      $writer.Write([byte]$(if ($size -eq 256) {0} else {$size}))
      $writer.Write([byte]0); $writer.Write([byte]0)
      $writer.Write([UInt16]1); $writer.Write([UInt16]32)
      $writer.Write([UInt32]$frames[$i].Length)
      $writer.Write([UInt32]$offset)
      $offset += $frames[$i].Length
    }
    foreach($frame in $frames) { $writer.Write([byte[]]$frame) }
  } finally { $writer.Dispose() }
  Assert-BrandPixels $tmp
  Move-Item -LiteralPath $tmp -Destination $Destination -Force
} finally { if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force } }
Write-Host "MAJIN_ICON_READY: $Destination"
