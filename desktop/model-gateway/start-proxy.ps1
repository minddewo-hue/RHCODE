$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktopRoot = Split-Path -Parent $root
$envPath = Join-Path $desktopRoot ".env"
Set-Location -LiteralPath $root

$envMap = @{}
if (Test-Path -LiteralPath $envPath) {
  Get-Content -LiteralPath $envPath | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { return }
    $idx = $line.IndexOf("=")
    $key = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
    $envMap[$key] = $value
  }
}

$hostName = if ($env:HOST) {
  $env:HOST
} elseif ($envMap.ContainsKey("HOST") -and $envMap.HOST) {
  $envMap.HOST
} else {
  "127.0.0.1"
}
$port = if ($env:PORT) {
  [int]$env:PORT
} elseif ($envMap.ContainsKey("PORT") -and $envMap.PORT) {
  [int]$envMap.PORT
} else {
  8787
}

$existing = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
  Where-Object { $_.State -eq "Listen" } |
  Select-Object -First 1

if ($existing) {
  $existing.OwningProcess | Set-Content -LiteralPath ".proxy.pid"
  Write-Host "Proxy already listening: http://$hostName`:$port/v1 (pid $($existing.OwningProcess))"
  exit 0
}

Remove-Item -LiteralPath "proxy.out.log", "proxy.err.log" -ErrorAction SilentlyContinue

$process = Start-Process `
  -FilePath "node" `
  -ArgumentList "server.js" `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput "proxy.out.log" `
  -RedirectStandardError "proxy.err.log" `
  -PassThru

$process.Id | Set-Content -LiteralPath ".proxy.pid"
Start-Sleep -Seconds 2

if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
  if (Test-Path -LiteralPath "proxy.err.log") {
    Get-Content -LiteralPath "proxy.err.log" -Tail 50
  }
  throw "Proxy failed to start. See proxy.err.log."
}

Write-Host "Proxy listening: http://$hostName`:$port/v1 (pid $($process.Id))"
