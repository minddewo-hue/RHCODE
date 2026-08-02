param(
  [string]$SourcePath = (Join-Path $PSScriptRoot "..\assets\app-icon.png")
)

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$source = [System.IO.Path]::GetFullPath($SourcePath)
$resizer = Join-Path $repoRoot "desktop\scripts\generate-icon.ps1"
$androidRes = Join-Path $repoRoot "mobile\android\app\src\main\res"

if (-not [System.IO.File]::Exists($source)) {
  throw "Icon source is missing: $source"
}

& $resizer -SourcePath $source -OutputPath (Join-Path $repoRoot "desktop\build\icon.png") -Size 512
& $resizer -SourcePath $source -OutputPath (Join-Path $repoRoot "mobile\assets\icon.png") -Size 1024 -BackgroundColor "#2F3241"
& $resizer -SourcePath $source -OutputPath (Join-Path $repoRoot "mobile\assets\adaptive-icon.png") -Size 1024

$densities = @(
  @{ Name = "mdpi"; Launcher = 48; Foreground = 108 },
  @{ Name = "hdpi"; Launcher = 72; Foreground = 162 },
  @{ Name = "xhdpi"; Launcher = 96; Foreground = 216 },
  @{ Name = "xxhdpi"; Launcher = 144; Foreground = 324 },
  @{ Name = "xxxhdpi"; Launcher = 192; Foreground = 432 }
)

foreach ($density in $densities) {
  $directory = Join-Path $androidRes "mipmap-$($density.Name)"
  foreach ($name in "ic_launcher", "ic_launcher_foreground", "ic_launcher_round") {
    $legacyWebp = Join-Path $directory "$name.webp"
    if ([System.IO.File]::Exists($legacyWebp)) {
      Remove-Item -LiteralPath $legacyWebp
    }
  }

  & $resizer -SourcePath $source -OutputPath (Join-Path $directory "ic_launcher.png") -Size $density.Launcher
  & $resizer -SourcePath $source -OutputPath (Join-Path $directory "ic_launcher_round.png") -Size $density.Launcher
  & $resizer -SourcePath $source -OutputPath (Join-Path $directory "ic_launcher_foreground.png") -Size $density.Foreground
}

Write-Output "Generated desktop, Expo, and Android icons from $source"
