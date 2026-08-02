param(
  [string]$SourcePath = (Join-Path $PSScriptRoot "..\..\assets\app-icon.png"),
  [string]$OutputPath = (Join-Path $PSScriptRoot "..\build\icon.png"),
  [ValidateRange(16, 2048)]
  [int]$Size = 512,
  [string]$BackgroundColor = ""
)

Add-Type -AssemblyName System.Drawing

$resolvedSource = [System.IO.Path]::GetFullPath($SourcePath)
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
if (-not [System.IO.File]::Exists($resolvedSource)) {
  throw "Icon source is missing: $resolvedSource"
}

[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($resolvedOutput)) | Out-Null

$source = [System.Drawing.Image]::FromFile($resolvedSource)
$bitmap = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality

if ($BackgroundColor) {
  $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml($BackgroundColor))
} else {
  $graphics.Clear([System.Drawing.Color]::Transparent)
}
$graphics.DrawImage($source, (New-Object System.Drawing.Rectangle 0, 0, $Size, $Size))
$bitmap.Save($resolvedOutput, [System.Drawing.Imaging.ImageFormat]::Png)

$graphics.Dispose()
$bitmap.Dispose()
$source.Dispose()
