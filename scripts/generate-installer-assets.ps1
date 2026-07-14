param(
  [string]$SourcePng = (Join-Path $PSScriptRoot "..\public\life-planner-logo.png"),
  [string]$OutputDir = (Join-Path $PSScriptRoot "..\installer\assets")
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

function New-SquareBitmap {
  param(
    [System.Drawing.Image]$Image,
    [int]$Size
  )

  $bitmap = New-Object System.Drawing.Bitmap $Size, $Size
  $bitmap.SetResolution(96, 96)

  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

    $scale = [Math]::Min($Size / $Image.Width, $Size / $Image.Height)
    $drawWidth = [int][Math]::Round($Image.Width * $scale)
    $drawHeight = [int][Math]::Round($Image.Height * $scale)
    $offsetX = [int][Math]::Floor(($Size - $drawWidth) / 2)
    $offsetY = [int][Math]::Floor(($Size - $drawHeight) / 2)

    $graphics.DrawImage($Image, $offsetX, $offsetY, $drawWidth, $drawHeight)
  }
  finally {
    $graphics.Dispose()
  }

  return $bitmap
}

function ConvertTo-Icon {
  param(
    [System.Drawing.Bitmap]$Bitmap,
    [string]$OutputPath
  )

  $pngStream = New-Object System.IO.MemoryStream
  $writer = $null
  try {
    $Bitmap.Save($pngStream, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBytes = $pngStream.ToArray()
    $writer = New-Object System.IO.BinaryWriter([System.IO.File]::Open($OutputPath, [System.IO.FileMode]::Create))

    $writer.Write([UInt16]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]1)
    $writer.Write([byte]($(if ($Bitmap.Width -ge 256) { 0 } else { $Bitmap.Width })))
    $writer.Write([byte]($(if ($Bitmap.Height -ge 256) { 0 } else { $Bitmap.Height })))
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]32)
    $writer.Write([UInt32]$pngBytes.Length)
    $writer.Write([UInt32]22)
    $writer.Write($pngBytes)
  }
  finally {
    if ($writer) { $writer.Dispose() }
    $pngStream.Dispose()
  }
}

if (!(Test-Path -LiteralPath $SourcePng)) {
  throw "Source logo not found: $SourcePng"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$logoImage = [System.Drawing.Image]::FromFile($SourcePng)
try {
  $installerIcon = New-SquareBitmap -Image $logoImage -Size 256
  $shortcutIcon = New-SquareBitmap -Image $logoImage -Size 64
  $wizardBitmap = New-SquareBitmap -Image $logoImage -Size 55

  try {
    ConvertTo-Icon -Bitmap $installerIcon -OutputPath (Join-Path $OutputDir "life-planner-setup.ico")
    ConvertTo-Icon -Bitmap $shortcutIcon -OutputPath (Join-Path $OutputDir "life-planner-app.ico")
    $wizardBitmap.Save((Join-Path $OutputDir "life-planner-wizard-small.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
  }
  finally {
    $installerIcon.Dispose()
    $shortcutIcon.Dispose()
    $wizardBitmap.Dispose()
  }
}
finally {
  $logoImage.Dispose()
}
