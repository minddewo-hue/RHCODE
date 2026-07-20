$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

if (-not (Test-Path -LiteralPath ".proxy.pid")) {
  Write-Host "No .proxy.pid file found."
  exit 0
}

$pidValue = (Get-Content -LiteralPath ".proxy.pid" -Raw).Trim()
if (-not $pidValue) {
  Remove-Item -LiteralPath ".proxy.pid" -ErrorAction SilentlyContinue
  Write-Host "Empty .proxy.pid removed."
  exit 0
}

$process = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
if ($process) {
  Stop-Process -Id $process.Id
  Write-Host "Stopped proxy pid $($process.Id)."
} else {
  Write-Host "Proxy pid $pidValue is not running."
}

Remove-Item -LiteralPath ".proxy.pid" -ErrorAction SilentlyContinue
