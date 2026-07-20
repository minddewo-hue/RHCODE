param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CodexArgs
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$codexHome = Join-Path $root ".codex-test"
$configPath = Join-Path $codexHome "config.toml"
$catalogPath = Join-Path $root "codex-model-catalog.json"
$previousCodexHome = $env:CODEX_HOME
$codexExitCode = 0

if (-not (Test-Path -LiteralPath $configPath)) {
  throw "Isolated Codex config is missing: $configPath"
}

Push-Location -LiteralPath $root
try {
  & npm run catalog
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to generate the Codex model catalog."
  }
  if (-not (Test-Path -LiteralPath $catalogPath)) {
    throw "Codex model catalog was not generated: $catalogPath"
  }

  & .\start-proxy.ps1
  $health = $null
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:8787/health" -TimeoutSec 2
      if ($health.ok) { break }
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  if (-not $health.ok) {
    throw "The test gateway did not become healthy on http://127.0.0.1:8787."
  }

  $env:CODEX_HOME = $codexHome
  Write-Host "Using isolated CODEX_HOME: $codexHome"
  Write-Host "Gateway: http://127.0.0.1:8787/v1 ($($health.models) models)"
  & codex @CodexArgs
  $codexExitCode = $LASTEXITCODE
} finally {
  if ($null -eq $previousCodexHome) {
    Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue
  } else {
    $env:CODEX_HOME = $previousCodexHome
  }
  Pop-Location
}

if ($codexExitCode -ne 0) {
  throw "Codex exited with code $codexExitCode."
}
