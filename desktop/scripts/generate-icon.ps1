param(
  [string]$OutputPath = (Join-Path $PSScriptRoot "..\build\icon.png")
)

Add-Type -AssemblyName System.Drawing

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($resolvedOutput)) | Out-Null

$bitmap = New-Object System.Drawing.Bitmap 512, 512
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$graphics.Clear([System.Drawing.Color]::FromArgb(34, 39, 34))

$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$radius = 74
$size = 428
$offset = 42
$diameter = $radius * 2
$path.AddArc($offset, $offset, $diameter, $diameter, 180, 90)
$path.AddArc($offset + $size - $diameter, $offset, $diameter, $diameter, 270, 90)
$path.AddArc($offset + $size - $diameter, $offset + $size - $diameter, $diameter, $diameter, 0, 90)
$path.AddArc($offset, $offset + $size - $diameter, $diameter, $diameter, 90, 90)
$path.CloseFigure()

$fill = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(57, 67, 56))
$border = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(113, 128, 111)), 9
$graphics.FillPath($fill, $path)
$graphics.DrawPath($border, $path)

$font = New-Object System.Drawing.Font "Segoe UI", 250, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$textBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(247, 250, 245))
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
$graphics.DrawString("R", $font, $textBrush, (New-Object System.Drawing.RectangleF 0, -5, 512, 512), $format)

$bitmap.Save($resolvedOutput, [System.Drawing.Imaging.ImageFormat]::Png)

$format.Dispose()
$textBrush.Dispose()
$font.Dispose()
$border.Dispose()
$fill.Dispose()
$path.Dispose()
$graphics.Dispose()
$bitmap.Dispose()
